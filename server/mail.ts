// DevPanel v2 — SMTP email via nodemailer for reminders. Config resolves from
// settings (UI form) first, then .env. Note: an SMTP password saved via the UI
// lives in the settings table in plaintext (redacted only from API responses) —
// same trust level as .env on this host. Prefer .env for the password if unsure.
import nodemailer from "nodemailer";
import { getSetting } from "./settings.js";

type Smtp = { host: string; port: number; user: string; pass: string; from: string };

function cfg(): Smtp {
  const g = (key: string, env: string) => getSetting(key) || process.env[env] || "";
  return {
    host: g("smtp_host", "SMTP_HOST"),
    port: Number(g("smtp_port", "SMTP_PORT") || 587),
    user: g("smtp_user", "SMTP_USER"),
    pass: g("smtp_pass", "SMTP_PASS"),
    from: g("smtp_from", "SMTP_FROM"),
  };
}

export function smtpConfigured(): boolean {
  const c = cfg();
  return Boolean(c.host && (c.from || c.user));
}

export async function sendMail(opts: { to?: string; subject: string; text: string }): Promise<void> {
  const c = cfg();
  if (!c.host) throw new Error("SMTP not configured — set smtp_host/smtp_from in Settings (or .env)");
  const from = c.from || c.user;
  const to = opts.to || from;
  if (!to) throw new Error("no recipient — set smtp_from");
  const transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  });
  await transport.sendMail({ from, to, subject: opts.subject, text: opts.text });
}
