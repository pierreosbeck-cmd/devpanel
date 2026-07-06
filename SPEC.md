head -5 SPEC.md

# DevPanel — SPEC v2.0

Lokal projektpanel för SaaS-byggen. Planering + drift. En användare, localhost.

> v2.0 utökar v1 med: (1) fix av Secrets "Failed to fetch", (2) filhanterare per
> projekt (BLOB i SQLite), (3) Ollama-driven AI-förslag, (4) påminnelser med
> e-post, (5) UI-omdesign enligt STYLE.md. Se **## v2.0 — Utökningar** längst ned.

## Arkitektur (låst)

- 3 processer: `api` (Hono, 127.0.0.1:8899, servar även web/dist), `worker`
  (healthcheck-poller, cron), `mcp` (stdio, spawnas av Claude Code — EJ pm2).
- SQLite, WAL, busy_timeout 5000. En DB: `<repo>/data/panel.db` (portabel default, override med `DB_PATH`).
- pm2: devpanel-api + devpanel-worker.
- Secrets: AES-256-GCM at rest, nyckel från master password (argon2id).
  AI/MCP ser ALDRIG värden — endast {name, scope, age_days}.
- Alla MCP-writes → activity_log med agent-namn.
- Alerting: ntfy vid health-statusskifte, cert <14d, nyckel >90d, backup >48h.

## Schema

projects(id, name UNIQUE, status[active|paused|archived], phase INT,
         stack, repo_url, prod_url, staging_url, description)  -- v2.1
milestones(id, project_id FK, version, title, target_date, status[open|shipped])
tasks(id, project_id FK, milestone_id FK NULL, title, status[todo|doing|done|blocked],
      prio[P0-P3], effort[S|M|L], source[manual|ai], created_at, updated_at)
task_deps(task_id FK, blocks_task_id FK, PRIMARY KEY(task_id, blocks_task_id))
ideas(id, title, note, project_hint, created_at)
decisions(id, project_id FK, title, body, status[proposed|accepted|superseded],
          task_id FK NULL, created_at)
secrets(id, project_id FK, name, value_enc BLOB, scope[dev|prod], rotated_at)
services(id, project_id FK, name, plan, cost_month REAL, currency,
         dashboard_url, health_url NULL)
health_history(id, service_id FK, status[up|down|degraded], latency_ms, ts)
incidents(id, service_id FK, severity[low|high|critical], title,
          started_at, resolved_at NULL, postmortem NULL)
deploys(id, project_id FK, sha, env[staging|prod], status[ok|fail], ts)
runbooks(id, service_id FK, title, body_md)
costs(id, service_id FK, month TEXT 'YYYY-MM', amount REAL)
backups(id, project_id FK, target, last_ok_at)
certs(id, project_id FK, domain, expires_at)
activity_log(id, agent, action, ts)

## MCP-tools

get_context()            → md: projekt, öppna tasks+deps+prio, milestones,
                           health senaste, öppna incidents, senaste deploys,
                           secrets-metadata. Filtrerar ALLTID secret-värden.
create_task(project, title, prio, effort?, milestone?)
update_task(id, status?, prio?)
add_dep(task_id, blocks_task_id)
add_idea(title, note?)
add_decision(project, title, body, status)
report_incident(service, severity, title)
resolve_incident(id, postmortem?)
log_deploy(project, sha, env, status)
get_runbook(service)
get_health_history(service, hours=24)

## Worker

- Var 60s: GET health_url per service → health_history.
- Statusskifte up↔down → ntfy + auto report_incident(critical vid prod).
- Dagligen: cert-expiry, secret-ålder, backup-ålder, kostnadsavvikelse → ntfy.

## UI — extremt enkelt, två lägen

Toppbar: [Plan | Ops] toggle + projektväljare + MCP-status-dot. Inget mer.

