// DevPanel — step 6: worker. Two jobs, one long-running process (pm2 in step 8):
//   1. Health poll every 60s: GET each service's health_url → health_history.
//      On an up↔down shift: ntfy + auto-open an incident (critical if the
//      service's project is production, i.e. has a prod_url; else high). On
//      recovery: ntfy + auto-resolve the service's open incidents.
//   2. Daily cron: cert-expiry <14d, secret age >90d, backup age >48h, and
//      cost anomalies → ntfy.
//
// The worker never touches secret VALUES — only metadata (name/scope/age).
// Writes go through store.ts so they land in activity_log tagged agent "worker".
import { db } from "../server/db.js";
import { reportIncident, resolveIncident } from "../server/store.js";
import { listSecretsMeta } from "../server/crypto.js";
import * as ai from "../server/ai.js";
import { AI_AUTO } from "../server/settings.js";
import { fireDue } from "../server/reminders.js";

// Load .env relative to this file so cwd doesn't matter (pm2, cron, shell).
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  /* no .env — rely on defaults / real environment */
}

const AGENT = "worker";
const HEALTH_INTERVAL_MS = 60_000;
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AI_INTERVAL_MS = 30 * 60 * 1000; // Ollama auto-analyze, only when settings.ai_auto=on
const REMINDER_INTERVAL_MS = 60_000; // fire due reminders every minute
const SLOW_MS = Number(process.env.HEALTH_SLOW_MS ?? 2000);
const TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS ?? 10_000);
const COST_OVERRUN = Number(process.env.COST_OVERRUN ?? 1.2);
const NTFY_SERVER = (process.env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/+$/, "");
const NTFY_TOPIC = process.env.NTFY_TOPIC?.trim() || undefined;

const CERT_WARN_DAYS = 14;
const SECRET_WARN_DAYS = 90;
const BACKUP_WARN_HOURS = 48;

// ---- ntfy -------------------------------------------------------------------
// Every alert is logged to stdout; if a topic is configured it's also POSTed to
// ntfy. A send failure is logged and swallowed — alerting must never crash the
// poll loop.
type Priority = "min" | "low" | "default" | "high" | "urgent";
async function ntfy(title: string, message: string, priority: Priority = "default", tags = ""): Promise<void> {
  console.log(`[alert:${priority}] ${title} — ${message}${tags ? `  (${tags})` : ""}`);
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: title, Priority: priority, ...(tags ? { Tags: tags } : {}) },
      body: message,
    });
  } catch (e) {
    console.error(`[ntfy] send failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ---- time helpers -----------------------------------------------------------
// SQLite stores UTC 'YYYY-MM-DD HH:MM:SS' (or bare 'YYYY-MM-DD'). Parse as UTC.
function parseUtc(s: string): number {
  const iso = (s.length > 10 ? s.replace(" ", "T") : `${s}T00:00:00`) + "Z";
  return new Date(iso).getTime();
}

// ---- health poll ------------------------------------------------------------
type Status = "up" | "down" | "degraded";
type ServiceRow = { id: number; name: string; health_url: string; prod_url: string | null };

async function probe(url: string): Promise<{ status: Status; latency_ms: number }> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const latency_ms = Date.now() - start;
    if (!res.ok) return { status: "down", latency_ms };
    return { status: latency_ms > SLOW_MS ? "degraded" : "up", latency_ms };
  } catch {
    return { status: "down", latency_ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

function lastStatus(serviceId: number): Status | undefined {
  const row = db
    .prepare("SELECT status FROM health_history WHERE service_id = ? ORDER BY ts DESC LIMIT 1")
    .get(serviceId) as { status: Status } | undefined;
  return row?.status;
}

async function checkService(svc: ServiceRow): Promise<void> {
  const prev = lastStatus(svc.id); // read BEFORE inserting the new sample
  const { status, latency_ms } = await probe(svc.health_url);
  db.prepare("INSERT INTO health_history (service_id, status, latency_ms) VALUES (?, ?, ?)").run(
    svc.id,
    status,
    latency_ms,
  );

  // Only up↔down shifts alert (degraded is recorded but not paged, per SPEC).
  const wasDown = prev === "down";
  const isDown = status === "down";

  if (isDown && !wasDown) {
    const prod = svc.prod_url != null && svc.prod_url !== "";
    const severity = prod ? "critical" : "high";
    reportIncident(AGENT, { service: svc.name, severity, title: `${svc.name} is down` });
    await ntfy(
      `🔴 ${svc.name} DOWN`,
      `${svc.name} failed its healthcheck (${latency_ms}ms). Incident opened [${severity}].`,
      prod ? "urgent" : "high",
      "rotating_light",
    );
  } else if (!isDown && wasDown) {
    // Recovered (up or degraded): resolve any incidents left open for it.
    const open = db
      .prepare("SELECT id FROM incidents WHERE service_id = ? AND resolved_at IS NULL")
      .all(svc.id) as { id: number }[];
    for (const i of open) resolveIncident(AGENT, i.id, "auto-resolved: healthcheck recovered");
    await ntfy(`🟢 ${svc.name} recovered`, `${svc.name} is back (${status}, ${latency_ms}ms).`, "default", "white_check_mark");
  }
}

async function pollHealth(): Promise<void> {
  const services = db
    .prepare(
      `SELECT s.id, s.name, s.health_url, p.prod_url
       FROM services s JOIN projects p ON p.id = s.project_id
       WHERE s.health_url IS NOT NULL AND s.health_url != ''`,
    )
    .all() as ServiceRow[];
  if (!services.length) return;
  // Independent probes — run concurrently; isolate failures per service.
  await Promise.all(
    services.map((svc) =>
      checkService(svc).catch((e) =>
        console.error(`[health] ${svc.name}: ${e instanceof Error ? e.message : e}`),
      ),
    ),
  );
}

// ---- daily alert cron -------------------------------------------------------
async function checkCerts(now: number): Promise<void> {
  const rows = db
    .prepare(
      `SELECT c.domain, c.expires_at, p.name AS project
       FROM certs c JOIN projects p ON p.id = c.project_id
       WHERE c.expires_at IS NOT NULL`,
    )
    .all() as { domain: string; expires_at: string; project: string }[];
  for (const c of rows) {
    const days = Math.floor((parseUtc(c.expires_at) - now) / 86_400_000);
    if (days <= CERT_WARN_DAYS) {
      const when = days < 0 ? `expired ${-days}d ago` : `expires in ${days}d`;
      await ntfy(`🔒 Cert ${c.domain} ${when}`, `${c.project}: certificate for ${c.domain} ${when} (${c.expires_at}).`, days < 0 ? "urgent" : "high", "lock");
    }
  }
}

async function checkSecrets(): Promise<void> {
  for (const s of listSecretsMeta()) {
    if (s.age_days > SECRET_WARN_DAYS)
      await ntfy(`🔑 Secret ${s.name} is ${s.age_days}d old`, `${s.name} [${s.scope}] hasn't been rotated in ${s.age_days} days.`, "high", "key");
  }
}

