// DevPanel v2 — key/value app settings (non-secret config). A setting overrides
// the matching .env default at runtime. Sensitive values (smtp_pass, …) are
// redacted by publicSettings() and never returned raw over the API.
import { db } from "./db.js";

const SENSITIVE = /pass|secret|token/i;

export function getSetting(key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

// Safe view for the API: sensitive keys collapse to "" (unset) or "••••••" (set).
export function publicSettings(): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = SENSITIVE.test(r.key) ? (r.value ? "••••••" : "") : r.value;
  return out;
}

// ---- resolved config (setting overrides env; sane localhost defaults) -------
export const OLLAMA_URL = () =>
  (getSetting("ollama_url") || process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
export const OLLAMA_MODEL = () => getSetting("ollama_model") || process.env.OLLAMA_MODEL || "qwen2.5:7b";
export const AI_AUTO = () => getSetting("ai_auto") === "on";
