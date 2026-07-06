// DevPanel — step 5: Hono REST API. A localhost-only mirror of the MCP tools
// plus the secrets endpoints the MCP deliberately lacks, and it also serves the
// built web UI from web/dist.
//
// Non-negotiables enforced here:
//  - Binds 127.0.0.1 only (remote strictly via Cloudflare Access / SSH tunnel).
//  - Secret VALUES never leave without an unlocked session; unlock lasts 5 min.
//  - Every mutating call is written to activity_log under agent "api".
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";
import { db } from "./db.js";
import * as store from "./store.js";
import * as files from "./files.js";
import * as ai from "./ai.js";
import * as settings from "./settings.js";
import * as reminders from "./reminders.js";
import { sendMail, smtpConfigured } from "./mail.js";
import {
  isInitialized,
  setMasterPassword,
  unlock,
  listSecretsMeta,
  putSecret,
  revealSecret,
  deleteSecret,
} from "./crypto.js";

const AGENT = "api";
const PORT = Number(process.env.PANEL_PORT ?? 8899);
const BIND = process.env.PANEL_BIND ?? "127.0.0.1";
const WEB_DIST = "./web/dist";

// ---- secret sessions --------------------------------------------------------
// The derived AES key is held in memory only, keyed by an opaque bearer token,
// and expires 5 minutes after unlock. Never persisted, never returned.
const SESSION_MS = 5 * 60 * 1000;
type Session = { key: Buffer; expiresAt: number };
const sessions = new Map<string, Session>();

function sweepSessions(): void {
  const now = Date.now();
  for (const [tok, s] of sessions) if (s.expiresAt <= now) sessions.delete(tok);
}
function openSession(key: Buffer): { token: string; expires_at: string } {
  sweepSessions();
  const token = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + SESSION_MS;
  sessions.set(token, { key, expiresAt });
  return { token, expires_at: new Date(expiresAt).toISOString() };
}
// Require a live session; return its key or throw 401.
function requireKey(c: { req: { header: (n: string) => string | undefined } }): Buffer {
  sweepSessions();
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const s = token ? sessions.get(token) : undefined;
  if (!s) throw new HTTPException(401, { message: "no unlocked session" });
  return s.key;
}

// ---- app --------------------------------------------------------------------
const app = new Hono();

// Uncaught errors → JSON. Store/validation throws map to 400; HTTPException kept.
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof z.ZodError) return c.json({ error: "invalid input", issues: err.issues }, 400);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
});

app.get("/api/health", (c) => c.json({ ok: true, initialized: isInitialized() }));

// ---- MCP mirror: context ----------------------------------------------------
app.get("/api/context", (c) => c.text(store.buildContext()));

// ---- MCP mirror: planning writes -------------------------------------------
const zPrio = z.enum(["P0", "P1", "P2", "P3"]);

app.post("/api/tasks", async (c) => {
  const b = z
    .object({
      project: z.string(),
      title: z.string(),
      prio: zPrio,
      effort: z.enum(["S", "M", "L"]).optional(),
      milestone: z.string().optional(),
    })
    .parse(await c.req.json());
  // API-created tasks are manual by default; pass source=ai to attribute to AI.
  const id = store.createTask(AGENT, b);
  return c.json({ id }, 201);
});

app.patch("/api/tasks/:id", async (c) => {
  const b = z
    .object({ status: z.enum(["todo", "doing", "done", "blocked"]).optional(), prio: zPrio.optional() })
    .parse(await c.req.json());
  store.updateTask(AGENT, { id: Number(c.req.param("id")), ...b });
  return c.json({ ok: true });
});

app.post("/api/deps", async (c) => {
  const b = z.object({ task_id: z.number().int(), blocks_task_id: z.number().int() }).parse(await c.req.json());
  store.addDep(AGENT, b.task_id, b.blocks_task_id);
  return c.json({ ok: true }, 201);
});

app.post("/api/ideas", async (c) => {
  const b = z.object({ title: z.string(), note: z.string().optional() }).parse(await c.req.json());
  const id = store.addIdea(AGENT, b.title, b.note);
  return c.json({ id }, 201);
});

app.post("/api/decisions", async (c) => {
  const b = z
    .object({
      project: z.string(),
      title: z.string(),
      body: z.string(),
      status: z.enum(["proposed", "accepted", "superseded"]),
    })
    .parse(await c.req.json());
  const id = store.addDecision(AGENT, b);
  return c.json({ id }, 201);
});

