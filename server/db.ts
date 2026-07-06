// DevPanel — step 1: schema (db.ts complete per SPEC).
// One SQLite DB, WAL, busy_timeout 5000. Single-user, localhost.
import Database from "better-sqlite3";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

// Portable default: <repo>/data/panel.db, resolved relative to this file so it
// works from any clone location and any cwd. Override with DB_PATH in .env.
const DB_PATH = process.env.DB_PATH ?? fileURLToPath(new URL("../data/panel.db", import.meta.url));

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");
// v2 file manager: allow large blobs, and reclaim space incrementally after
// file/version deletes. auto_vacuum only takes on a fresh DB (or after a full
// VACUUM); on an existing DB it is a harmless no-op until then.
db.pragma("max_page_count = 2147483646");
db.pragma("auto_vacuum = INCREMENTAL");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE,
  status    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  phase     INTEGER NOT NULL DEFAULT 0,
  stack     TEXT,
  repo_url  TEXT,
  prod_url  TEXT
);

CREATE TABLE IF NOT EXISTS milestones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version     TEXT,
  title       TEXT NOT NULL,
  target_date TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','shipped'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','blocked')),
  prio         TEXT NOT NULL DEFAULT 'P2' CHECK (prio IN ('P0','P1','P2','P3')),
  effort       TEXT CHECK (effort IN ('S','M','L')),
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocks_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, blocks_task_id)
);

CREATE TABLE IF NOT EXISTS ideas (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  note         TEXT,
  project_hint TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT,
  status     TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','superseded')),
  task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS secrets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  value_enc  BLOB NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'dev' CHECK (scope IN ('dev','prod')),
  rotated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, name, scope)
);

CREATE TABLE IF NOT EXISTS services (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  plan          TEXT,
  cost_month    REAL,
  currency      TEXT,
  dashboard_url TEXT,
  health_url    TEXT
);

CREATE TABLE IF NOT EXISTS health_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('up','down','degraded')),
  latency_ms INTEGER,
  ts         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  severity    TEXT NOT NULL CHECK (severity IN ('low','high','critical')),
  title       TEXT NOT NULL,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  postmortem  TEXT
);

CREATE TABLE IF NOT EXISTS deploys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha        TEXT NOT NULL,
  env        TEXT NOT NULL CHECK (env IN ('staging','prod')),
  status     TEXT NOT NULL CHECK (status IN ('ok','fail')),
  ts         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runbooks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body_md    TEXT
);

CREATE TABLE IF NOT EXISTS costs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  month      TEXT NOT NULL,
  amount     REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target     TEXT NOT NULL,
  last_ok_at TEXT
);

CREATE TABLE IF NOT EXISTS certs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain     TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  agent  TEXT NOT NULL,
  action TEXT NOT NULL,
  ts     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Key-value meta for crypto material (kdf salt, verifier). Never holds secret values.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- v2: per-project file manager. Blobs live in file_versions; latest = MAX(version).
CREATE TABLE IF NOT EXISTS folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_id  INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  blob       BLOB,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (file_id, version)
);

-- v2: app settings (non-secret config: ollama model, ai_auto, smtp_*). Sensitive
-- keys are redacted by the API layer, never returned raw.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- v2: Ollama-generated suggestions + the Q&A loop fed back as context.
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('prioritize','new_task','move_task','question')),
  payload    TEXT NOT NULL,
  motivation TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- v2: reminders (project/task-scoped or standalone), UI toast + optional email.
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  due_at     TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekly','monthly')),
  channel    TEXT NOT NULL DEFAULT 'ui' CHECK (channel IN ('ui','email','both')),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','done'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project     ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_reminders_due     ON reminders(status, due_at);
CREATE INDEX IF NOT EXISTS idx_health_service_ts ON health_history(service_id, ts);
CREATE INDEX IF NOT EXISTS idx_deploys_project   ON deploys(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_files_project     ON files(project_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_folders_project   ON folders(project_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_fversions_file    ON file_versions(file_id, version);
`);

// v2.1: add project description + staging_url. Idempotent (SQLite ALTER has no
// IF NOT EXISTS), backward-compatible — existing rows get NULL.
for (const [col, type] of [
  ["description", "TEXT"],
  ["staging_url", "TEXT"],
] as const) {
  const exists = db.prepare("SELECT 1 FROM pragma_table_info('projects') WHERE name = ?").get(col);
  if (!exists) db.exec(`ALTER TABLE projects ADD COLUMN ${col} ${type}`);
}

// All writes originating from MCP/AI must be logged with the agent name.
export function logActivity(agent: string, action: string): void {
  db.prepare("INSERT INTO activity_log (agent, action) VALUES (?, ?)").run(agent, action);
}
