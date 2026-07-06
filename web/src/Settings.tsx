import { useEffect, useState } from "react";
import { api, type AiStatus } from "./api";
import { useLoader } from "./App";

export function Settings({ ai, onChange }: { ai: AiStatus | null; onChange: () => void }) {
  const [settings, refetch] = useLoader<Record<string, string>>(() => api.settings(), []);
  const [tags] = useLoader<{ models: { name: string }[] }>(() => api.tags().catch(() => ({ models: [] })), []);
  const s = settings ?? {};

  return (
    <div className="grid2" style={{ maxWidth: 900 }}>
      <OllamaCard ai={ai} models={tags?.models ?? []} settings={s} onSaved={() => (refetch(), onChange())} />
      <SmtpCard settings={s} onSaved={() => (refetch(), onChange())} />
    </div>
  );
}

function OllamaCard({
  ai,
  models,
  settings,
  onSaved,
}: {
  ai: AiStatus | null;
  models: { name: string }[];
  settings: Record<string, string>;
  onSaved: () => void;
}) {
  const auto = settings.ai_auto === "on";
  const set = async (key: string, value: string) => {
    await api.setSetting(key, value);
    onSaved();
  };
  const options = models.length ? models.map((m) => m.name) : ai?.model ? [ai.model] : [];
  return (
    <div className="panel">
      <h2>Ollama</h2>
      <div className="statusdot" style={{ marginBottom: 10 }}>
        <span className={`dot ${ai?.ok ? "up" : "down"}`} /> {ai?.ok ? `online · ${ai.model}` : "offline (start Ollama)"}
      </div>
      <div className="field">
        <label>Model</label>
        <select value={ai?.model ?? ""} onChange={(e) => set("ollama_model", e.target.value)}>
          {!options.includes(ai?.model ?? "") && ai?.model && <option>{ai.model}</option>}
          {options.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </div>
      <div className="row-inline" style={{ marginTop: 8 }}>
        <div className={`switch ${auto ? "on" : ""}`} onClick={() => set("ai_auto", auto ? "off" : "on")} />
        <div>
          <div>Auto-analyze</div>
          <div className="muted">Kör var 30:e minut i workern {auto ? "(på)" : "(av)"}</div>
        </div>
      </div>
    </div>
  );
}

const GMAIL = { smtp_host: "smtp.gmail.com", smtp_port: "587" };

function SmtpCard({ settings, onSaved }: { settings: Record<string, string>; onSaved: () => void }) {
  const [form, setForm] = useState({ smtp_host: "", smtp_port: "587", smtp_user: "", smtp_pass: "", smtp_from: "" });
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm((f) => ({
      ...f,
      smtp_host: settings.smtp_host || "",
      smtp_port: settings.smtp_port || "587",
      smtp_user: settings.smtp_user || "",
      smtp_from: settings.smtp_from || "",
      smtp_pass: settings.smtp_pass ? "••••••" : "", // redacted marker from server
    }));
  }, [settings]);

  const upd = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    setBusy(true);
    setMsg({});
    try {
      for (const [k, v] of Object.entries(form)) {
        if (k === "smtp_pass" && v === "••••••") continue; // unchanged redacted → skip
        await api.setSetting(k, v);
      }
      setMsg({ ok: "Sparat." });
      onSaved();
    } catch (e) {
      setMsg({ err: e instanceof Error ? e.message : "failed" });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setMsg({});
    try {
      await api.testEmail();
      setMsg({ ok: "Testmail skickat ✅" });
    } catch (e) {
      setMsg({ err: e instanceof Error ? e.message : "failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Email (SMTP)</h2>
      <div className="row-inline" style={{ marginBottom: 8 }}>
        <button className="ghost" onClick={() => setForm((f) => ({ ...f, ...GMAIL }))}>
          Gmail preset
        </button>
        <button className="ghost" onClick={() => setForm((f) => ({ ...f, smtp_host: "", smtp_port: "587" }))}>
          Egen
        </button>
        <span className="muted">Gmail → app password</span>
      </div>
      {(["smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from"] as const).map((k) => (
        <div className="field" key={k}>
          <label>{k.replace("smtp_", "")}</label>
          <input
            type={k === "smtp_pass" ? "password" : "text"}
            value={form[k]}
            onChange={(e) => upd(k, e.target.value)}
            placeholder={k === "smtp_from" ? "you@example.com" : ""}
          />
        </div>
      ))}
      {msg.ok && <div className="ok">{msg.ok}</div>}
      {msg.err && <div className="err">{msg.err}</div>}
      <div className="row-inline" style={{ marginTop: 10, justifyContent: "flex-end" }}>
        <button disabled={busy} onClick={test}>
          Send test
        </button>
        <button className="primary" disabled={busy} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