// ---- MCP mirror: ops --------------------------------------------------------
app.post("/api/incidents", async (c) => {
  const b = z
    .object({ service: z.string(), severity: z.enum(["low", "high", "critical"]), title: z.string() })
    .parse(await c.req.json());
  const id = store.reportIncident(AGENT, b);
  return c.json({ id }, 201);
});

app.post("/api/incidents/:id/resolve", async (c) => {
  const b = z.object({ postmortem: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
  store.resolveIncident(AGENT, Number(c.req.param("id")), b.postmortem);
  return c.json({ ok: true });
});

app.post("/api/deploys", async (c) => {
  const b = z
    .object({
      project: z.string(),
      sha: z.string(),
      env: z.enum(["staging", "prod"]),
      status: z.enum(["ok", "fail"]),
    })
    .parse(await c.req.json());
  const id = store.logDeploy(AGENT, b);
  return c.json({ id }, 201);
});

app.get("/api/runbooks/:service", (c) => c.json(store.getRunbookRows(c.req.param("service"))));

app.get("/api/health-history/:service", (c) => {
  const hours = Number(c.req.query("hours") ?? 24);
  if (!Number.isInteger(hours) || hours <= 0) throw new HTTPException(400, { message: "hours must be a positive integer" });
  return c.json(store.getHealthHistoryRows(c.req.param("service"), hours));
});

// ---- structured reads for the web UI (Plan / Ops) --------------------------
// Read-only, no secret values — safe to serve to localhost without a session.
app.get("/api/projects", (c) =>
  c.json(
    db
      .prepare("SELECT id, name, status, phase, stack, repo_url, prod_url, staging_url, description FROM projects ORDER BY name")
      .all(),
  ),
);

// ---- project CRUD ----------------------------------------------------------
const zStatus = z.enum(["active", "paused", "archived"]);
const zPhase = z.number().int().min(1).max(4);
const zService = z.object({
  name: z.string(),
  plan: z.string().nullish(),
  cost_month: z.number().nullish(),
  currency: z.string().nullish(),
  dashboard_url: z.string().nullish(),
  health_url: z.string().nullish(),
});

app.post("/api/projects", async (c) => {
  const b = z
    .object({
      name: z.string().min(1),
      status: zStatus.optional(),
      phase: zPhase.optional(),
      stack: z.string().nullish(),
      repo_url: z.string().nullish(),
      prod_url: z.string().nullish(),
      staging_url: z.string().nullish(),
      description: z.string().nullish(),
      domains: z.array(z.string()).optional(),
      services: z.array(zService).optional(),
      backup: z.string().nullish(),
      milestone: z.object({ version: z.string().nullish(), title: z.string(), target_date: z.string().nullish() }).optional(),
    })
    .parse(await c.req.json());
  return c.json({ id: store.createProject(AGENT, b) }, 201);
});

app.patch("/api/projects/:id", async (c) => {
  const b = z
    .object({
      name: z.string().min(1).optional(),
      status: zStatus.optional(),
      phase: zPhase.optional(),
      stack: z.string().nullish(),
      repo_url: z.string().nullish(),
      prod_url: z.string().nullish(),
      staging_url: z.string().nullish(),
      description: z.string().nullish(),
    })
    .parse(await c.req.json());
  store.updateProject(AGENT, Number(c.req.param("id")), b);
  return c.json({ ok: true });
});

// Default DELETE = soft (archive). Hard delete needs ?hard=1&name=<exact name>.
app.delete("/api/projects/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (c.req.query("hard") === "1") {
    store.deleteProject(AGENT, id, c.req.query("name") ?? "");
    return c.json({ ok: true, deleted: "hard" });
  }
  store.archiveProject(AGENT, id);
  return c.json({ ok: true, deleted: "archived" });
});

app.get("/api/tasks", (c) => {
  const project = c.req.query("project");
  const rows = project
    ? db
        .prepare(
          `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
           WHERE p.name = ? ORDER BY t.prio, t.id`,
        )
        .all(project)
    : db.prepare("SELECT * FROM tasks ORDER BY prio, id").all();
  const deps = db.prepare("SELECT task_id, blocks_task_id FROM task_deps").all() as {
    task_id: number;
    blocks_task_id: number;
  }[];
  const blockedBy = new Map<number, number[]>();
  for (const d of deps) blockedBy.set(d.task_id, [...(blockedBy.get(d.task_id) ?? []), d.blocks_task_id]);
  return c.json((rows as { id: number }[]).map((t) => ({ ...t, blocked_by: blockedBy.get(t.id) ?? [] })));
});

