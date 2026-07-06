import { useState } from "react";
import { api, type Channel, type Project, type Recurrence, type Reminder } from "./api";
import { useLoader } from "./App";

const fmt = (utc: string) => new Date(utc.replace(" ", "T") + "Z").toLocaleString([], { dateStyle: "short", timeStyle: "short" });

export function RemindersWidget({
  project,
  projects,
  due,
  refreshKey,
  onChange,
}: {
  project?: string;
  projects: Project[];
  due: Reminder[];
  refreshKey: number;
  onChange: () => void;
}) {
  const [rows, refetch] = useLoader<Reminder[]>(() => api.reminders(project), [project, refreshKey]);
  const [modal, setModal] = useState(false);
  const dueIds = new Set(due.map((r) => r.id));
  const list = (rows ?? []).filter((r) => r.status !== "done").sort((a, b) => a.due_at.localeCompare(b.due_at));

  const ack = async (id: number) => {
    await api.updateReminder(id, { status: "done" });
    refetch();
    onChange();
  };
  const del = async (id: number) => {
    await api.deleteReminder(id);
    refetch();
    onChange();
  };

  return (
    <div className="panel">
      <h2>
        Reminders {list.length > 0 && <span className="badge-count">{list.length}</span>}
      </h2>
      {list.length === 0 && <div className="muted">Inga påminnelser.</div>}
      {list.map((r) => (
        <div className={`rem ${dueIds.has(r.id) ? "dueNow" : ""}`} key={r.id}>
          <span className="dot" style={{ background: dueIds.has(r.id) ? "var(--warn)" : "var(--dimmer)" }} />
          <div style={{ flex: 1 }}>
            <div>{r.title}</div>
            <div className="when">
              {fmt(r.due_at)}
              {r.recurrence !== "none" ? ` · ${r.recurrence}` : ""} · {r.channel}
            </div>
          </div>
          <button className="clock" title="Done" onClick={() => ack(r.id)}>
            ✓
          </button>
          <button className="clock" title="Delete" onClick={() => del(r.id)}>
            ✕
          </button>
        </div>
      ))}
      <div className="add-row">
        <button className="primary" style={{ flex: 1 }} onClick={() => setModal(true)}>
          ＋ New reminder
        </button>
      </div>
      {modal && (
        <ReminderModal
          projects={projects}
          defaultProject={project}
          onClose={() => setModal(false)}
          onCreated={() => {
            setModal(false);
            refetch();
            onChange();
          }}
        />
      )}
    </div>
  );
}

// Default due = now + 1h, formatted for <input type="datetime-local"> (local tz).
function defaultLocal(): string {
  const d = new Date(Date.now() + 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ReminderModal({
  projects,
  defaultProject,
  taskId,
  taskTitle,
  onClose,
  onCreated,
}: {
  projects: Project[];
  defaultProject?: string;
  taskId?: number;
  taskTitle?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState(taskTitle ? `Follow up: ${taskTitle}` : "");
  const [when, setWhen] = useState(defaultLocal());
  const [recurrence, setRecurrence] = useState<Recurrence>("none");
  const [channel, setChannel] = useState<Channel>("ui");
  const [proj, setProj] = useState(defaultProject ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    if (!title.trim() || !when) return;
    setBusy(true);
    setErr("");
    try {
      await api.createReminder({
        project: proj || undefined,
        task_id: taskId ?? null,
        title: title.trim(),
        due_at: new Date(when).toISOString(),
        recurrence,
        channel,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: "min(460px,92vw)" }} onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>
          ✕
        </button>
        <h2>⏰ New reminder</h2>
        <div className="field">
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Remind me to…" autoFocus />
        </div>
        <div className="field">
          <label>When</label>
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        <div className="row-inline">
          <div className="field" style={{ flex: 1 }}>
            <label>Recurrence</label>
            <select value={recurrence} onChange={(e) => setRecurrence(e.target.value as Recurrence)}>
              {(["none", "daily", "weekly", "monthly"] as const).map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Channel</label>
            <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
              {(["ui", "email", "both"] as const).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
        {!defaultProject && !taskId && (
          <div className="field">
            <label>Project (optional)</label>
            <select value={proj} onChange={(e) => setProj(e.target.value)}>
              <option value="">— none —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {err && <div className="err">{err}</div>}
        <div className="row-inline" style={{ marginTop: 12, justifyContent: "flex-end" }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !title.trim()} onClick={save}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
