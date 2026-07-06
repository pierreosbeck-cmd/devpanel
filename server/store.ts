// DevPanel — shared planning + ops logic, used by BOTH the MCP server (stdio)
// and the REST API (Hono). Single source of truth so the two never drift.
//
// Every mutating function takes an `agent` string and writes to activity_log
// via db's logActivity — MCP passes the connecting client's name, the API
// passes "api". Secret VALUES never appear here; only metadata (see crypto.ts).
import { db, logActivity } from "./db.js";
import { listSecretsMeta } from "./crypto.js";

// ---- resolvers --------------------------------------------------------------
export function projectId(name: string): number {
  const row = db.prepare("SELECT id FROM projects WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`unknown project: ${name}`);
  return row.id;
}
export function serviceId(name: string): number {
  const row = db.prepare("SELECT id FROM services WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`unknown service: ${name}`);
  return row.id;
}

// ---- get_context (markdown, shared verbatim by MCP and API) -----------------
export function buildContext(): string {
  const out: string[] = ["# DevPanel context", ""];

  const projects = db
    .prepare("SELECT id, name, status, phase, stack FROM projects ORDER BY name")
    .all() as { id: number; name: string; status: string; phase: number; stack: string | null }[];

  if (projects.length === 0) return "# DevPanel context\n\n_No projects yet._\n";

  for (const p of projects) {
    out.push(`## ${p.name}  (${p.status}, phase ${p.phase}${p.stack ? `, ${p.stack}` : ""})`);

    // Open tasks with prio + dep indicators
    const tasks = db
      .prepare(
        `SELECT id, title, status, prio, source FROM tasks
         WHERE project_id = ? AND status != 'done'
         ORDER BY prio, id`,
      )
      .all(p.id) as { id: number; title: string; status: string; prio: string; source: string }[];
    if (tasks.length) {
      out.push("", "**Open tasks:**");
      for (const t of tasks) {
        const blockers = (
          db
            .prepare("SELECT blocks_task_id FROM task_deps WHERE task_id = ?")
            .all(t.id) as { blocks_task_id: number }[]
        ).map((r) => `#${r.blocks_task_id}`);
        const dep = blockers.length ? ` 🔗 blocked by ${blockers.join(", ")}` : "";
        const ai = t.source === "ai" ? " [AI]" : "";
        out.push(`- #${t.id} [${t.prio}] ${t.title} (${t.status})${ai}${dep}`);
      }
    }

    // Milestones
    const ms = db
      .prepare("SELECT version, title, status, target_date FROM milestones WHERE project_id = ? ORDER BY id")
      .all(p.id) as { version: string | null; title: string; status: string; target_date: string | null }[];
    if (ms.length) {
      out.push("", "**Milestones:**");
      for (const m of ms)
        out.push(`- ${m.version ?? ""} ${m.title} — ${m.status}${m.target_date ? ` (target ${m.target_date})` : ""}`);
    }

    // Latest health per service
    const health = db
      .prepare(
        `SELECT s.name AS svc, h.status, h.latency_ms, h.ts
         FROM services s
         LEFT JOIN health_history h ON h.id = (
           SELECT id FROM health_history WHERE service_id = s.id ORDER BY ts DESC LIMIT 1
         )
         WHERE s.project_id = ?`,
      )
      .all(p.id) as { svc: string; status: string | null; latency_ms: number | null; ts: string | null }[];
    if (health.length) {
      out.push("", "**Health (latest):**");
      for (const h of health)
        out.push(`- ${h.svc}: ${h.status ?? "unknown"}${h.latency_ms != null ? ` ${h.latency_ms}ms` : ""}`);
    }

    // Open incidents
    const inc = db
      .prepare(
        `SELECT i.id, i.severity, i.title, s.name AS svc FROM incidents i
         JOIN services s ON s.id = i.service_id
         WHERE s.project_id = ? AND i.resolved_at IS NULL ORDER BY i.started_at DESC`,
      )
      .all(p.id) as { id: number; severity: string; title: string; svc: string }[];
    if (inc.length) {
      out.push("", "**Open incidents:**");
      for (const i of inc) out.push(`- #${i.id} [${i.severity}] ${i.svc}: ${i.title}`);
    }

    // Recent deploys
    const dep = db
      .prepare("SELECT sha, env, status, ts FROM deploys WHERE project_id = ? ORDER BY ts DESC LIMIT 5")
      .all(p.id) as { sha: string; env: string; status: string; ts: string }[];
    if (dep.length) {
      out.push("", "**Recent deploys:**");
      for (const d of dep) out.push(`- ${d.sha.slice(0, 8)} → ${d.env} ${d.status} (${d.ts})`);
    }

    // Secrets metadata — NEVER values
    const secrets = listSecretsMeta(p.id);
    if (secrets.length) {
      out.push("", "**Secrets (metadata only):**");
      for (const s of secrets)
        out.push(`- ${s.name} [${s.scope}] age ${s.age_days}d${s.age_days > 90 ? " ⚠" : ""}`);
    }

    out.push("");
  }
  return out.join("\n");
}

// ---- commands (each logs to activity_log under `agent`) ---------------------
export function createTask(
  agent: string,
  args: {
    project: string;
    title: string;
    prio: "P0" | "P1" | "P2" | "P3";
    effort?: "S" | "M" | "L";
    milestone?: string;
    source?: "manual" | "ai";
  },
): number {
  const pid = projectId(args.project);
  let mid: number | null = null;
  if (args.milestone) {
    const row = db
      .prepare("SELECT id FROM milestones WHERE project_id = ? AND (title = ? OR version = ?)")
      .get(pid, args.milestone, args.milestone) as { id: number } | undefined;
    if (!row) throw new Error(`unknown milestone: ${args.milestone}`);
    mid = row.id;
  }
  const source = args.source ?? "manual";
  const info = db
    .prepare("INSERT INTO tasks (project_id, milestone_id, title, prio, effort, source) VALUES (?, ?, ?, ?, ?, ?)")
    .run(pid, mid, args.title, args.prio, args.effort ?? null, source);
  const id = Number(info.lastInsertRowid);
  logActivity(agent, `create_task #${id} "${args.title}" [${args.prio}] in ${args.project}`);
  return id;
}

export function updateTask(
  agent: string,
  args: { id: number; status?: "todo" | "doing" | "done" | "blocked"; prio?: "P0" | "P1" | "P2" | "P3" },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (args.status) { sets.push("status = ?"); vals.push(args.status); }
  if (args.prio) { sets.push("prio = ?"); vals.push(args.prio); }
  if (!sets.length) throw new Error("nothing to update");
  sets.push("updated_at = datetime('now')");
  const info = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals, args.id);
  if (info.changes === 0) throw new Error(`unknown task: ${args.id}`);
  logActivity(agent, `update_task #${args.id} ${args.status ?? ""} ${args.prio ?? ""}`.trim());
}

export function addDep(agent: string, taskId: number, blocksTaskId: number): void {
  if (taskId === blocksTaskId) throw new Error("a task cannot block itself");
  db.prepare("INSERT OR IGNORE INTO task_deps (task_id, blocks_task_id) VALUES (?, ?)").run(taskId, blocksTaskId);
  logActivity(agent, `add_dep #${taskId} blocked by #${blocksTaskId}`);
}

export function addIdea(agent: string, title: string, note?: string): number {
  const info = db.prepare("INSERT INTO ideas (title, note) VALUES (?, ?)").run(title, note ?? null);
  const id = Number(info.lastInsertRowid);
  logActivity(agent, `add_idea #${id} "${title}"`);
  return id;
}

export function addDecision(
  agent: string,
  args: { project: string; title: string; body: string; status: "proposed" | "accepted" | "superseded" },
): number {
  const pid = projectId(args.project);
  const info = db
    .prepare("INSERT INTO decisions (project_id, title, body, status) VALUES (?, ?, ?, ?)")
    .run(pid, args.title, args.body, args.status);
  const id = Number(info.lastInsertRowid);
  logActivity(agent, `add_decision #${id} "${args.title}" (${args.status})`);
  return id;
}

export function reportIncident(
  agent: string,
  args: { service: string; severity: "low" | "high" | "critical"; title: string },
): number {
  const sid = serviceId(args.service);
  const info = db
    .prepare("INSERT INTO incidents (service_id, severity, title) VALUES (?, ?, ?)")
    .run(sid, args.severity, args.title);
  const id = Number(info.lastInsertRowid);
  logActivity(agent, `report_incident #${id} [${args.severity}] ${args.service}: ${args.title}`);
  return id;
}

export function resolveIncident(agent: string, id: number, postmortem?: string): void {
  const info = db
    .prepare("UPDATE incidents SET resolved_at = datetime('now'), postmortem = ? WHERE id = ? AND resolved_at IS NULL")
    .run(postmortem ?? null, id);
  if (info.changes === 0) throw new Error(`no open incident: ${id}`);
  logActivity(agent, `resolve_incident #${id}`);
}

export function logDeploy(
  agent: string,
  args: { project: string; sha: string; env: "staging" | "prod"; status: "ok" | "fail" },
): number {
  const pid = projectId(args.project);
  const info = db
    .prepare("INSERT INTO deploys (project_id, sha, env, status) VALUES (?, ?, ?, ?)")
    .run(pid, args.sha, args.env, args.status);
  const id = Number(info.lastInsertRowid);
  logActivity(agent, `log_deploy ${args.sha.slice(0, 8)} → ${args.env} ${args.status} (${args.project})`);
  return id;
}

// ---- projects ---------------------------------------------------------------
type ServiceInput = {
  name: string;
  plan?: string | null;
  cost_month?: number | null;
  currency?: string | null;
  dashboard_url?: string | null;
  health_url?: string | null;
};
export function createProject(
  agent: string,
  a: {
    name: string;
    status?: "active" | "paused" | "archived";
    phase?: number;
    stack?: string | null;
    repo_url?: string | null;
    prod_url?: string | null;
    staging_url?: string | null;
    description?: string | null;
    domains?: string[];
    services?: ServiceInput[];
    backup?: string | null;
    milestone?: { version?: string | null; title: string; target_date?: string | null };
  },
): number {
  const id = db.transaction(() => {
    const pid = Number(
      db
        .prepare(
          "INSERT INTO projects (name, status, phase, stack, repo_url, prod_url, staging_url, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          a.name,
          a.status ?? "active",
          a.phase ?? 1,
          a.stack ?? null,
          a.repo_url ?? null,
          a.prod_url ?? null,
          a.staging_url ?? null,
          a.description ?? null,
        ).lastInsertRowid,
    );
    for (const d of a.domains ?? [])
      if (d.trim()) db.prepare("INSERT INTO certs (project_id, domain) VALUES (?, ?)").run(pid, d.trim());
    for (const s of a.services ?? [])
      if (s.name?.trim())
        db
          .prepare(
            "INSERT INTO services (project_id, name, plan, cost_month, currency, dashboard_url, health_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(pid, s.name.trim(), s.plan ?? null, s.cost_month ?? null, s.currency ?? null, s.dashboard_url ?? null, s.health_url ?? null);
    if (a.backup?.trim()) db.prepare("INSERT INTO backups (project_id, target) VALUES (?, ?)").run(pid, a.backup.trim());
    if (a.milestone?.title?.trim())
      db
        .prepare("INSERT INTO milestones (project_id, version, title, target_date) VALUES (?, ?, ?, ?)")
        .run(pid, a.milestone.version ?? null, a.milestone.title.trim(), a.milestone.target_date ?? null);
    return pid;
  })();
  logActivity(agent, `create_project "${a.name}" (#${id})`);
  return id;
}

const PROJECT_COLS = ["name", "status", "phase", "stack", "repo_url", "prod_url", "staging_url", "description"] as const;
export function updateProject(agent: string, id: number, patch: Record<string, unknown>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const col of PROJECT_COLS)
    if (patch[col] !== undefined) {
      sets.push(`${col} = ?`);
      vals.push(patch[col]);
    }
  if (!sets.length) throw new Error("nothing to update");
  if (!db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id).changes)
    throw new Error(`unknown project: ${id}`);
  logActivity(agent, `update_project #${id}`);
}