app.get("/api/milestones", (c) => {
  const project = c.req.query("project");
  return c.json(
    project
      ? db
          .prepare(
            `SELECT m.* FROM milestones m JOIN projects p ON p.id = m.project_id WHERE p.name = ? ORDER BY m.id`,
          )
          .all(project)
      : db.prepare("SELECT * FROM milestones ORDER BY id").all(),
  );
});

app.get("/api/ideas", (c) => c.json(db.prepare("SELECT * FROM ideas ORDER BY created_at DESC, id DESC").all()));

app.get("/api/decisions", (c) => {
  const project = c.req.query("project");
  return c.json(
    project
      ? db
          .prepare(`SELECT d.* FROM decisions d JOIN projects p ON p.id = d.project_id WHERE p.name = ? ORDER BY d.id DESC`)
          .all(project)
      : db.prepare("SELECT * FROM decisions ORDER BY id DESC").all(),
  );
});

app.get("/api/services", (c) => {
  const project = c.req.query("project");
  const rows = (
    project
      ? db
          .prepare(`SELECT s.* FROM services s JOIN projects p ON p.id = s.project_id WHERE p.name = ? ORDER BY s.name`)
          .all(project)
      : db.prepare("SELECT * FROM services ORDER BY name").all()
  ) as { id: number }[];
  // Attach latest health sample per service so the Ops grid needs one call.
  const latest = db.prepare(
    "SELECT status, latency_ms, ts FROM health_history WHERE service_id = ? ORDER BY ts DESC LIMIT 1",
  );
  return c.json(rows.map((s) => ({ ...s, health: latest.get(s.id) ?? null })));
});

app.get("/api/incidents", (c) => {
  const openOnly = c.req.query("open") === "1";
  const rows = db
    .prepare(
      `SELECT i.*, s.name AS service FROM incidents i JOIN services s ON s.id = i.service_id
       ${openOnly ? "WHERE i.resolved_at IS NULL" : ""}
       ORDER BY i.started_at DESC`,
    )
    .all();
  return c.json(rows);
});

app.get("/api/deploys", (c) => {
  const project = c.req.query("project");
  return c.json(
    project
      ? db
          .prepare(
            `SELECT d.* FROM deploys d JOIN projects p ON p.id = d.project_id WHERE p.name = ? ORDER BY d.ts DESC LIMIT 50`,
          )
          .all(project)
      : db.prepare("SELECT * FROM deploys ORDER BY ts DESC LIMIT 50").all(),
  );
});

// ---- ops reads: certs / backups / costs ------------------------------------
app.get("/api/certs", (c) => {
  const project = c.req.query("project");
  return c.json(
    project
      ? db
          .prepare(`SELECT c.* FROM certs c JOIN projects p ON p.id = c.project_id WHERE p.name = ? ORDER BY c.expires_at`)
          .all(project)
      : db.prepare("SELECT * FROM certs ORDER BY expires_at").all(),
  );
});

app.get("/api/backups", (c) => {
  const project = c.req.query("project");
  return c.json(
    project
      ? db
          .prepare(`SELECT b.* FROM backups b JOIN projects p ON p.id = b.project_id WHERE p.name = ? ORDER BY b.target`)
          .all(project)
      : db.prepare("SELECT * FROM backups ORDER BY target").all(),
  );
});

// Monthly cost rows with their service name; the Ops cost-trend sparkline groups these by service.
app.get("/api/costs", (c) => {
  const project = c.req.query("project");
  return c.json(
    project
      ? db
          .prepare(
            `SELECT co.*, s.name AS service FROM costs co JOIN services s ON s.id = co.service_id
             JOIN projects p ON p.id = s.project_id WHERE p.name = ? ORDER BY co.month`,
          )
          .all(project)
      : db
          .prepare(`SELECT co.*, s.name AS service FROM costs co JOIN services s ON s.id = co.service_id ORDER BY co.month`)
          .all(),
  );
});

// ---- files (v2): per-project file manager, blobs in SQLite -----------------
// Reads are scoped to a project. Downloads STREAM the blob (never buffered whole).
const reqProject = (c: { req: { query: (n: string) => string | undefined } }): string => {
  const p = c.req.query("project");
  if (!p) throw new HTTPException(400, { message: "project query param required" });
  return p;
};

