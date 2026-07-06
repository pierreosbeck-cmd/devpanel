// DevPanel — step 2: crypto (argon2id KDF + AES-256-GCM) and secrets CRUD.
//
// Secret VALUES are encrypted at rest with AES-256-GCM. The 32-byte key is
// derived from the master password via argon2id. AI/MCP never sees values —
// only {name, scope, age_days}. Decryption requires an unlocked session key.
import argon2 from "argon2";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { db, logActivity } from "./db.js";

const KDF = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

// ---- meta helpers -----------------------------------------------------------
function getMeta(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}
function setMeta(key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function isInitialized(): boolean {
  return getMeta("kdf_salt") !== undefined && getMeta("verifier") !== undefined;
}

// ---- master password lifecycle ---------------------------------------------

// First-time setup: pin a KDF salt + store an argon2id verifier of the password.
export async function setMasterPassword(password: string): Promise<void> {
  if (isInitialized()) throw new Error("master password already set");
  const salt = randomBytes(16);
  setMeta("kdf_salt", salt.toString("hex"));
  const verifier = await argon2.hash(password, { ...KDF });
  setMeta("verifier", verifier);
}

// Derive the raw 32-byte encryption key from the password + stored salt.
async function deriveKey(password: string): Promise<Buffer> {
  const saltHex = getMeta("kdf_salt");
  if (!saltHex) throw new Error("crypto not initialized");
  const salt = Buffer.from(saltHex, "hex");
  return argon2.hash(password, { ...KDF, salt, raw: true });
}

// Verify the master password and return a session key (hold in memory only).
export async function unlock(password: string): Promise<Buffer> {
  const verifier = getMeta("verifier");
  if (!verifier) throw new Error("crypto not initialized");
  const ok = await argon2.verify(verifier, password);
  if (!ok) throw new Error("invalid master password");
  return deriveKey(password);
}

// ---- AES-256-GCM ------------------------------------------------------------
// Blob layout: [12B iv][16B authTag][ciphertext]
function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}
function decrypt(key: Buffer, blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// ---- secrets CRUD -----------------------------------------------------------
export type SecretMeta = { id: number; name: string; scope: string; age_days: number };

function ageDays(rotatedAt: string): number {
  const then = new Date(rotatedAt + "Z").getTime();
  return Math.floor((Date.now() - then) / 86_400_000);
}

// SAFE for AI/MCP/API-without-session: metadata only, never values.
export function listSecretsMeta(projectId?: number): SecretMeta[] {
  const rows = (
    projectId
      ? db.prepare("SELECT id, name, scope, rotated_at FROM secrets WHERE project_id = ? ORDER BY name").all(projectId)
      : db.prepare("SELECT id, name, scope, rotated_at FROM secrets ORDER BY name").all()
  ) as { id: number; name: string; scope: string; rotated_at: string }[];
  return rows.map((r) => ({ id: r.id, name: r.name, scope: r.scope, age_days: ageDays(r.rotated_at) }));
}

// Requires an unlocked session key. Upserts by (project_id, name, scope).
export function putSecret(
  key: Buffer,
  projectId: number,
  name: string,
  value: string,
  scope: "dev" | "prod" = "dev",
): void {
  const blob = encrypt(key, value);
  db.prepare(
    `INSERT INTO secrets (project_id, name, value_enc, scope, rotated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(project_id, name, scope)
     DO UPDATE SET value_enc = excluded.value_enc, rotated_at = datetime('now')`,
  ).run(projectId, name, blob, scope);
  logActivity("api", `put_secret ${name}/${scope}`);
}

// Requires an unlocked session key. Returns the decrypted value.
export function revealSecret(key: Buffer, id: number): string {
  const row = db.prepare("SELECT name, scope, value_enc FROM secrets WHERE id = ?").get(id) as
    | { name: string; scope: string; value_enc: Buffer }
    | undefined;
  if (!row) throw new Error("secret not found");
  logActivity("api", `reveal_secret ${row.name}/${row.scope}`);
  return decrypt(key, row.value_enc);
}

export function deleteSecret(id: number): void {
  db.prepare("DELETE FROM secrets WHERE id = ?").run(id);
  logActivity("api", `delete_secret #${id}`);
}
