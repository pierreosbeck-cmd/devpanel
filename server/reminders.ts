// DevPanel v2 — reminders. The worker is the sole firing authority (fireDue,
// once a minute): it emails when the channel asks for it, then either advances a
// recurring reminder to its next occurrence or closes a one-off. UI-channel
// reminders land in 'sent' so the front end can toast/badge them until acked.
import { db, logActivity } from "./db.js";
import { projectId } from "./store.js";
import { sendMail } from "./mail.js";

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

// ---- time helpers (SQLite stores UTC 'YYYY-MM-DD HH:MM:SS') ------------------
function toUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes(),
  )}:${p(d.getUTCSeconds())}`;
}
function normalizeDue(input: string): string {
  const d = new Date(input); // accepts ISO 8601 or 'YYYY-MM-DD HH:MM'
  if (isNaN(d.getTime())) throw new Error(`invalid due_at: ${input}`);
  return toUtc(d);
}
// Next occurrence strictly in the future (skips missed slots to avoid a backlog
// storm), robust even for reminders that are years overdue.
function nextDue(dueUtc: string, rec: Exclude<Recurrence, "none">): string {
  const base = new Date(dueUtc.replace(" ", "T") + "Z");
  const now = Date.now();
  // Monthly: month lengths vary, so step (bounded high — ~8000 years).
  if (rec === "monthly") {
    const d = new Date(base);
    let i = 0;
    do d.setUTCMonth(d.getUTCMonth() + 1);
    while (d.getTime() <= now && ++i < 100_000);
    return toUtc(d);
  }
  // Daily/weekly: constant step in UTC → compute the count directly, no loop cap.
  const stepMs = (rec === "daily" ? 1 : 7) * 86_400_000;
  let t = base.getTime() + stepMs;
  if (t <= now) t += (Math.floor((now - t) / stepMs) + 1) * stepMs;
  return toUtc(new Date(t));
}

const included = (channel: Channel, part: "ui" | "email") => channel === part || channel === "both";

// ---- CRUD -------------------------------------------------------------------
export function listReminders(project?: string): Reminder[] {
  return (
    project
      ? db.prepare("SELECT * FROM reminders WHERE project_id = ? ORDER BY due_at").all(projectId(project))
      : db.prepare("SELECT * FROM reminders ORDER BY due_at").all()
  ) as Reminder[];
}

export function createReminder(
  agent: string,
  a: {
    project?: string;
    task_id?: number | null;
    title: string;
    due_at: string;
    recurrence?: Recurrence;
    channel?: Channel;
  },
): number {
  const pid = a.project ? projectId(a.project) : null;
  const id = Number(
    db
      .prepare(
        "INSERT INTO reminders (project_id, task_id, title, due_at, recurrence, channel) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(pid, a.task_id ?? null, a.title, normalizeDue(a.due_at), a.recurrence ?? "none", a.channel ?? "ui")
      .lastInsertRowid,
  );
  logActivity(agent, `create_reminder #${id} "${a.title}" @ ${normalizeDue(a.due_at)}`);
  return id;
}

export function updateReminder(
  agent: string,
  id: number,
  a: { title?: string; due_at?: string; recurrence?: Recurrence; channel?: Channel; status?: "pending" | "sent" | "done" },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (a.title != null) (sets.push("title = ?"), vals.push(a.title));
  if (a.due_at != null) (sets.push("due_at = ?"), vals.push(normalizeDue(a.due_at)));
  if (a.recurrence != null) (sets.push("recurrence = ?"), vals.push(a.recurrence));
  if (a.channel != null) (sets.push("channel = ?"), vals.push(a.channel));
  if (a.status != null) (sets.push("status = ?"), vals.push(a.status));
  if (!sets.length) throw new Error("nothing to update");
  if (!db.prepare(`UPDATE reminders SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id).changes)
    throw new Error(`unknown reminder: ${id}`);
  logActivity(agent, `update_reminder #${id}`);
}

export function deleteReminder(agent: string, id: number): void {
  if (!db.prepare("DELETE FROM reminders WHERE id = ?").run(id).changes) throw new Error(`unknown reminder: ${id}`);
  logActivity(agent, `delete_reminder #${id}`);
}

// Fired UI reminders awaiting acknowledgement — drives the badge + toast.
export function dueUiReminders(): Reminder[] {
  return db
    .prepare("SELECT * FROM reminders WHERE status = 'sent' AND channel IN ('ui','both') ORDER BY due_at")
    .all() as Reminder[];
}

// ---- worker: fire everything due, once per minute ---------------------------
export async function fireDue(agent = "worker"): Promise<number> {
  const due = db
    .prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= datetime('now') ORDER BY due_at")
    .all() as Reminder[];
  for (const r of due) {
    if (included(r.channel, "email")) {
      try {
        await sendMail({ subject: `⏰ ${r.title}`, text: `Reminder: ${r.title}\nDue: ${r.due_at} UTC` });
      } catch (e) {
        console.error(`[reminders] email failed for #${r.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    // Recurring: spawn the next occurrence as a fresh pending reminder.
    if (r.recurrence !== "none") {
      db.prepare(
        "INSERT INTO reminders (project_id, task_id, title, due_at, recurrence, channel) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(r.project_id, r.task_id, r.title, nextDue(r.due_at, r.recurrence), r.recurrence, r.channel);
    }
    // UI channel → 'sent' (awaits ack); pure email/none → 'done'.
    db.prepare("UPDATE reminders SET status = ? WHERE id = ?").run(included(r.channel, "ui") ? "sent" : "done", r.id);
    logActivity(agent, `fire_reminder #${r.id} "${r.title}" (${r.channel})`);
  }
  return due.length;
}