app.get("/api/folders", (c) => c.json(files.listFolders(reqProject(c))));
app.post("/api/folders", async (c) => {
  const b = z
    .object({ project: z.string(), name: z.string().min(1), parent_id: z.number().int().nullable().optional() })
    .parse(await c.req.json());
  return c.json({ id: files.createFolder(AGENT, b) }, 201);
});
app.delete("/api/folders/:id", (c) => {
  files.deleteFolder(AGENT, Number(c.req.param("id")));
  return c.json({ ok: true });
});

app.get("/api/files", (c) => c.json(files.listFiles(reqProject(c))));
app.post("/api/files", async (c) => {
  const b = z
    .object({
      project: z.string(),
      name: z.string().min(1),
      mime: z.string().default("text/plain"),
      folder_id: z.number().int().nullable().optional(),
    })
    .parse(await c.req.json());
  return c.json({ id: files.createFile(AGENT, b) }, 201);
});
app.delete("/api/files/:id", (c) => {
  files.deleteFile(AGENT, Number(c.req.param("id")));
  return c.json({ ok: true });
});

// Multipart upload → new file + version 1. The body is buffered (upload only).
app.post("/api/files/upload", async (c) => {
  const body = await c.req.parseBody();
  const f = body["file"];
  const project = body["project"];
  if (!(f instanceof File)) throw new HTTPException(400, { message: "multipart 'file' field required" });
  if (typeof project !== "string") throw new HTTPException(400, { message: "'project' field required" });
  const folderRaw = body["folder_id"];
  const data = Buffer.from(await f.arrayBuffer());
  const id = files.uploadFile(AGENT, {
    project,
    name: (typeof body["name"] === "string" && body["name"]) || f.name,
    mime: f.type || "application/octet-stream",
    folder_id: typeof folderRaw === "string" && folderRaw ? Number(folderRaw) : undefined,
    data,
  });
  return c.json({ id, size: data.length }, 201);
});

// Save text content as a new version.
app.post("/api/files/:id/version", async (c) => {
  const b = z.object({ content: z.string() }).parse(await c.req.json());
  return c.json({ version: files.addVersion(AGENT, Number(c.req.param("id")), Buffer.from(b.content, "utf8")) }, 201);
});

app.get("/api/files/:id/versions", (c) => c.json(files.listVersions(Number(c.req.param("id")))));

app.post("/api/files/:id/restore", async (c) => {
  const b = z.object({ version: z.number().int().positive() }).parse(await c.req.json());
  return c.json({ version: files.restoreVersion(AGENT, Number(c.req.param("id")), b.version) });
});

// Streamed download of the latest version — bounded memory.
app.get("/api/files/:id/content", (c) => {
  const id = Number(c.req.param("id"));
  const f = files.getFile(id);
  if (!f) throw new HTTPException(404, { message: "unknown file" });
  const v = files.latestVersion(id);
  const size = v?.size ?? 0;
  c.header("Content-Type", f.mime || "application/octet-stream");
  c.header("Content-Disposition", `attachment; filename="${encodeURIComponent(f.name)}"`);
  if (!v || size === 0) return c.body(null);
  return stream(c, async (s) => {
    for (const chunk of files.readVersionChunks(v.id, size)) await s.write(chunk);
  });
});

// ---- settings (non-secret app config) --------------------------------------
app.get("/api/settings", (c) => c.json(settings.publicSettings()));
app.post("/api/settings", async (c) => {
  const b = z.object({ key: z.string().min(1), value: z.string() }).parse(await c.req.json());
  settings.setSetting(b.key, b.value);
  return c.json({ ok: true }, 201);
});

// ---- AI (Ollama) — local only ----------------------------------------------
app.get("/api/tags", async (c) => c.json({ models: await ai.ollamaTags() }));
app.get("/api/ai/status", async (c) => c.json({ ...(await ai.ollamaStatus()), auto: settings.AI_AUTO() }));
app.get("/api/ai/suggestions", (c) => c.json(ai.listSuggestions(c.req.query("status") ?? "open")));
app.post("/api/ai/analyze", async (c) => c.json({ suggestions: await ai.analyze() }));
app.post("/api/ai/suggestions/:id/accept", (c) => {
  ai.acceptSuggestion(Number(c.req.param("id")));
  return c.json({ ok: true });
});
app.post("/api/ai/suggestions/:id/dismiss", (c) => {
  ai.dismissSuggestion(Number(c.req.param("id")));
  return c.json({ ok: true });
});
app.post("/api/ai/answer", async (c) => {
  const b = z.object({ id: z.number().int(), text: z.string().min(1) }).parse(await c.req.json());
  ai.answerQuestion(b.id, b.text);
  return c.json({ ok: true });
});

