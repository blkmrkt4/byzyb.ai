// Payment reminder emails. Automatic ones go out a few days before a payment
// is due and as it becomes overdue, at most once per stage, only while the
// owner has them switched on. Any one can also be sent by hand.
import { getInvoice, getSetting, setSetting, audit, todayToronto, LedgerError } from './ledger.mjs';
import { reminderEmail } from './invoice-page.mjs';
import { daysBetween } from './reports.mjs';

// offset: days after the due date (negative = before).
export const STAGES = [
  { kind: 'before', offset: -3, label: '3 days before it’s due' },
  { kind: 'late1', offset: 1, label: 'The day after it’s due' },
  { kind: 'late7', offset: 7, label: 'A week overdue' },
  { kind: 'late21', offset: 21, label: 'Three weeks overdue' },
];
const RETRY_AFTER_MS = 24 * 3600 * 1000;
const MANUAL_QUIET_DAYS = 3;

export const remindersEnabled = (db) => getSetting(db, 'reminders.enabled') === '1';
export function setRemindersEnabled(db, on) {
  setSetting(db, 'reminders.enabled', on ? '1' : '0');
  audit(db, 'settings', 'reminders', on ? 'reminders_on' : 'reminders_off', {});
}

const nowIso = () => new Date().toISOString();
const ageMs = (iso, now) => now - Date.parse(iso);

// Who a reminder goes to: the saved client's email if there is one, otherwise
// the invoice's.
function recipient(db, inv) {
  const c = inv.client_id ? db.prepare('SELECT email FROM clients WHERE id = ?').get(inv.client_id) : null;
  return (c?.email || inv.client_email || '').trim();
}

// Every automatic reminder that should go out today.
export function dueReminders(db, today = todayToronto(), now = Date.now()) {
  const rows = db.prepare(`
    SELECT pl.id AS line_id, pl.suffix, pl.due_date, i.id AS invoice_id
      FROM payment_lines pl JOIN invoices i ON i.id = pl.invoice_id
     WHERE i.voided_at IS NULL AND i.sent_date IS NOT NULL AND i.reminders_off = 0 AND pl.due_date IS NOT NULL`).all();
  const past = db.prepare('SELECT kind, sent_at, error FROM reminders WHERE line_id = ?');
  const out = [];
  const invCache = new Map();
  for (const r of rows) {
    const days = daysBetween(r.due_date, today);
    const idx = STAGES.findLastIndex((s) => s.offset <= days);
    // Only the latest stage that applies is sent, so switching reminders on
    // doesn't send "due in 3 days" for something already late. A week after
    // the last stage, emails stop: by then it needs a phone call.
    if (idx < 0 || days > STAGES.at(-1).offset + 6) continue;
    const stage = STAGES[idx];
    const sent = past.all(r.line_id);
    const doneIdx = Math.max(-1, ...sent.filter((x) => !x.error).map((x) => STAGES.findIndex((s) => s.kind === x.kind)));
    if (doneIdx >= idx) continue;
    if (sent.some((x) => x.kind === stage.kind && x.error && ageMs(x.sent_at, now) < RETRY_AFTER_MS)) continue;
    if (sent.some((x) => x.kind === 'manual' && !x.error && ageMs(x.sent_at, now) < MANUAL_QUIET_DAYS * 86_400_000)) continue;
    if (!invCache.has(r.invoice_id)) invCache.set(r.invoice_id, getInvoice(db, r.invoice_id, today));
    const inv = invCache.get(r.invoice_id);
    const line = inv.lines.find((l) => l.id === r.line_id);
    if (!line || line.outstanding_cents <= 0) continue;
    const to = recipient(db, inv);
    if (!to) continue;
    out.push({
      invoice_id: inv.id, line_id: line.id, ref: line.ref, kind: stage.kind, stage: stage.label, to,
      client_name: inv.client_name, amount_cents: line.outstanding_cents, currency: inv.currency, due_date: line.due_date, days_late: days,
    });
  }
  return out.sort((a, b) => a.due_date.localeCompare(b.due_date));
}

async function deliver(db, inv, line, kind, to, { business, publicUrl, send, today }) {
  const link = `${publicUrl}/invoice/${inv.public_token}`;
  const mail = reminderEmail(inv, line, { business, link, today });
  const ins = db.prepare('INSERT INTO reminders (invoice_id, line_id, kind, sent_to, sent_at, error) VALUES (?, ?, ?, ?, ?, ?)');
  try {
    await send({ to, ...mail });
  } catch (err) {
    ins.run(inv.id, line.id, kind, to, nowIso(), err.message.slice(0, 300));
    audit(db, 'invoice', inv.id, 'reminder_failed', { line: line.ref, kind, sent_to: to, error: err.message.slice(0, 300) });
    throw err;
  }
  ins.run(inv.id, line.id, kind, to, nowIso(), null);
  audit(db, 'invoice', inv.id, 'reminder', { line: line.ref, kind, sent_to: to });
}

// Sends today's automatic reminders. Only during the working day in Toronto.
export async function runReminders(db, opts, { now = new Date(), log = console } = {}) {
  if (!remindersEnabled(db)) return { skipped: 'off' };
  const hour = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hourCycle: 'h23' }).format(now));
  if (hour < 9 || hour >= 18) return { skipped: 'outside working hours' };
  const today = todayToronto(now);
  let sent = 0, failed = 0;
  for (const r of dueReminders(db, today, now.getTime())) {
    const inv = getInvoice(db, r.invoice_id, today);
    const line = inv.lines.find((l) => l.id === r.line_id);
    try { await deliver(db, inv, line, r.kind, r.to, { ...opts, today }); sent++; } catch (err) { failed++; log.error('[ledger] reminder failed', r.ref, err.message); }
  }
  return { sent, failed };
}

// "Send a reminder now" from the invoice page. Defaults to the first payment still owing.
export async function sendManualReminder(db, invoiceId, { suffix, to } = {}, opts) {
  const today = todayToronto();
  const inv = getInvoice(db, invoiceId, today);
  if (inv.voided_at) throw new LedgerError('A void invoice can’t be chased');
  const open = inv.lines.filter((l) => l.outstanding_cents > 0);
  const line = suffix ? open.find((l) => l.suffix === Number(suffix)) : open[0];
  if (!line) throw new LedgerError('Nothing is owed on this invoice');
  const addr = String(to || recipient(db, inv)).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw new LedgerError('Add the client’s email address first');
  try {
    await deliver(db, inv, line, 'manual', addr, { ...opts, today });
  } catch (err) {
    throw new LedgerError(`The reminder didn’t send: ${err.message}`, 502);
  }
  return { sent_to: addr, ref: line.ref };
}

export function setInvoiceReminders(db, invoiceId, on) {
  const inv = db.prepare('SELECT id, reminders_off FROM invoices WHERE id = ?').get(String(invoiceId).toUpperCase());
  if (!inv) throw new LedgerError('Invoice not found', 404);
  const off = on ? 0 : 1;
  if (inv.reminders_off === off) return;
  db.prepare('UPDATE invoices SET reminders_off = ? WHERE id = ?').run(off, inv.id);
  audit(db, 'invoice', inv.id, on ? 'reminders_on' : 'reminders_off', {});
}
