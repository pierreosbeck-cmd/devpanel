# DevPanel

A local project panel for SaaS builds — planning **and** ops in one place. Single
user, localhost-first, dark sci-fi/HUD UI. See [`SPEC.md`](./SPEC.md) for the full design.

A left sidebar switches between five views:

- **Plan** — kanban (Todo / Pågår / Blockerad / Klar), task cards with prio / AI /
  dependency badges, milestones, decisions, idea inbox. 🕐 on a card creates a reminder.
- **Ops** — service health grid (uptime / latency / cost), open-incident banner +
  runbooks, deploys, cert status, backup age, cost-trend sparklines.
- **Filer** — per-project file manager: folder tree, create `.txt`/`.md`, inline
  editor (save = new version), version history + restore, drag-and-drop upload,
  streamed download. Blobs live in SQLite.
- **AI** — Ollama-driven suggestions (prioritize / new task / move / question).
  Accept executes the action; questions get a free-text answer fed back as context.
- **Inställningar** — Ollama model + auto-analyze toggle, SMTP form (Gmail preset +
  test button).

Plus a **Secrets** modal (AES-256-GCM at rest, key from a master password via
argon2id — AI/MCP never see values, only `{name, scope, age}`) and a global
**reminders** widget with badge + toast for due items.

Three processes: `api` (Hono, serves the built web UI), `worker` (health poll +
daily alerts + 30-min AI auto-analyze + per-minute reminders), `mcp` (stdio,
spawned by Claude Code). One SQLite DB. Ollama runs locally (`127.0.0.1:11434`).

## Architecture

- **api** — Hono on `127.0.0.1:8899`, REST mirror of the MCP tools + secrets
  endpoints, and serves `web/dist`.
- **worker** — polls each service's `health_url` every 60s; daily cron alerts on
  cert expiry, secret age, stale backups and cost overruns (via ntfy).
- **mcp** — the same tools over stdio for Claude Code; every AI write is logged to
  `activity_log` tagged `source='ai'`.
- **web** — Vite + React SPA, built to `web/dist` and served by the api.

## Setup

```bash
# 1. config
cp .env.example .env            # tweak if needed; defaults are fine for localhost

# 2. install + build
npm install
cd web && npm install && npm run build && cd ..

# 3. run (pm2)
pm2 start ecosystem.config.cjs
pm2 save                        # persist across reboots (after `pm2 startup`)
```

Open <http://127.0.0.1:8899>. The database is created on first run at
`data/panel.db` (override with `DB_PATH`).

Dev mode with hot reload: `cd web && npm run dev` (proxies `/api` to the running
api on 8899).

## Remote access (optional)

The api binds loopback only. To reach it remotely, front it with Cloudflare
Access over a tunnel — see [`cloudflared/config.example.yml`](./cloudflared/config.example.yml).
SSH port-forwarding (`ssh -L 8899:127.0.0.1:8899 host`) also works.

## Configuration

All configuration is via `.env` (see [`.env.example`](./.env.example)) — no
hardcoded paths. Nothing secret lives in any config file; the master password is
entered at unlock time and only its derived key is held in memory, for 5 minutes.

- **Ollama** (`OLLAMA_URL`, `OLLAMA_MODEL`) — local only; auto-analyze is toggled
  at runtime in **Inställningar** (default off).
- **Email** (`SMTP_HOST/PORT/USER/PASS/FROM`) — for reminders. Prefer setting the
  password in `.env` over the UI (a UI-saved password is stored in the DB in
  plaintext, redacted only from API responses).

## Security notes

- Secret values never appear in `get_context`, logs, or API responses without an
  unlocked session.
- Bind `127.0.0.1`; expose only via Cloudflare Access or an SSH tunnel. Ollama is
  never exposed externally.
- MCP `read_file` serves text mimes only, ≤100kb, and never secrets.
- `.env`, `data/`, and tunnel credentials are git-ignored — keep them that way.
