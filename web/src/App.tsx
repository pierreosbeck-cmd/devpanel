import { useCallback, useEffect, useState } from "react";
import { api, type AiStatus, type Project, type Reminder } from "./api";
import { Plan } from "./Plan";
import { Ops } from "./Ops";
import { Files } from "./Files";
import { AI } from "./AI";
import { Settings } from "./Settings";
import { Secrets } from "./Secrets";
import { RemindersWidget } from "./Reminders";
import { ProjectModal, DeleteProjectModal } from "./Projects";

type View = "plan" | "ops" | "files" | "ai" | "settings";
const NAV: { key: View; label: string; ico: string }[] = [
  { key: "plan", label: "Plan", ico: "◈" },
  { key: "ops", label: "Ops", ico: "❉" },
  { key: "files", label: "Filer", ico: "▤" },
  { key: "ai", label: "AI", ico: "✦" },
  { key: "settings", label: "Inställningar", ico: "⚙" },
];

export function App() {
  const [view, setView] = useState<View>("plan");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [mcpOk, setMcpOk] = useState<boolean | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [due, setDue] = useState<Reminder[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [openSuggestions, setOpenSuggestions] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  // project modals + gear menu
  const [projModal, setProjModal] = useState<null | "create" | Project>(null);
  const [delProj, setDelProj] = useState<Project | null>(null);
  const [gear, setGear] = useState(false);

  const refetchProjects = useCallback(() => api.projects().then(setProjects).catch(() => {}), []);
  useEffect(() => {
    refetchProjects();
  }, [refetchProjects]);

  useEffect(() => {
    const poll = () => {
      api.health().then((h) => setMcpOk(h.ok)).catch(() => setMcpOk(false));
      api.aiStatus().then(setAi).catch(() => setAi({ ok: false, model: "", auto: false }));
      api.remindersDue().then(setDue).catch(() => {});
      api.suggestions("open").then((s) => setOpenSuggestions(s.length)).catch(() => {});
    };
    poll();
    const t = setInterval(poll, 30000);
    return () => clearInterval(t);
  }, [refreshKey]);

  const proj = project || undefined;
  const selected = projects.find((p) => p.name === project);
  const toasts = due.filter((r) => !dismissed.has(r.id));

  const ackReminder = async (id: number) => {
    await api.updateReminder(id, { status: "done" }).catch(() => {});
    setDismissed((d) => new Set(d).add(id));
    bump();
  };
  const afterProjectChange = async () => {
    setProjModal(null);
    setDelProj(null);
    setGear(false);
    await refetchProjects();
  };
  const archive = async () => {
    if (selected) await api.archiveProject(selected.id).catch(() => {});
    setGear(false);
    refetchProjects();
  };

  return (
    <div className="app">
      <div className="brand">
        <span className="mark" /> DEVPANEL
      </div>

      <div className="topbar">
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name}
              {p.status !== "active" ? ` (${p.status})` : ""}
            </option>
          ))}
        </select>
        <button className="ghost" onClick={() => setProjModal("create")} title="Nytt projekt">
          ＋ Nytt projekt
        </button>
        {selected && (
          <span style={{ position: "relative" }}>
            <button className="ghost" onClick={() => setGear((g) => !g)} title="Projektinställningar">
              ⚙
            </button>
            {gear && (
              <div
                className="panel"
                style={{ position: "absolute", top: 34, left: 0, zIndex: 40, padding: 6, minWidth: 150 }}
                onMouseLeave={() => setGear(false)}
              >
                <button className="ghost" style={{ width: "100%", textAlign: "left", border: 0 }} onClick={() => (setProjModal(selected), setGear(false))}>
                  ✎ Redigera
                </button>
                <button className="ghost" style={{ width: "100%", textAlign: "left", border: 0 }} onClick={archive}>
                  🗄 Arkivera
                </button>
                <button className="ghost" style={{ width: "100%", textAlign: "left", border: 0, color: "var(--down)" }} onClick={() => (setDelProj(selected), setGear(false))}>
                  🗑 Radera…
                </button>
              </div>
            )}
          </span>
        )}
        <span className="spacer" />
        <span className="statusdot" title={mcpOk ? "API reachable" : "API unreachable"}>
          <span className={`dot ${mcpOk === null ? "" : mcpOk ? "up" : "down"}`} /> MCP
        </span>
        <span className="statusdot" title={ai?.ok ? `Ollama up · ${ai.model}` : "Ollama offline"}>
          <span className={`dot ${ai === null ? "" : ai.ok ? "up" : "down"}`} /> Ollama
        </span>
        <button onClick={() => setSecretsOpen(true)}>🔒 Secrets</button>
      </div>

      <nav className="nav">
        {NAV.map((n) => (
          <button key={n.key} className={view === n.key ? "on" : ""} onClick={() => setView(n.key)}>
            <span className="ico">{n.ico}</span>
            <span className="lbl">{n.label}</span>
            {n.key === "ai" && openSuggestions > 0 && <span className="badge-count">{openSuggestions}</span>}
          </button>
        ))}
      </nav>

      <div className="main">
        {view === "plan" && <Plan project={proj} projects={projects} onNewProject={() => setProjModal("create")} />}
        {view === "ops" && <Ops project={proj} />}
        {view === "files" && <Files project={proj} projects={projects} />}
        {view === "ai" && <AI onChange={bump} />}
        {view === "settings" && <Settings ai={ai} onChange={bump} />}
      </div>

      <aside className="aside">
        <RemindersWidget project={proj} projects={projects} due={due} refreshKey={refreshKey} onChange={bump} />
        <div className="panel">
          <h2>System</h2>
          <div className="statusdot" style={{ marginBottom: 6 }}>
            <span className={`dot ${mcpOk ? "up" : "down"}`} /> API {mcpOk ? "online" : "offline"}
          </div>
          <div className="statusdot">
            <span className={`dot ${ai?.ok ? "up" : "down"}`} /> Ollama {ai?.ok ? ai.model : "offline"}
            {ai?.auto ? " · auto" : ""}
          </div>
        </div>
      </aside>

      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((r) => (
            <div className="toast" key={r.id}>
              <span>⏰</span>
              <div>
                <div style={{ fontWeight: 600 }}>{r.title}</div>
                <div className="muted">reminder due</div>
              </div>
              <button className="x" title="Mark done" onClick={() => ackReminder(r.id)}>
                ✓
              </button>
              <button className="x" title="Dismiss" onClick={() => setDismissed((d) => new Set(d).add(r.id))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {secretsOpen && <Secrets projects={projects} project={proj} onClose={() => setSecretsOpen(false)} />}
      {projModal && (
        <ProjectModal
          project={projModal === "create" ? undefined : projModal}
          onClose={() => setProjModal(null)}
          onSaved={afterProjectChange}
        />
      )}
      {delProj && (
        <DeleteProjectModal
          project={delProj}
          onClose={() => setDelProj(null)}
          onDeleted={() => {
            if (project === delProj.name) setProject("");
            afterProjectChange();
          }}
        />
      )}
    </div>
  );
}

// Shared loader hook: run an async load, expose data + a refetch trigger.
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]): [T | undefined, () => void, unknown] {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState<unknown>();
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    load()
      .then((d) => live && setData(d))
      .catch((e) => live && setErr(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return [data, refetch, err];
}
