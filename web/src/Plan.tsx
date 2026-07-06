import { useEffect, useState } from "react";
import { api, type Decision, type Idea, type Milestone, type Project, type Task, type TaskStatus } from "./api";
import { useLoader } from "./App";
import { ReminderModal } from "./Reminders";

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: "todo", label: "Todo" },
  { key: "doing", label: "Pågår" },
  { key: "blocked", label: "Blockerad" },
  { key: "done", label: "Klar" },
];
const NEXT: Record<TaskStatus, TaskStatus[]> = {
  todo: ["doing", "blocked"],
  doing: ["done", "blocked"],
  blocked: ["todo", "doing"],
  done: ["doing"],
};
const ARROW: Partial<Record<TaskStatus, string>> = { todo: "↩", doing: "▶", blocked: "⊘", done: "✓" };

export function Plan({
  project,
  projects,
  onNewProject,
}: {
  project?: string;
  projects: Project[];
  onNewProject: () => void;
}) {
  const [tasks, refetchTasks] = useLoader<Task[]>(() => api.tasks(project), [project]);
  const [milestones] = useLoader<Milestone[]>(() => api.milestones(project), [project]);
  const [ideas, refetchIdeas] = useLoader<Idea[]>(() => api.ideas(), []);
  const [decisions] = useLoader<Decision[]>(() => api.decisions(project), [project]);
  const [tab, setTab] = useState<"milestones" | "decisions">("milestones");
  const [remind, setRemind] = useState<Task | null>(null);

  const move = async (t: Task, status: TaskStatus) => {
    await api.updateTask(t.id, { status });
    refetchTasks();
  };
  const byStatus = (s: TaskStatus) => (tasks ?? []).filter((t) => t.status === s);

  // Onboarding: no projects yet → CTA instead of an empty kanban.
  if (projects.length === 0)
    return (
      <div className="center" style={{ padding: 64 }}>
        <div style={{ fontSize: 20, marginBottom: 4 }}>✦</div>
        <div style={{ fontSize: 15, color: "var(--text)", marginBottom: 6 }}>Inga projekt än</div>
        <div className="muted" style={{ marginBottom: 18 }}>Skapa ditt första projekt för att komma igång.</div>
        <button className="primary" onClick={onNewProject}>
          ＋ Skapa ditt första projekt
        </button>
      </div>
    );

  return (
    <div>
      <div className="kanban">
        {COLUMNS.map((col) => {
          const items = byStatus(col.key);
          return (
            <div className="col" key={col.key}>
              <h3>
                <span>{col.label}</span>
                <span>{items.length}</span>
              </h3>
              {items.map((t) => (
                <Card key={t.id} task={t} onMove={move} onRemind={() => setRemind(t)} />
              ))}
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 14, marginTop: 14 }}>
        <NewTask projects={projects} defaultProject={project} onCreated={refetchTasks} />
        <div className="panel">
          <div className="tabs">
            <button className={tab === "milestones" ? "on" : ""} onClick={() => setTab("milestones")}>
              Milestones
            </button>
            <button className={tab === "decisions" ? "on" : ""} onClick={() => setTab("decisions")}>
              Decisions
            </button>
          </div>
          {tab === "milestones" ? (
            <Milestones milestones={milestones ?? []} tasks={tasks ?? []} />
          ) : (
            <Decisions decisions={decisions ?? []} />
          )}
        </div>
        <div className="panel">
          <h2>Idé-inbox</h2>
          <AddIdea onAdded={refetchIdeas} />
          {(ideas ?? []).length === 0 && <div className="muted">No ideas yet.</div>}
          {(ideas ?? []).map((i) => (
            <div className="rowitem" key={i.id}>
              <div className="body">
                <div>{i.title}</div>
                {i.note && <div className="muted">{i.note}</div>}
              </div>
              <IdeaToTask idea={i} projects={projects} defaultProject={project} onCreated={refetchTasks} />
            </div>
          ))}
        </div>
      </div>

      {remind && (
        <ReminderModal
          projects={projects}
          defaultProject={project}
          taskId={remind.id}
          taskTitle={remind.title}
          onClose={() => setRemind(null)}
          onCreated={() => setRemind(null)}
        />
      )}
    </div>
  );
}

function Card({ task, onMove, onRemind }: { task: Task; onMove: (t: Task, s: TaskStatus) => void; onRemind: () => void }) {
  return (
    <div className="card">
      <div className="title">{task.title}</div>
      <div className="meta">
        <span className="id">#{task.id}</span>
        <span className={`badge ${task.prio}`}>{task.prio}</span>
        {task.effort && <span className="badge effort">{task.effort}</span>}
        {task.source === "ai" && <span className="badge ai">AI</span>}
        {task.blocked_by.length > 0 && (
          <span className="dep" title="Blocked by">
            🔗 {task.blocked_by.map((n) => `#${n}`).join(", ")}
          </span>
        )}
        <span className="row-actions">
          <button className="clock" title="Reminder" onClick={onRemind}>
            🕐
          </button>
          {NEXT[task.status].map((s) => (
            <button key={s} onClick={() => onMove(task, s)} title={`→ ${s}`}>
              {ARROW[s]}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

function Milestones({ milestones, tasks }: { milestones: Milestone[]; tasks: Task[] }) {
  if (milestones.length === 0) return <div className="muted">No milestones.</div>;
  return (
    <>
      {milestones.map((m) => {
        const mt = tasks.filter((t) => t.milestone_id === m.id);
        const done = mt.filter((t) => t.status === "done").length;
        const pct = mt.length ? Math.round((done / mt.length) * 100) : m.status === "shipped" ? 100 : 0;
        return (
          <div className="ms" key={m.id}>
            <div className="row">
              <span>
                {m.version && <b>{m.version} </b>}
                {m.title}
              </span>
              <span className="muted">{mt.length ? `${done}/${mt.length}` : m.status}</span>
            </div>
            <div className="bar">
              <span style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </>
  );
}

function Decisions({ decisions }: { decisions: Decision[] }) {
  if (decisions.length === 0) return <div className="muted">No decisions.</div>;
  return (
    <>
      {decisions.map((d) => (
        <div className="rowitem" key={d.id}>
          <div className="body">
            <div className="muted" style={{ fontSize: 10, textTransform: "uppercase" }}>{d.status}</div>
            <b>{d.title}</b>
            <div className="muted">{d.body}</div>
          </div>
        </div>
      ))}
    </>
  );
}

function NewTask({
  projects,
  defaultProject,
  onCreated,
}: {
  projects: Project[];
  defaultProject?: string;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [prio, setPrio] = useState<"P0" | "P1" | "P2" | "P3">("P2");
  const [effort, setEffort] = useState<"" | "S" | "M" | "L">("");
  const [proj, setProj] = useState(defaultProject ?? "");
  const [milestone, setMilestone] = useState("");
  const [busy, setBusy] = useState(false);
  // Prefill with the active project; force a choice when "All projects".
  useEffect(() => setProj(defaultProject ?? ""), [defaultProject]);
  const [ms] = useLoader<Milestone[]>(() => (proj ? api.milestones(proj) : Promise.resolve([])), [proj]);
  const canAdd = !!title.trim() && !!proj;

  const add = async () => {
    if (!proj) return;
    setBusy(true);
    try {
      await api.createTask({
        project: proj,
        title: title.trim(),
        prio,
        ...(effort ? { effort } : {}),
        ...(milestone ? { milestone } : {}),
      });
      setTitle("");
      setMilestone("");
      onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>New task</h2>
      <div className="field">
        <label>Title</label>
        <input placeholder="Task title…" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Project</label>
        <select value={proj} onChange={(e) => (setProj(e.target.value), setMilestone(""))}>
          <option value="">Välj projekt</option>
          {projects.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Milestone (valfri)</label>
        <select value={milestone} onChange={(e) => setMilestone(e.target.value)} disabled={!proj}>
          <option value="">—</option>
          {(ms ?? []).map((m) => (
            <option key={m.id} value={m.title}>
              {m.version ? `${m.version} ` : ""}
              {m.title}
            </option>
          ))}
        </select>
      </div>
      <div className="row-inline">
        <div className="field" style={{ flex: 1 }}>
          <label>Priority</label>
          <select value={prio} onChange={(e) => setPrio(e.target.value as typeof prio)}>
            {(["P0", "P1", "P2", "P3"] as const).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Effort</label>
          <select value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)}>
            <option value="">—</option>
            {(["S", "M", "L"] as const).map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
      </div>
      <button className="primary" style={{ width: "100%" }} disabled={!canAdd || busy} onClick={add}>
        Add task
      </button>
    </div>
  );
}

function AddIdea({ onAdded }: { onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const add = async () => {
    if (!title.trim()) return;
    await api.createIdea({ title: title.trim() });
    setTitle("");
    onAdded();
  };
  return (
    <div className="add-row">
      <input
        placeholder="Capture an idea…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      <button onClick={add} disabled={!title.trim()}>
        +
      </button>
    </div>
  );
}

function IdeaToTask({
  idea,
  projects,
  defaultProject,
  onCreated,
}: {
  idea: Idea;
  projects: Project[];
  defaultProject?: string;
  onCreated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const target = defaultProject ?? idea.project_hint ?? projects[0]?.name;
  const convert = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.createTask({ project: target, title: idea.title, prio: "P2" });
      onCreated();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button onClick={convert} disabled={busy || !target} title={target ? `→ task in ${target}` : "no project"}>
      → task
    </button>
  );
}