PLAN (en sida):
  - Kanban: Todo/Pågår/Blockerad/Klar. Task-kort: titel, prio-badge,
    AI-badge, dep-indikator (🔗 blockeras av #N).
  - Sidopanel höger: milestones med progress, AI-förslag (acceptera/ignorera),
    idé-inbox (knapp: "→ task").
  - Decisions som flik i sidopanelen.

OPS (en sida):
  - Servicegrid: status-dot, uptime 24h, latens, kostnad/mån.
  - Öppna incidents överst (röd rad) med runbook-länk.
  - Rader: senaste deploys, cert-status, backup-ålder, kostnadstrend (sparkline).

SECRETS (modal, låst): master password → 5 min session. Tabell: namn, maskerat
värde, scope, rotationsålder (⚠ >90d), Kopiera/Visa.

Designprincip: allt nås inom 1 klick från sitt läge. Inga undersidor.
Ingen inställningssida i v1 — konfig via .env.

## Byggordning

1. Schema (db.ts komplett enligt ovan)
2. crypto.ts (argon2id + AES-256-GCM) + secrets CRUD
3. mcp.ts alla tools + activity_log
4. Registrera MCP, verifiera loop i Claude Code
5. Hono API (REST spegel av MCP + secrets-endpoints, endast localhost)
6. worker (health, alerts via ntfy)
7. web/ (Vite+React, Plan/Ops/Secrets enligt ovan)
8. pm2 ecosystem + cloudflared ingress (Access-policy) om remote önskas

## Icke förhandlingsbart

- Secret-värden aldrig i get_context, loggar eller API-svar utan upplåst session.
- Bind 127.0.0.1. Remote endast via Cloudflare Access eller SSH-tunnel.
- AI-skrivningar alltid loggade och märkta source='ai'.
- Ollama nås ENDAST på 127.0.0.1:11434, aldrig exponerad externt.
- MCP read_file: endast text-mimes, max 100kb, ALDRIG secrets-filer.
- Fil-blobbar streamas (better-sqlite3 .blob()) — aldrig hela filen i minnet.
- Inga hårdkodade paths — allt via .env (.env.example uppdateras).

---

## v2.0 — Utökningar

### 1. FIX: Secrets "Failed to fetch"
- Root cause-krav: `POST /api/secrets/unlock` finns, frontend använder ENBART
  relativa `/api/...`-urls (aldrig `http://127.0.0.1:8899`).
- Härda klientens `req()`: `redirect:"manual"` → upptäck cross-origin
  Access-redirect (opaqueredirect/status 0) → full reload för re-auth. Fånga
  nätverksfel och icke-JSON-svar med tydliga meddelanden (ej rå "Failed to fetch").

### 2. Filhanterare per projekt (BLOB i SQLite)
Schema:
- `folders(id, project_id FK, parent_id FK NULL, name)`
- `files(id, project_id FK, folder_id FK NULL, name, mime, size, created_at)`
- `file_versions(id, file_id FK, version INT, blob BLOB, created_at)`

Regler: senaste version = MAX(version). Ingen storleksgräns, alla filtyper.
SQLite: `PRAGMA max_page_count` högt, `auto_vacuum=INCREMENTAL` +
`incremental_vacuum`, blob-download via streaming (better-sqlite3 `.blob()`) —
aldrig hela filen i minnet.

API (alla `?project=`-scopade läsningar):
- `GET  /api/folders?project=` , `POST /api/folders {project,name,parent_id?}` ,
  `DELETE /api/folders/:id`
- `GET  /api/files?project=` , `POST /api/files {project,name,mime,folder_id?}`
  (skapa tom, t.ex. .txt/.md) , `DELETE /api/files/:id`
- `POST /api/files/upload` (multipart) → skapar fil + v1
- `POST /api/files/:id/version {content}` → ny version (text-save)
- `GET  /api/files/:id/content` → senaste version, streamad
- `GET  /api/files/:id/versions` → lista , `POST /api/files/:id/restore {version}`

MCP-tools: `list_files(project)`, `read_file(file_id)` — endast text-mimes,
max 100kb i svar, ALDRIG secrets (filhanteraren lagrar inga secrets).

UI (läge **Filer**): filträd för AKTIVT projekt, skapa mapp/.txt/.md,
inline-editor för text/md (spara = ny version), versionshistorik-dropdown +
restore, ladda-ner-knapp, drag-and-drop upload.

### 3. Ollama-integration (AI-förslag)
- Ollama lokalt `http://127.0.0.1:11434`, ALDRIG externt.
- `.env`: `OLLAMA_URL`, `OLLAMA_MODEL=qwen2.5:7b`.
- Settings-tabell: `settings(key TEXT PRIMARY KEY, value TEXT)`. UI-modellväljare
  (dropdown, listar via `GET /api/tags` → proxar Ollama `/api/tags`), sparas i
  `settings`. Toggle `ai_auto=on|off`.
- Worker: var 30 min om `ai_auto=on` + manuell "Analysera nu"
  (`POST /api/ai/analyze`): skicka get_context-md till Ollama med strikt
  JSON-schema-prompt → validera med zod → retry 2× vid ogiltig JSON.
- Output-schema: `suggestion(kind[prioritize|new_task|move_task|question],
  payload, motivation)` → `ai_suggestions(id, kind, payload JSON, motivation,
  status[open|accepted|dismissed], created_at)`.
- `ai_conversations(id, question, answer, created_at)` — senaste 10 utbyten
  återförs som kontext. `kind=question` renderas som fråga + fritextsvar.
- Accepterade förslag exekveras (skapa/flytta/omprioritera task) och loggas i
  `activity_log` med `agent='ollama'`, tasks `source='ai'`.
- API: `GET /api/ai/suggestions`, `POST /api/ai/suggestions/:id/accept`,
  `POST /api/ai/suggestions/:id/dismiss`, `POST /api/ai/answer {id,text}`.

### 4. Påminnelser
Schema: `reminders(id, project_id FK NULL, task_id FK NULL, title, due_at TEXT,
recurrence[none|daily|weekly|monthly], channel[ui|email|both],
status[pending|sent|done])`.
- Worker: kolla varje minut, skicka vid `due_at`; recurrence → schemalägg nästa,
  annars `status=done`.
- E-post: nodemailer. `.env`: `SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
  SMTP_FROM`. Settings-UI: SMTP-formulär, preset "Gmail"
  (smtp.gmail.com:587, hint app-password) + "Egen", Test-knapp
  (`POST /api/reminders/test-email`).
- API: `GET /api/reminders?project=`, `POST /api/reminders`,
  `PATCH /api/reminders/:id`, `DELETE /api/reminders/:id`.
- UI: skapa från task-kort (klock-ikon) eller fristående (datum/tid, recurrence,
  kanal). UI-notis: badge + toast för `channel` innehållande `ui`.

### 5. UI-omdesign enligt STYLE.md
Mörkt sci-fi/HUD-tema, glassmorphism-kort (`rgba(15,20,35,.6)`, 1px cyan-kant låg
opacitet), accenter `#22D3EE`/`#A855F7`, statusfärger enligt STYLE.md, Inter,
VERSALA sektionsrubriker med letter-spacing, glow på aktiva element,
radius 8–16px, bakgrund `#05070D`–`#0B0F1A`.
Layout: **vänster sidomeny** (Plan / Ops / Filer / AI / Inställningar) + mittkolumn
+ höger widgetkolumn. Toppbar: MCP-dot + Ollama-dot. Task-kort behåller
prio-badge, AI-badge, dep-indikator.

### v2.0 byggordning
1. Fix secrets → 2. Filer (schema+API) → 3. Ollama → 4. Påminnelser →
2-UI + 5-omdesign tillsammans → uppdatera README. Commit per steg.
