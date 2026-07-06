// Thin typed client over the Hono API. Reads are session-free; secret VALUE
// operations carry a Bearer token from the 5-minute unlock session.

export type Project = {
  id: number;
  name: string;
  status: "active" | "paused" | "archived";
  phase: number;
  stack: string | null;
  repo_url: string | null;
  prod_url: string | null;
  staging_url: string | null;
  description: string | null;
};

export type ProjectInput = {
  name: string;
  status?: "active" | "paused" | "archived";
  phase?: number;
  stack?: string | null;
  repo_url?: string | null;
  prod_url?: string | null;
  staging_url?: string | null;
  description?: string | null;
  domains?: string[];
  services?: { name: string; plan?: string | null; cost_month?: number | null; currency?: string | null; dashboard_url?: string | null; health_url?: string | null }[];
  backup?: string | null;
  milestone?: { version?: string | null; title: string; target_date?: string | null };
};

export type TaskStatus = "todo" | "doing" | "done" | "blocked";
export type Prio = "P0" | "P1" | "P2" | "P3";
export type Task = {
  id: number;
  project_id: number;
  milestone_id: number | null;
  title: string;
  status: TaskStatus;
  prio: Prio;
  effort: "S" | "M" | "L" | null;
  source: "manual" | "ai";
  created_at: string;
  updated_at: string;
  blocked_by: number[];
};

export type Milestone = {
  id: number;
  project_id: number;
  version: string | null;
  title: string;
  target_date: string | null;
  status: "open" | "shipped";
};

export type Idea = { id: number; title: string; note: string | null; project_hint: string | null; created_at: string };

export type Decision = {
  id: number;
  project_id: number;
  title: string;
  body: string;
  status: "proposed" | "accepted" | "superseded";
  task_id: number | null;
  created_at: string;
};

export type Health = { status: "up" | "down" | "degraded"; latency_ms: number; ts: string } | null;
export type Service = {
  id: number;
  project_id: number;
  name: string;
  plan: string | null;
  cost_month: number | null;
  currency: string | null;
  dashboard_url: string | null;
  health_url: string | null;
  health: Health;
};

export type Incident = {
  id: number;
  service_id: number;
  service: string;
  severity: "low" | "high" | "critical";
  title: string;
  started_at: string;
  resolved_at: string | null;
  postmortem: string | null;
};

export type Deploy = {
  id: number;
  project_id: number;
  sha: string;
  env: "staging" | "prod";
  status: "ok" | "fail";
  ts: string;
};

export type Cert = { id: number; project_id: number; domain: string; expires_at: string | null };
export type Backup = { id: number; project_id: number; target: string; last_ok_at: string | null };
export type Cost = { id: number; service_id: number; service: string; month: string; amount: number };

export type HealthSample = { status: "up" | "down" | "degraded"; latency_ms: number; ts: string };
export type Runbook = { id: number; service_id: number; title: string; body_md: string };
export type SecretMeta = { id: number; name: string; scope: "dev" | "prod"; age_days: number };

// v2
export type Folder = { id: number; project_id: number; parent_id: number | null; name: string };
export type FileMeta = {
  id: number;
  project_id: number;
  folder_id: number | null;
  name: string;
  mime: string;
  size: number;
  created_at: string;
};
export type FileVersion = { id: number; version: number; size: number; created_at: string };
export type AiKind = "prioritize" | "new_task" | "move_task" | "question";
export type AiSuggestion = {
  id: number;
  kind: AiKind;
  payload: Record<string, unknown>;
  motivation: string;
  status: string;
  created_at: string;
};
export type AiStatus = { ok: boolean; model: string; auto: boolean };
export type Recurrence = "none" | "daily" | "weekly" | "monthly";
export type Channel = "ui" | "email" | "both";
export type Reminder = {
  id: number;
  project_id: number | null;
  task_id: number | null;
  title: string;
  due_at: string;
  recurrence: Recurrence;
  channel: Channel;
  status: "pending" | "sent" | "done";
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // All URLs are RELATIVE (same-origin) so cookies (incl. the Cloudflare Access
  // session) are always sent and there is never a mixed-content block.
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      // Don't let the browser follow a cross-origin Access login redirect into a
      // CORS wall (that surfaces as an opaque "Failed to fetch"). Catch it below.
      redirect: "manual",
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error(`Kan inte nå ${path} — är API:t igång och är du inloggad?`);
  }
  // Cloudflare Access (or any auth proxy) bounced us to a login page: the session
  // expired. Re-run the full-page auth flow by reloading.
  if (res.type === "opaqueredirect" || res.status === 0) {
    window.location.reload();
    throw new Error("Sessionen har gått ut — laddar om för att logga in igen.");
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // A non-JSON body (HTML error/login page) — don't leak "Unexpected token <".
    throw new Error(`Oväntat svar från ${path} (HTTP ${res.status}).`);
  }
  if (!res.ok) throw new Error((data as { error?: string })?.error || `${res.status} ${res.statusText}`);
  return data as T;
}

