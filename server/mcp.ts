// DevPanel — step 3: MCP server (stdio). All tools per SPEC.
// Spawned by Claude Code over stdio (NOT pm2). Every write → activity_log,
// tagged with the connecting agent's name. Secret VALUES are never exposed.
// Shared planning/ops logic lives in store.ts (the REST API mirrors it).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as store from "./store.js";
import * as files from "./files.js";

const server = new McpServer(
  { name: "devpanel", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Agent name for activity_log — taken from the MCP client identity.
function agent(): string {
  return server.server.getClientVersion()?.name ?? "ai";
}
function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// ---- tools ------------------------------------------------------------------
server.registerTool(
  "get_context",
  {
    description:
      "Full planning + ops context as markdown: projects, open tasks+deps+prio, milestones, latest health, open incidents, recent deploys, secrets metadata. Secret values are ALWAYS filtered out.",
    inputSchema: {},
  },
  async () => text(store.buildContext()),
);

server.registerTool(
  "create_task",
  {
    description: "Create a task (source=ai).",
    inputSchema: {
      project: z.string(),
      title: z.string(),
      prio: z.enum(["P0", "P1", "P2", "P3"]),
      effort: z.enum(["S", "M", "L"]).optional(),
      milestone: z.string().optional(),
    },
  },
  async ({ project, title, prio, effort, milestone }) => {
    const id = store.createTask(agent(), { project, title, prio, effort, milestone, source: "ai" });
    return text(`Created task #${id}: ${title}`);
  },
);

server.registerTool(
  "update_task",
  {
    description: "Update a task's status and/or priority.",
    inputSchema: {
      id: z.number().int(),
      status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
      prio: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    },
  },
  async ({ id, status, prio }) => {
    store.updateTask(agent(), { id, status, prio });
    return text(`Updated task #${id}`);
  },
);

server.registerTool(
  "add_dep",
  {
    description: "Add a dependency: task_id is blocked by blocks_task_id.",
    inputSchema: { task_id: z.number().int(), blocks_task_id: z.number().int() },
  },
  async ({ task_id, blocks_task_id }) => {
    store.addDep(agent(), task_id, blocks_task_id);
    return text(`Task #${task_id} now blocked by #${blocks_task_id}`);
  },
);

server.registerTool(
  "add_idea",
  {
    description: "Add an idea to the inbox.",
    inputSchema: { title: z.string(), note: z.string().optional() },
  },
  async ({ title, note }) => {
    const id = store.addIdea(agent(), title, note);
    return text(`Added idea #${id}`);
  },
);

server.registerTool(
  "add_decision",
  {
    description: "Record a decision for a project.",
    inputSchema: {
      project: z.string(),
      title: z.string(),
      body: z.string(),
      status: z.enum(["proposed", "accepted", "superseded"]),
    },
  },
  async ({ project, title, body, status }) => {
    const id = store.addDecision(agent(), { project, title, body, status });
    return text(`Recorded decision #${id}`);
  },
);

server.registerTool(
  "report_incident",
  {
    description: "Open an incident against a service.",
    inputSchema: {
      service: z.string(),
      severity: z.enum(["low", "high", "critical"]),
      title: z.string(),
    },
  },
  async ({ service, severity, title }) => {
    const id = store.reportIncident(agent(), { service, severity, title });
    return text(`Opened incident #${id}`);
  },
);

server.registerTool(
  "resolve_incident",
  {
    description: "Resolve an incident, optionally with a postmortem.",
    inputSchema: { id: z.number().int(), postmortem: z.string().optional() },
  },
  async ({ id, postmortem }) => {
    store.resolveIncident(agent(), id, postmortem);
    return text(`Resolved incident #${id}`);
  },
);

server.registerTool(
  "log_deploy",
  {
    description: "Record a deploy.",
    inputSchema: {
      project: z.string(),
      sha: z.string(),
      env: z.enum(["staging", "prod"]),
      status: z.enum(["ok", "fail"]),
    },
  },
  async ({ project, sha, env, status }) => {
    const id = store.logDeploy(agent(), { project, sha, env, status });
    return text(`Logged deploy #${id}`);
  },
);

server.registerTool(
  "get_runbook",
  {
    description: "Fetch runbook(s) for a service.",
    inputSchema: { service: z.string() },
  },
  async ({ service }) => {
    const books = store.getRunbookRows(service);
    if (!books.length) return text(`No runbook for ${service}.`);
    return text(books.map((b) => `# ${b.title}\n\n${b.body_md ?? ""}`).join("\n\n---\n\n"));
  },
);

server.registerTool(
  "get_health_history",
  {
    description: "Health history for a service over the last N hours (default 24).",
    inputSchema: { service: z.string(), hours: z.number().int().positive().default(24) },
  },
  async ({ service, hours }) => {
    const rows = store.getHealthHistoryRows(service, hours);
    if (!rows.length) return text(`No health history for ${service} in the last ${hours}h.`);
    const lines = rows.map((r) => `- ${r.ts}: ${r.status}${r.latency_ms != null ? ` ${r.latency_ms}ms` : ""}`);
    return text(`# ${service} — health, last ${hours}h\n\n${lines.join("\n")}`);
  },
);

server.registerTool(
  "list_files",
  {
    description:
      "List a project's files: id, path, mime, size. File manager only (never secrets — those live in a separate vault).",
    inputSchema: { project: z.string() },
  },
  async ({ project }) => {
    const list = files.listFilesForMcp(project);
    if (!list.length) return text(`No files in ${project}.`);
    return text(list.map((f) => `#${f.id} ${f.path} (${f.mime}, ${f.size}b)`).join("\n"));
  },
);

server.registerTool(
  "read_file",
  {
    description:
      "Read a file's latest text content. Text mimes only, max 100kb. Refuses binary/oversized files. Never secrets.",
    inputSchema: { file_id: z.number().int() },
  },
  async ({ file_id }) => {
    const f = files.readFileForMcp(file_id);
    return text(`# ${f.name} (${f.mime}, ${f.size}b)\n\n${f.content}`);
  },
);

// ---- boot -------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only — stdout is the JSON-RPC channel.
console.error("devpanel MCP server ready on stdio");