async function checkBackups(now: number): Promise<void> {
  const rows = db
    .prepare(
      `SELECT b.target, b.last_ok_at, p.name AS project
       FROM backups b JOIN projects p ON p.id = b.project_id`,
    )
    .all() as { target: string; last_ok_at: string | null; project: string }[];
  for (const b of rows) {
    if (!b.last_ok_at) {
      await ntfy(`💾 Backup ${b.target} never succeeded`, `${b.project}: no successful backup recorded for ${b.target}.`, "high", "floppy_disk");
      continue;
    }
    const hours = Math.floor((now - parseUtc(b.last_ok_at)) / 3_600_000);
    if (hours > BACKUP_WARN_HOURS)
      await ntfy(`💾 Backup ${b.target} stale (${hours}h)`, `${b.project}: last successful backup of ${b.target} was ${hours}h ago.`, "high", "floppy_disk");
  }
}

async function checkCosts(): Promise<void> {
  const services = db
    .prepare("SELECT id, name, cost_month, currency FROM services WHERE cost_month IS NOT NULL AND cost_month > 0")
    .all() as { id: number; name: string; cost_month: number; currency: string | null }[];
  for (const s of services) {
    const latest = db
      .prepare("SELECT month, SUM(amount) AS amt FROM costs WHERE service_id = ? GROUP BY month ORDER BY month DESC LIMIT 1")
      .get(s.id) as { month: string; amt: number } | undefined;
    if (!latest) continue;
    if (latest.amt > s.cost_month * COST_OVERRUN) {
      const cur = s.currency ?? "";
      const pct = Math.round((latest.amt / s.cost_month - 1) * 100);
      await ntfy(
        `💸 ${s.name} over budget (+${pct}%)`,
        `${s.name} ${latest.month}: ${latest.amt}${cur} vs budget ${s.cost_month}${cur}.`,
        "high",
        "money_with_wings",
      );
    }
  }
}

async function runDailyChecks(): Promise<void> {
  const now = Date.now();
  console.log(`[daily] running cert/secret/backup/cost checks @ ${new Date(now).toISOString()}`);
  await checkCerts(now);
  await checkSecrets();
  await checkBackups(now);
  await checkCosts();
}

// ---- AI auto-analyze --------------------------------------------------------
// Only runs when the user has enabled it (settings.ai_auto=on); default off so
// the worker never calls Ollama uninvited. Failures are logged, not fatal.
async function runAiAnalyze(): Promise<void> {
  if (!AI_AUTO()) return;
  const s = await ai.analyze();
  console.log(`[ai] auto-analyze → ${s.length} suggestion(s)`);
}

// ---- boot -------------------------------------------------------------------
async function main(): Promise<void> {
  const mode = process.argv[2];

  if (mode === "poll") return void (await pollHealth()); // one health sweep, then exit
  if (mode === "daily") return void (await runDailyChecks()); // one cron pass, then exit
  if (mode === "ai") return void (await runAiAnalyze()); // one AI pass, then exit
  if (mode === "reminders") return void (await fireDue()); // one reminder sweep, then exit

  // Daemon: poll now + every 60s, run daily checks now + every 24h.
  console.log(
    `devpanel worker: health every ${HEALTH_INTERVAL_MS / 1000}s, daily cron; ` +
      `ntfy ${NTFY_TOPIC ? `→ ${NTFY_SERVER}/${NTFY_TOPIC}` : "disabled (logging only)"}`,
  );
  const tick = (fn: () => Promise<void>, label: string) => () =>
    fn().catch((e) => console.error(`[${label}] ${e instanceof Error ? e.message : e}`));

  await tick(pollHealth, "health")();
  await tick(runDailyChecks, "daily")();
  const h = setInterval(tick(pollHealth, "health"), HEALTH_INTERVAL_MS);
  const d = setInterval(tick(runDailyChecks, "daily"), DAILY_INTERVAL_MS);
  const a = setInterval(tick(runAiAnalyze, "ai"), AI_INTERVAL_MS);
  const rem = setInterval(
    tick(async () => {
      await fireDue();
    }, "reminders"),
    REMINDER_INTERVAL_MS,
  );

  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      clearInterval(h);
      clearInterval(d);
      clearInterval(a);
      clearInterval(rem);
      console.log(`\ndevpanel worker: ${sig}, shutting down`);
      process.exit(0);
    });
}

await main();
