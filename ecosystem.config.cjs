// pm2 process definitions — SPEC step 8. Two long-running processes:
//   devpanel-api    Hono REST + static web/dist on 127.0.0.1:8899
//   devpanel-worker health poller + daily alert cron
// The MCP server is NOT here — Claude Code spawns it over stdio on demand.
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 logs devpanel-worker
//   pm2 save            # persist across reboots (with `pm2 startup`)
const { resolve } = require("node:path");
const cwd = __dirname;
const tsx = resolve(cwd, "node_modules/.bin/tsx");

module.exports = {
  apps: [
    {
      name: "devpanel-api",
      script: tsx,
      args: "server/api.ts",
      cwd,
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
    },
    {
      name: "devpanel-worker",
      script: tsx,
      args: "worker/worker.ts",
      cwd,
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