const q = (project?: string) => (project ? `?project=${encodeURIComponent(project)}` : "");
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export const api = {
  health: () => req<{ ok: boolean; initialized: boolean }>("/api/health"),
  projects: () => req<Project[]>("/api/projects"),
  createProject: (b: ProjectInput) => req<{ id: number }>("/api/projects", { method: "POST", body: JSON.stringify(b) }),
  updateProject: (id: number, b: Partial<Omit<ProjectInput, "domains" | "services" | "backup" | "milestone">>) =>
    req<{ ok: true }>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  archiveProject: (id: number) => req<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" }),
  deleteProjectHard: (id: number, name: string) =>
    req<{ ok: true }>(`/api/projects/${id}?hard=1&name=${encodeURIComponent(name)}`, { method: "DELETE" }),

  tasks: (project?: string) => req<Task[]>(`/api/tasks${q(project)}`),
  createTask: (b: { project: string; title: string; prio: Prio; effort?: "S" | "M" | "L"; milestone?: string }) =>
    req<{ id: number }>("/api/tasks", { method: "POST", body: JSON.stringify(b) }),
  updateTask: (id: number, b: { status?: TaskStatus; prio?: Prio }) =>
    req<{ ok: true }>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(b) }),

  milestones: (project?: string) => req<Milestone[]>(`/api/milestones${q(project)}`),
  ideas: () => req<Idea[]>("/api/ideas"),
  createIdea: (b: { title: string; note?: string }) =>
    req<{ id: number }>("/api/ideas", { method: "POST", body: JSON.stringify(b) }),
  decisions: (project?: string) => req<Decision[]>(`/api/decisions${q(project)}`),

  services: (project?: string) => req<Service[]>(`/api/services${q(project)}`),
  incidents: (openOnly = false) => req<Incident[]>(`/api/incidents${openOnly ? "?open=1" : ""}`),
  resolveIncident: (id: number, postmortem?: string) =>
    req<{ ok: true }>(`/api/incidents/${id}/resolve`, { method: "POST", body: JSON.stringify({ postmortem }) }),
  deploys: (project?: string) => req<Deploy[]>(`/api/deploys${q(project)}`),
  healthHistory: (service: string, hours = 24) =>
    req<HealthSample[]>(`/api/health-history/${encodeURIComponent(service)}?hours=${hours}`),
  runbooks: (service: string) => req<Runbook[]>(`/api/runbooks/${encodeURIComponent(service)}`),
  certs: (project?: string) => req<Cert[]>(`/api/certs${q(project)}`),
  backups: (project?: string) => req<Backup[]>(`/api/backups${q(project)}`),
  costs: (project?: string) => req<Cost[]>(`/api/costs${q(project)}`),

  // secrets
  secrets: (project?: string) => req<SecretMeta[]>(`/api/secrets${q(project)}`),
  secretsSetup: (password: string) =>
    req<{ ok: true }>("/api/secrets/setup", { method: "POST", body: JSON.stringify({ password }) }),
  unlock: (password: string) =>
    req<{ token: string; expires_at: string }>("/api/secrets/unlock", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  lock: (token: string) => req<{ ok: true }>("/api/secrets/lock", { method: "POST", headers: auth(token) }),
  putSecret: (token: string, b: { project: string; name: string; value: string; scope: "dev" | "prod" }) =>
    req<{ ok: true }>("/api/secrets", { method: "POST", headers: auth(token), body: JSON.stringify(b) }),
  reveal: (token: string, id: number) =>
    req<{ value: string }>(`/api/secrets/${id}/reveal`, { method: "POST", headers: auth(token) }),
  deleteSecret: (token: string, id: number) =>
    req<{ ok: true }>(`/api/secrets/${id}`, { method: "DELETE", headers: auth(token) }),

  // ---- files (v2) ----
  folders: (project?: string) => req<Folder[]>(`/api/folders${q(project)}`),
  createFolder: (b: { project: string; name: string; parent_id?: number | null }) =>
    req<{ id: number }>("/api/folders", { method: "POST", body: JSON.stringify(b) }),
  deleteFolder: (id: number) => req<{ ok: true }>(`/api/folders/${id}`, { method: "DELETE" }),
  files: (project?: string) => req<FileMeta[]>(`/api/files${q(project)}`),
  createFileItem: (b: { project: string; name: string; mime: string; folder_id?: number | null }) =>
    req<{ id: number }>("/api/files", { method: "POST", body: JSON.stringify(b) }),
  deleteFile: (id: number) => req<{ ok: true }>(`/api/files/${id}`, { method: "DELETE" }),
  saveFileVersion: (id: number, content: string) =>
    req<{ version: number }>(`/api/files/${id}/version`, { method: "POST", body: JSON.stringify({ content }) }),
  fileVersions: (id: number) => req<FileVersion[]>(`/api/files/${id}/versions`),
  restoreVersion: (id: number, version: number) =>
    req<{ version: number }>(`/api/files/${id}/restore`, { method: "POST", body: JSON.stringify({ version }) }),
  fileContentUrl: (id: number) => `/api/files/${id}/content`,
  readFileText: async (id: number): Promise<string> => {
    const res = await fetch(`/api/files/${id}/content`, { redirect: "manual" });
    if (res.type === "opaqueredirect") {
      window.location.reload();
      throw new Error("re-auth");
    }
    return res.text();
  },
  uploadFile: async (project: string, file: File, folderId?: number | null): Promise<{ id: number; size: number }> => {
    const fd = new FormData();
    fd.append("project", project);
    if (folderId != null) fd.append("folder_id", String(folderId));
    fd.append("file", file);
    const res = await fetch("/api/files/upload", { method: "POST", body: fd, redirect: "manual" });
    if (res.type === "opaqueredirect") {
      window.location.reload();
      throw new Error("re-auth");
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },

  // ---- AI (v2) ----
  tags: () => req<{ models: { name: string }[] }>("/api/tags"),
  aiStatus: () => req<AiStatus>("/api/ai/status"),
  suggestions: (status?: string) =>
    req<AiSuggestion[]>(`/api/ai/suggestions${status ? `?status=${status}` : ""}`),
  analyze: () => req<{ suggestions: AiSuggestion[] }>("/api/ai/analyze", { method: "POST" }),
  acceptSuggestion: (id: number) => req<{ ok: true }>(`/api/ai/suggestions/${id}/accept`, { method: "POST" }),
  dismissSuggestion: (id: number) => req<{ ok: true }>(`/api/ai/suggestions/${id}/dismiss`, { method: "POST" }),
  answerSuggestion: (id: number, text: string) =>
    req<{ ok: true }>("/api/ai/answer", { method: "POST", body: JSON.stringify({ id, text }) }),

  // ---- settings (v2) ----
  settings: () => req<Record<string, string>>("/api/settings"),
  setSetting: (key: string, value: string) =>
    req<{ ok: true }>("/api/settings", { method: "POST", body: JSON.stringify({ key, value }) }),

  // ---- reminders (v2) ----
  reminders: (project?: string) => req<Reminder[]>(`/api/reminders${q(project)}`),
  remindersDue: () => req<Reminder[]>("/api/reminders/due"),
  smtpStatus: () => req<{ configured: boolean }>("/api/reminders/smtp"),
  createReminder: (b: {
    project?: string;
    task_id?: number | null;
    title: string;
    due_at: string;
    recurrence?: Recurrence;
    channel?: Channel;
  }) => req<{ id: number }>("/api/reminders", { method: "POST", body: JSON.stringify(b) }),
  updateReminder: (id: number, b: Partial<Pick<Reminder, "title" | "due_at" | "recurrence" | "channel" | "status">>) =>
    req<{ ok: true }>(`/api/reminders/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteReminder: (id: number) => req<{ ok: true }>(`/api/reminders/${id}`, { method: "DELETE" }),
  testEmail: (to?: string) => req<{ ok: true }>("/api/reminders/test-email", { method: "POST", body: JSON.stringify(to ? { to } : {}) }),
};
