import { useState } from "react";
import { api, type Project, type ProjectInput } from "./api";

type ServiceRow = ProjectInput["services"] extends (infer T)[] | undefined ? T : never;

// Chip input (free-text tags) — used for stack + domains.
function Chips({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };
  return (
    <div className="row-inline" style={{ gap: 6, padding: 4, border: "1px solid var(--edge-soft)", borderRadius: 8 }}>
      {value.map((v) => (
        <span key={v} className="badge effort" style={{ cursor: "pointer" }} onClick={() => onChange(value.filter((x) => x !== v))}>
          {v} ✕
        </span>
      ))}
      <input
        style={{ flex: 1, border: 0, minWidth: 90, background: "transparent" }}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === ",") && (e.preventDefault(), add())}
        onBlur={add}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "1px solid var(--edge-soft)", padding: "8px 0" }}>
      <button className="ghost" style={{ width: "100%", textAlign: "left", border: 0 }} onClick={() => setOpen((o) => !o)}>
        <span style={{ color: "var(--cyan)" }}>{open ? "▾" : "▸"}</span> {title}
      </button>
      {open && <div style={{ padding: "8px 4px 2px" }}>{children}</div>}
    </div>
  );
}

export function ProjectModal({
  project,
  onClose,
  onSaved,
}: {
  project?: Project; // present = edit mode
  onClose: () => void;
  onSaved: () => void;
}) {
  const edit = !!project;
  const [name, setName] = useState(project?.name ?? "");
  const [status, setStatus] = useState<Project["status"]>(project?.status ?? "active");
  const [phase, setPhase] = useState(project?.phase && project.phase >= 1 ? project.phase : 1);
  const [stack, setStack] = useState<string[]>(project?.stack ? project.stack.split(/,\s*/).filter(Boolean) : []);
  const [repo, setRepo] = useState(project?.repo_url ?? "");
  const [prod, setProd] = useState(project?.prod_url ?? "");
  const [staging, setStaging] = useState(project?.staging_url ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [domains, setDomains] = useState<string[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [backup, setBackup] = useState("");
  const [ms, setMs] = useState({ version: "", title: "", target_date: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const scalars = {
        name: name.trim(),
        status,
        phase,
        stack: stack.length ? stack.join(", ") : null,
        repo_url: repo || null,
        prod_url: prod || null,
        staging_url: staging || null,
        description: description || null,
      };
      if (edit) {
        await api.updateProject(project!.id, scalars);
      } else {
        await api.createProject({
          ...scalars,
          domains: domains.length ? domains : undefined,
          services: services.filter((s) => s.name.trim()).length ? services.filter((s) => s.name.trim()) : undefined,
          backup: backup.trim() || undefined,
          milestone: ms.title.trim() ? { version: ms.version || null, title: ms.title, target_date: ms.target_date || null } : undefined,
        });
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>
          ✕
        </button>
        <h2>{edit ? `Redigera ${project!.name}` : "＋ Nytt projekt"}</h2>

        {/* step 1 — required */}
        <div className="field">
          <label>Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="unikt projektnamn" autoFocus />
        </div>
        <div className="row-inline">
          <div className="field" style={{ flex: 1 }}>
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as Project["status"])}>
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="archived">archived</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Phase (1–4)</label>
            <select value={phase} onChange={(e) => setPhase(Number(e.target.value))}>
              {[1, 2, 3, 4].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* step 2 — optional collapsible sections */}
        <div style={{ marginTop: 6 }}>
          <Section title="Teknik">
            <div className="field">
              <label>Stack (chips)</label>
              <Chips value={stack} onChange={setStack} placeholder="hono, react… (enter)" />
            </div>
            <div className="field">
              <label>Repo URL</label>
              <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/…" />
            </div>
            <div className="field">
              <label>Prod URL</label>
              <input value={prod} onChange={(e) => setProd(e.target.value)} placeholder="https://…" />
            </div>
            <div className="field">
              <label>Staging URL</label>
              <input value={staging} onChange={(e) => setStaging(e.target.value)} placeholder="https://staging…" />
            </div>
          </Section>

          <Section title="Beskrivning">
            <textarea
              style={{ width: "100%", minHeight: 70 }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Vad är projektet?"
            />
          </Section>

          {!edit && (
            <>
              <Section title="Domän (cert-bevakning)">
                <Chips value={domains} onChange={setDomains} placeholder="example.com (enter)" />
                <div className="muted" style={{ marginTop: 4 }}>Läggs i certs; utgångsdatum sätts senare.</div>
              </Section>

              <Section title="Tjänster">
                {services.map((s, i) => (
                  <div className="row-inline" key={i} style={{ marginBottom: 6 }}>
                    <input placeholder="name" value={s.name} onChange={(e) => setServices((a) => a.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} style={{ width: 90 }} />
                    <input placeholder="plan" value={s.plan ?? ""} onChange={(e) => setServices((a) => a.map((x, j) => (j === i ? { ...x, plan: e.target.value } : x)))} style={{ width: 70 }} />
                    <input placeholder="cost" type="number" value={s.cost_month ?? ""} onChange={(e) => setServices((a) => a.map((x, j) => (j === i ? { ...x, cost_month: e.target.value ? Number(e.target.value) : null } : x)))} style={{ width: 60 }} />
                    <input placeholder="cur" value={s.currency ?? ""} onChange={(e) => setServices((a) => a.map((x, j) => (j === i ? { ...x, currency: e.target.value } : x)))} style={{ width: 50 }} />
                    <input placeholder="health_url" value={s.health_url ?? ""} onChange={(e) => setServices((a) => a.map((x, j) => (j === i ? { ...x, health_url: e.target.value } : x)))} style={{ flex: 1 }} />
                    <button className="clock" onClick={() => setServices((a) => a.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                <button className="ghost" onClick={() => setServices((a) => [...a, { name: "" }])}>+ tjänst</button>
              </Section>

              <Section title="Backup">
                <input style={{ width: "100%" }} value={backup} onChange={(e) => setBackup(e.target.value)} placeholder="Supabase pg_dump → NAS" />
              </Section>

              <Section title="Första milestone">
                <div className="row-inline">
                  <input placeholder="version" value={ms.version} onChange={(e) => setMs({ ...ms, version: e.target.value })} style={{ width: 80 }} />
                  <input placeholder="title" value={ms.title} onChange={(e) => setMs({ ...ms, title: e.target.value })} style={{ flex: 1 }} />
                  <input type="date" value={ms.target_date} onChange={(e) => setMs({ ...ms, target_date: e.target.value })} />
                </div>
              </Section>
            </>
          )}
        </div>

        {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
        <div className="row-inline" style={{ marginTop: 12, justifyContent: "flex-end" }}>
          <button onClick={onClose}>Avbryt</button>
          <button className="primary" disabled={busy || !name.trim()} onClick={save}>
            {edit ? "Spara" : "Skapa projekt"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeleteProjectModal({
  project,
  onClose,
  onDeleted,
}: {
  project: Project;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.deleteProjectHard(project.id, project.name);
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: "min(440px,92vw)", borderColor: "var(--down)" }} onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>
          ✕
        </button>
        <h2 style={{ color: "var(--down)" }}>Radera {project.name} permanent</h2>
        <div className="muted" style={{ margin: "6px 0" }}>
          Detta tar bort projektet och ALLT kopplat (tasks, filer, secrets, services, incidents…). Går inte att ångra.
        </div>
        <div className="field">
          <label>Skriv projektnamnet för att bekräfta</label>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={project.name} autoFocus />
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row-inline" style={{ marginTop: 12, justifyContent: "flex-end" }}>
          <button onClick={onClose}>Avbryt</button>
          <button
            className="primary"
            style={{ background: "var(--down)" }}
            disabled={busy || typed !== project.name}
            onClick={run}
          >
            Radera permanent
          </button>
        </div>
      </div>
    </div>
  );
}
