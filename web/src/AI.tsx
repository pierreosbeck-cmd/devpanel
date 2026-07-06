import { useState } from "react";
import { api, type AiSuggestion } from "./api";
import { useLoader } from "./App";

export function AI({ onChange }: { onChange: () => void }) {
  const [suggestions, refetch] = useLoader<AiSuggestion[]>(() => api.suggestions("open"), []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const analyze = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.analyze();
      refetch();
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "analyze failed");
    } finally {
      setBusy(false);
    }
  };
  const after = () => {
    refetch();
    onChange();
  };

  const list = suggestions ?? [];
  return (
    <div className="grid2" style={{ gridTemplateColumns: "1fr", maxWidth: 760 }}>
      <div className="panel">
        <div className="row-inline" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>AI Suggestions</h2>
          <button className="primary" disabled={busy} onClick={analyze}>
            {busy ? "Analyzing…" : "✦ Analyze now"}
          </button>
        </div>
        {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
        {busy && <div className="muted" style={{ marginTop: 8 }}>Skickar kontext till Ollama…</div>}
        {!list.length && !busy && (
          <div className="muted" style={{ marginTop: 10 }}>
            Inga öppna förslag. Kör "Analyze now" för att be Ollama granska planen.
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          {list.map((s) => (
            <SuggestionCard key={s.id} s={s} onDone={after} onError={setErr} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SuggestionCard({
  s,
  onDone,
  onError,
}: {
  s: AiSuggestion;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };
  const payload = JSON.stringify(s.payload);
  const isQ = s.kind === "question";
  return (
    <div className="sugg">
      <div className="kind">{s.kind.replace("_", " ")}</div>
      <div style={{ margin: "3px 0 2px" }}>
        {isQ ? String((s.payload as { question?: string }).question ?? s.motivation) : s.motivation}
      </div>
      {!isQ && <div className="muted mono">{payload}</div>}
      {isQ ? (
        <div className="row-inline" style={{ marginTop: 9 }}>
          <input
            style={{ flex: 1 }}
            placeholder="Your answer…"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy || !answer.trim()}
            onClick={() => run(() => api.answerSuggestion(s.id, answer.trim()))}
          >
            Answer
          </button>
          <button disabled={busy} onClick={() => run(() => api.dismissSuggestion(s.id))}>
            Ignore
          </button>
        </div>
      ) : (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => run(() => api.acceptSuggestion(s.id))}>
            Accept
          </button>
          <button disabled={busy} onClick={() => run(() => api.dismissSuggestion(s.id))}>
            Ignore
          </button>
        </div>
      )}
    </div>
  );
}
