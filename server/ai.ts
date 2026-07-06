// DevPanel v2 — Ollama-driven planning suggestions. Ollama is LOCAL ONLY
// (127.0.0.1:11434, never exposed). We send the get_context markdown + the last
// 10 Q&A exchanges, force JSON output, validate with zod, and retry on bad JSON.
// Accepted suggestions are executed via store.ts and logged as agent 'ollama'.
import { z } from "zod";
import { db, logActivity } from "./db.js";
import * as store from "./store.js";
import { OLLAMA_URL, OLLAMA_MODEL } from "./settings.js";

const AGENT = "ollama";

const zSuggestion = z.object({
  kind: z.enum(["prioritize", "new_task", "move_task", "question"]),
  payload: z.record(z.string(), z.unknown()),
  motivation: z.string().min(1),
});
const zOutput = z.object({ suggestions: z.array(zSuggestion) });

export type Suggestion = {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  motivation: string;
  status: string;
  created_at: string;
};

const SCHEMA_PROMPT = `You are the planning assistant for DevPanel. Propose concrete, actionable improvements to the plan based ONLY on the context below.
Return ONLY JSON of the form:
{"suggestions":[{"kind":"...","payload":{...},"motivation":"one short sentence"}]}
kind and its payload:
- "prioritize": {"task_id": <int from context>, "prio": "P0"|"P1"|"P2"|"P3"}
- "new_task":   {"project": "<name from context>", "title": "<text>", "prio": "P0".."P3", "effort": "S"|"M"|"L" (optional)}
- "move_task":  {"task_id": <int from context>, "status": "todo"|"doing"|"done"|"blocked"}
- "question":   {"question": "<a clarifying question for the user>"}
Only reference task ids and project names that appear in the context. Max 5 suggestions.
If there is nothing useful to suggest, return {"suggestions":[]}.`;

// ---- Ollama HTTP ------------------------------------------------------------
export async function ollamaTags(): Promise<{ name: string }[]> {
  const res = await fetch(`${OLLAMA_URL()}/api/tags`);
  if (!res.ok) throw new Error(`Ollama /api/tags ${res.status}`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return data.models ?? [];
}

export async function ollamaStatus(): Promise<{ ok: boolean; model: string }> {
  try {
    await ollamaTags();
    return { ok: true, model: OLLAMA_MODEL() };
  } catch {
    return { ok: false, model: OLLAMA_MODEL() };
  }
}

async function generateJson(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_URL()}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL(), prompt, stream: false, format: "json", options: { temperature: 0.2 } }),
  });
  if (!res.ok) throw new Error(`Ollama /api/generate ${res.status}: ${await res.text().catch(() => "")}`);
  return ((await res.json()) as { response?: string }).response ?? "";
}

function buildPrompt(): string {
  const context = store.buildContext();
  const convos = db.prepare("SELECT question, answer FROM ai_conversations ORDER BY id DESC LIMIT 10").all() as {
    question: string;
    answer: string;
  }[];
  const qa = convos.length ? convos.reverse().map((c) => `Q: ${c.question}\nA: ${c.answer}`).join("\n") : "(none)";
  return `${SCHEMA_PROMPT}\n\nCONTEXT:\n${context}\n\nRECENT Q&A (most recent last):\n${qa}`;
}

// ---- analyze (validate + retry 2×) -----------------------------------------
export async function analyze(): Promise<Suggestion[]> {
  const base = buildPrompt();
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const prompt = attempt === 1 ? base : `${base}\n\nYour previous reply was not valid JSON for the schema. Return ONLY valid JSON.`;
    try {
      const parsed = zOutput.parse(JSON.parse(await generateJson(prompt)));
      return insertSuggestions(parsed.suggestions);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`AI analyze failed after 3 attempts: ${lastErr}`);
}

function insertSuggestions(suggestions: z.infer<typeof zSuggestion>[]): Suggestion[] {
  const ins = db.prepare("INSERT INTO ai_suggestions (kind, payload, motivation) VALUES (?, ?, ?)");
  const out: Suggestion[] = [];
  db.transaction(() => {
    for (const s of suggestions) {
      const id = Number(ins.run(s.kind, JSON.stringify(s.payload), s.motivation).lastInsertRowid);
      out.push({ id, kind: s.kind, payload: s.payload, motivation: s.motivation, status: "open", created_at: "" });
    }
  })();
  logActivity(AGENT, `ai_analyze → ${suggestions.length} suggestion(s)`);
  return out;
}

// ---- suggestion lifecycle ---------------------------------------------------
type Row = { id: number; kind: string; payload: string; motivation: string; status: string; created_at: string };

export function listSuggestions(status = "open"): Suggestion[] {
  return (db.prepare("SELECT * FROM ai_suggestions WHERE status = ? ORDER BY id DESC").all(status) as Row[]).map((r) => ({
    ...r,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  }));
}

function getSuggestion(id: number): Suggestion {
  const r = db.prepare("SELECT * FROM ai_suggestions WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new Error(`unknown suggestion: ${id}`);
  return { ...r, payload: JSON.parse(r.payload) as Record<string, unknown> };
}

// Execute the suggestion via store.ts (logs as agent 'ollama'; tasks get source='ai').
export function acceptSuggestion(id: number): void {
  const s = getSuggestion(id);
  if (s.status !== "open") throw new Error(`suggestion #${id} is already ${s.status}`);
  const p = s.payload as Record<string, string>;
  switch (s.kind) {
    case "prioritize":
      store.updateTask(AGENT, { id: Number(p.task_id), prio: p.prio as "P0" | "P1" | "P2" | "P3" });
      break;
    case "move_task":
      store.updateTask(AGENT, { id: Number(p.task_id), status: p.status as "todo" | "doing" | "done" | "blocked" });
      break;
    case "new_task":
      store.createTask(AGENT, {
        project: p.project,
        title: p.title,
        prio: p.prio as "P0" | "P1" | "P2" | "P3",
        effort: p.effort as "S" | "M" | "L" | undefined,
        source: "ai",
      });
      break;
    case "question":
      break; // answered via answerQuestion, not executed
  }
  db.prepare("UPDATE ai_suggestions SET status = 'accepted' WHERE id = ?").run(id);
  logActivity(AGENT, `accept_suggestion #${id} (${s.kind})`);
}

export function dismissSuggestion(id: number): void {
  if (!db.prepare("UPDATE ai_suggestions SET status = 'dismissed' WHERE id = ? AND status = 'open'").run(id).changes)
    throw new Error(`no open suggestion: ${id}`);
  logActivity(AGENT, `dismiss_suggestion #${id}`);
}

// The user's answer to a kind=question is stored and fed back into future prompts.
export function answerQuestion(id: number, answer: string): void {
  const s = getSuggestion(id);
  if (s.kind !== "question") throw new Error(`suggestion #${id} is not a question`);
  const q = String((s.payload as { question?: string }).question ?? s.motivation);
  db.prepare("INSERT INTO ai_conversations (question, answer) VALUES (?, ?)").run(q, answer);
  db.prepare("UPDATE ai_suggestions SET status = 'accepted' WHERE id = ?").run(id);
  logActivity(AGENT, `answer_question #${id}`);
}