export function archiveProject(agent: string, id: number): void {
  if (!db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(id).changes)
    throw new Error(`unknown project: ${id}`);
  logActivity(agent, `archive_project #${id}`);
}

// Hard delete — requires the caller to echo back the exact project name. FK
// cascade removes tasks, files, secrets, services (and their children), etc.
export function deleteProject(agent: string, id: number, confirmName: string): void {
  const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(id) as { name: string } | undefined;
  if (!row) throw new Error(`unknown project: ${id}`);
  if (confirmName !== row.name) throw new Error("confirmation name does not match project name");
  db.pragma("foreign_keys = ON");
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  logActivity(agent, `delete_project #${id} "${row.name}"`);
}

// ---- reads (no logging) -----------------------------------------------------
export type RunbookRow = { title: string; body_md: string | null };
export function getRunbookRows(service: string): RunbookRow[] {
  const sid = serviceId(service);
  return db
    .prepare("SELECT title, body_md FROM runbooks WHERE service_id = ? ORDER BY id")
    .all(sid) as RunbookRow[];
}

export type HealthRow = { status: string; latency_ms: number | null; ts: string };
export function getHealthHistoryRows(service: string, hours: number): HealthRow[] {
  const sid = serviceId(service);
  return db
    .prepare(
      `SELECT status, latency_ms, ts FROM health_history
       WHERE service_id = ? AND ts >= datetime('now', ?)
       ORDER BY ts DESC`,
    )
    .all(sid, `-${hours} hours`) as HealthRow[];
}
