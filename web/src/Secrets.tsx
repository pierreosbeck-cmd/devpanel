import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Project, type SecretMeta } from "./api";

// The unlock session (Bearer token) lives only in this component's state — it is
// never persisted. On close/lock we drop it and tell the API to forget it too.
export function Secrets({
  projects,
  project,
  onClose,
}: {
  projects: Project[];
  project?: string;
  onClose: () => void;
}) {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);

  useEffect(() => {
    api
      .health()
      .then((h) => setInitialized(h.initialized))
      .catch(() => setInitialized(false));
  }, []);

  // Auto-lock when the 5-minute session lapses.
  useEffect(() => {
    if (!token) return;
    const ms = expiresAt - Date.now();
    if (ms <= 0) return void lock();
    const t = setTimeout(() => lock(), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, expiresAt]);

  const lock = () => {
    if (token) api.lock(token).catch(() => {});
    setToken(null);
    setExpiresAt(0);
  };
  const close = () => {
    lock();
    onClose();
  };

  return (
    <div className="overlay" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={close}>
          ✕
        </button>
        <h2>🔒 Secrets</h2>
        {initialized === null ? (
          <div className="center">…</div>
        ) : token ? (
          <Unlocked
            token={token}
            expiresAt={expiresAt}
            projects={projects}
            project={project}
            onLock={lock}
          />
        ) : (
          <Gate
            initialized={initialized}
            onInit={() => setInitialized(true)}
            onUnlocked={(tok, exp) => {
              setToken(tok);
              setExpiresAt(new Date(exp).getTime());
            }}
          />
        )}
      </div>
    </div>
  );
}

function Gate({
  initialized,
  onInit,
  onUnlocked,
}: {
  initialized: boolean;
  onInit: () => void;
  onUnlocked: (token: string, expiresAt: string) => void;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const submit = async () => {
    setErr("");
    if (!pw) return;
    if (!initialized && pw !== pw2) return setErr("Passwords don't match.");
    setBusy(true);
    try {
      if (!initialized) {
        await api.secretsSetup(pw);
        onInit();
      }
      const s = await api.unlock(pw);
      onUnlocked(s.token, s.expires_at);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="muted">
        {initialized
          ? "Enter the master password to unlock for 5 minutes."
          : "First run — set a master password. It derives the encryption key and is never stored."}
      </p>
      <div className="field">
        <label>Master password</label>
        <input
          ref={ref}
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && initialized && submit()}
        />
      </div>
      {!initialized && (
        <div className="field">
          <label>Confirm password</label>
          <input
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <div className="row-inline" style={{ marginTop: 10 }}>
        <button className="primary" onClick={submit} disabled={busy || !pw}>
          {initialized ? "Unlock" : "Set password & unlock"}
        </button>
      </div>
    </div>
  );
}

function Unlocked({
  token,
  expiresAt,
  projects,
  project,
  onLock,
}: {
  token: string;
  expiresAt: number;
  projects: Project[];
  project?: string;
  onLock: () => void;
}) {
  const [rows, setRows] = useState<SecretMeta[]>([]);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [err, setErr] = useState("");
  const [left, setLeft] = useState(Math.max(0, expiresAt - Date.now()));

  const refresh = () =>
    api
      .secrets(project)
      .then(setRows)
      .catch((e) => setErr(e instanceof Error ? e.message : "failed"));
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // Session countdown (display only; auto-lock handled by the parent).
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, expiresAt - Date.now())), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  const mmss = useMemo(() => {
    const s = Math.ceil(left / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, [left]);

  const reveal = async (id: number) => {
    try {
      const { value } = await api.reveal(token, id);
      setRevealed((r) => ({ ...r, [id]: value }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  };
  const hide = (id: number) =>
    setRevealed((r) => {
      const n = { ...r };
      delete n[id];
      return n;
    });
  const copy = async (id: number) => {
    const value = revealed[id] ?? (await api.reveal(token, id)).value;
    await navigator.clipboard.writeText(value).catch(() => {});
  };
  const del = async (id: number, name: string) => {
    if (!confirm(`Delete secret "${name}"? This cannot be undone.`)) return;
    await api.deleteSecret(token, id);
    hide(id);
    refresh();
  };

  return (
    <div>
      <div className="row-inline" style={{ justifyContent: "space-between" }}>
        <span className="session-note">🔓 Unlocked — auto-locks in {mmss}</span>
        <button onClick={onLock}>Lock now</button>
      </div>
      {err && <div className="err">{err}</div>}
      <table className="tbl" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th>Scope</th>
            <th>Age</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td className="mono">{s.name}</td>
              <td className="mono">{revealed[s.id] ?? "••••••••"}</td>
              <td>{s.scope}</td>
              <td className={s.age_days > 90 ? "warn" : ""}>
                {s.age_days}d{s.age_days > 90 ? " ⚠" : ""}
              </td>
              <td>
                <div className="row-inline">
                  {revealed[s.id] ? (
                    <button onClick={() => hide(s.id)}>Hide</button>
                  ) : (
                    <button onClick={() => reveal(s.id)}>Show</button>
                  )}
                  <button onClick={() => copy(s.id)}>Copy</button>
                  <button onClick={() => del(s.id, s.name)} title="Delete">
                    🗑
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No secrets{project ? ` for ${project}` : ""}.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <SetSecret token={token} projects={projects} defaultProject={project} onSaved={refresh} onError={setErr} />
    </div>
  );
}

function SetSecret({
  token,
  projects,
  defaultProject,
  onSaved,
  onError,
}: {
  token: string;
  projects: Project[];
  defaultProject?: string;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [proj, setProj] = useState(defaultProject ?? projects[0]?.name ?? "");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"dev" | "prod">("dev");
  const [busy, setBusy] = useState(false);
  const project = defaultProject ?? proj;

  const save = async () => {
    if (!project || !name.trim()) return;
    setBusy(true);
    try {
      await api.putSecret(token, { project, name: name.trim(), value, scope });
      setName("");
      setValue("");
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <div className="session-note" style={{ marginBottom: 6 }}>
        Add / update a secret
      </div>
      <div className="row-inline" style={{ flexWrap: "wrap" }}>
        {!defaultProject && (
          <select value={proj} onChange={(e) => setProj(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <input placeholder="NAME" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} />
        <input
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ flex: 1, minWidth: 140 }}
        />
        <select value={scope} onChange={(e) => setScope(e.target.value as "dev" | "prod")}>
          <option value="dev">dev</option>
          <option value="prod">prod</option>
        </select>
        <button className="primary" onClick={save} disabled={busy || !name.trim() || !project}>
          Save
        </button>
      </div>
    </div>
  );
}