// ---- reminders (v2) --------------------------------------------------------
const zRecurrence = z.enum(["none", "daily", "weekly", "monthly"]);
const zChannel = z.enum(["ui", "email", "both"]);

app.get("/api/reminders", (c) => c.json(reminders.listReminders(c.req.query("project") ?? undefined)));
app.get("/api/reminders/due", (c) => c.json(reminders.dueUiReminders())); // UI badge/toast
app.get("/api/reminders/smtp", (c) => c.json({ configured: smtpConfigured() }));

app.post("/api/reminders", async (c) => {
  const b = z
    .object({
      project: z.string().optional(),
      task_id: z.number().int().nullable().optional(),
      title: z.string().min(1),
      due_at: z.string().min(1),
      recurrence: zRecurrence.optional(),
      channel: zChannel.optional(),
    })
    .parse(await c.req.json());
  return c.json({ id: reminders.createReminder(AGENT, b) }, 201);
});

app.patch("/api/reminders/:id", async (c) => {
  const b = z
    .object({
      title: z.string().optional(),
      due_at: z.string().optional(),
      recurrence: zRecurrence.optional(),
      channel: zChannel.optional(),
      status: z.enum(["pending", "sent", "done"]).optional(),
    })
    .parse(await c.req.json());
  reminders.updateReminder(AGENT, Number(c.req.param("id")), b);
  return c.json({ ok: true });
});

app.delete("/api/reminders/:id", (c) => {
  reminders.deleteReminder(AGENT, Number(c.req.param("id")));
  return c.json({ ok: true });
});

// Send a test email with the current SMTP settings.
app.post("/api/reminders/test-email", async (c) => {
  const b = z.object({ to: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
  await sendMail({ to: b.to, subject: "DevPanel test email", text: "SMTP is working. ✅" });
  return c.json({ ok: true });
});

// ---- secrets ----------------------------------------------------------------
// Metadata (name/scope/age) is the same "safe" view MCP exposes — no session.
app.get("/api/secrets", (c) => {
  const project = c.req.query("project");
  const pid = project ? store.projectId(project) : undefined;
  return c.json(listSecretsMeta(pid));
});

// First-run only: pin the master password. Idempotency guarded by crypto.
app.post("/api/secrets/setup", async (c) => {
  const b = z.object({ password: z.string().min(1) }).parse(await c.req.json());
  await setMasterPassword(b.password);
  return c.json({ ok: true }, 201);
});

// Verify master password → 5-minute session bearer token.
app.post("/api/secrets/unlock", async (c) => {
  const b = z.object({ password: z.string().min(1) }).parse(await c.req.json());
  const key = await unlock(b.password); // throws on bad password → 400
  return c.json(openSession(key));
});

app.post("/api/secrets/lock", (c) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer ")) sessions.delete(auth.slice(7));
  return c.json({ ok: true });
});

// Upsert a secret value (requires unlocked session).
app.post("/api/secrets", async (c) => {
  const key = requireKey(c);
  const b = z
    .object({
      project: z.string(),
      name: z.string().min(1),
      value: z.string(),
      scope: z.enum(["dev", "prod"]).default("dev"),
    })
    .parse(await c.req.json());
  putSecret(key, store.projectId(b.project), b.name, b.value, b.scope);
  return c.json({ ok: true }, 201);
});

// Decrypt and return a single secret value (requires unlocked session).
app.post("/api/secrets/:id/reveal", (c) => {
  const key = requireKey(c);
  return c.json({ value: revealSecret(key, Number(c.req.param("id"))) });
});

app.delete("/api/secrets/:id", (c) => {
  requireKey(c);
  deleteSecret(Number(c.req.param("id")));
  return c.json({ ok: true });
});

// ---- static web UI (built by step 7) ---------------------------------------
// Serve web/dist with SPA fallback. Absent until the UI is built — the API
// still runs fine; unknown non-/api paths just 404 until then.
if (existsSync(WEB_DIST)) {
  app.use("/*", serveStatic({ root: WEB_DIST }));
  app.get("/*", serveStatic({ path: `${WEB_DIST}/index.html` }));
}

// ---- boot -------------------------------------------------------------------
serve({ fetch: app.fetch, hostname: BIND, port: PORT }, (info) => {
  console.log(`devpanel API on http://${BIND}:${info.port}  (web/dist ${existsSync(WEB_DIST) ? "served" : "not built"})`);
});
