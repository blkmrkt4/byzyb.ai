import { tx } from './db.mjs';
import { randomInvoiceId, isInvoiceId, lineRef, findRefs } from './ids.mjs';

export const HST_RATE = 0.13;
export const SCHEDULES = ['one_time', 'monthly', 'annual'];
export const SENT_VIA = ['stripe', 'email', 'other'];
export const MANUAL_METHODS = ['e-transfer', 'cheque', 'cash', 'other'];
export const STATUSES = ['Draft', 'Sent', 'Partly paid', 'Paid', 'Overdue', 'Void'];

export class LedgerError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const nowIso = () => new Date().toISOString();

export function todayToronto(d = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(d);
}

export function audit(db, entity, entityId, action, detail = {}) {
  db.prepare('INSERT INTO audit_log (at, entity, entity_id, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(nowIso(), entity, String(entityId), action, JSON.stringify(detail));
}

// ---------- money and schedule ----------

function cents(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new LedgerError(`${field} must be a whole number of cents`);
  return n;
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

export function computeTotals({ line_items = [], subtotal_cents, hst_enabled = true }) {
  const items = (line_items || [])
    .map((i) => ({ description: String(i.description || '').trim(), amount_cents: cents(i.amount_cents ?? 0, 'Line item amount') }))
    .filter((i) => i.description || i.amount_cents);
  const subtotal = items.length ? items.reduce((a, i) => a + i.amount_cents, 0) : cents(subtotal_cents, 'Subtotal');
  const hst = hst_enabled ? Math.round(subtotal * HST_RATE) : 0;
  return { line_items: items, subtotal_cents: subtotal, hst_cents: hst, total_cents: subtotal + hst };
}

export function addInterval(date, schedule, n) {
  if (n === 0 || schedule === 'one_time') return date;
  const [y, m, d] = date.split('-').map(Number);
  const months = schedule === 'monthly' ? n : n * 12;
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// Split the total evenly; any leftover cents go on the first payment.
export function buildSchedule({ total_cents, schedule, count, first_due }) {
  if (!SCHEDULES.includes(schedule)) throw new LedgerError('Schedule must be one-time, monthly or annual');
  const n = schedule === 'one_time' ? 1 : Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 120) throw new LedgerError('Number of payments must be between 1 and 120');
  if (!isDate(first_due)) throw new LedgerError('First due date is required');
  const base = Math.floor(total_cents / n);
  const rest = total_cents - base * n;
  return Array.from({ length: n }, (_, i) => ({
    suffix: i + 1,
    amount_cents: base + (i === 0 ? rest : 0),
    due_date: addInterval(first_due, schedule, i),
  }));
}

function normaliseLines(lines, total) {
  if (!Array.isArray(lines) || !lines.length) throw new LedgerError('At least one payment is required');
  if (lines.length > 120) throw new LedgerError('Too many payments');
  const out = lines.map((l, i) => {
    if (!isDate(l.due_date)) throw new LedgerError(`Payment ${i + 1} needs a due date`);
    return { suffix: i + 1, amount_cents: cents(l.amount_cents, `Payment ${i + 1} amount`), due_date: l.due_date };
  });
  const sum = out.reduce((a, l) => a + l.amount_cents, 0);
  if (sum !== total) throw new LedgerError(`Payments add up to ${sum / 100} but the total is ${total / 100}`);
  return out;
}

// ---------- reading ----------

function lineRows(db, invoiceId) {
  return db.prepare(`
    SELECT pl.*,
           COALESCE(SUM(p.amount_cents), 0) AS paid_cents,
           MAX(p.received_at)               AS paid_at
      FROM payment_lines pl
      LEFT JOIN payments p ON p.payment_line_id = pl.id AND p.ignored_at IS NULL
     WHERE pl.invoice_id = ?
     GROUP BY pl.id
     ORDER BY pl.suffix`).all(invoiceId);
}

export function invoiceStatus(inv, lines, today = todayToronto()) {
  if (inv.voided_at) return 'Void';
  const paid = lines.reduce((a, l) => a + l.paid_cents, 0);
  if (lines.length && lines.every((l) => l.paid_cents >= l.amount_cents)) return 'Paid';
  if (!inv.sent_date) return paid > 0 ? 'Partly paid' : 'Draft';
  if (lines.some((l) => l.paid_cents < l.amount_cents && l.due_date < today)) return 'Overdue';
  return paid > 0 ? 'Partly paid' : 'Sent';
}

function summarise(inv, lines, today) {
  const paid = lines.reduce((a, l) => a + l.paid_cents, 0);
  return {
    ...inv,
    hst_enabled: !!inv.hst_enabled,
    line_items: JSON.parse(inv.line_items || '[]'),
    paid_cents: paid,
    outstanding_cents: inv.voided_at ? 0 : Math.max(inv.total_cents - paid, 0),
    status: invoiceStatus(inv, lines, today),
    payment_count: lines.length,
  };
}

export function listInvoices(db, { status, client, q } = {}, today = todayToronto()) {
  const invoices = db.prepare('SELECT * FROM invoices ORDER BY issue_date DESC, created_at DESC').all();
  const allLines = db.prepare(`
    SELECT pl.*, COALESCE(SUM(p.amount_cents), 0) AS paid_cents
      FROM payment_lines pl
      LEFT JOIN payments p ON p.payment_line_id = pl.id AND p.ignored_at IS NULL
     GROUP BY pl.id`).all();
  const byInvoice = new Map();
  for (const l of allLines) {
    if (!byInvoice.has(l.invoice_id)) byInvoice.set(l.invoice_id, []);
    byInvoice.get(l.invoice_id).push(l);
  }
  const needle = String(q || '').trim().toLowerCase();
  return invoices
    .map((inv) => summarise(inv, byInvoice.get(inv.id) || [], today))
    .filter((inv) => !status || inv.status === status)
    .filter((inv) => !client || inv.client_name === client)
    .filter((inv) => !needle
      || inv.id.toLowerCase().includes(needle.replace(/-\d{2}$/, ''))
      || inv.client_name.toLowerCase().includes(needle)
      || inv.client_email.toLowerCase().includes(needle));
}

export function getInvoice(db, id, today = todayToronto()) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(String(id).toUpperCase());
  if (!inv) throw new LedgerError('Invoice not found', 404);
  const lines = lineRows(db, inv.id);
  const payments = db.prepare(`
    SELECT p.* FROM payments p JOIN payment_lines pl ON pl.id = p.payment_line_id
     WHERE pl.invoice_id = ? ORDER BY p.received_at`).all(inv.id);
  const history = db.prepare(`
    SELECT * FROM audit_log
     WHERE (entity = 'invoice' AND entity_id = ?)
        OR (entity = 'payment' AND entity_id IN (
              SELECT CAST(p.id AS TEXT) FROM payments p
                JOIN payment_lines pl ON pl.id = p.payment_line_id
               WHERE pl.invoice_id = ?))
     ORDER BY id DESC`).all(inv.id, inv.id);
  return {
    ...summarise(inv, lines, today),
    lines: lines.map((l) => ({
      ...l,
      ref: lineRef(inv.id, l.suffix),
      outstanding_cents: Math.max(l.amount_cents - l.paid_cents, 0),
      payments: payments.filter((p) => p.payment_line_id === l.id).map(publicPayment),
    })),
    history: history.map((h) => ({ ...h, detail: JSON.parse(h.detail) })),
  };
}

export function listClients(db) {
  return db.prepare('SELECT DISTINCT client_name FROM invoices ORDER BY client_name COLLATE NOCASE').all().map((r) => r.client_name);
}

// Payment lines that can still take money, for assigning unmatched payments.
export function openLines(db) {
  return db.prepare(`
    SELECT pl.id, pl.invoice_id, pl.suffix, pl.amount_cents, pl.due_date,
           i.client_name, i.currency, COALESCE(SUM(p.amount_cents), 0) AS paid_cents
      FROM payment_lines pl
      JOIN invoices i ON i.id = pl.invoice_id AND i.voided_at IS NULL
      LEFT JOIN payments p ON p.payment_line_id = pl.id AND p.ignored_at IS NULL
     GROUP BY pl.id
    HAVING paid_cents < pl.amount_cents
     ORDER BY pl.invoice_id, pl.suffix`).all()
    .map((l) => ({ ...l, ref: lineRef(l.invoice_id, l.suffix) }));
}

function publicPayment(p) {
  return { ...p, metadata: JSON.parse(p.metadata || '{}') };
}

export function unmatchedPayments(db, { includeIgnored = false } = {}) {
  return db.prepare(`
    SELECT * FROM payments
     WHERE payment_line_id IS NULL ${includeIgnored ? '' : 'AND ignored_at IS NULL'}
     ORDER BY received_at DESC`).all().map(publicPayment);
}

// ---------- writing ----------

function requireInvoice(db, id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(String(id).toUpperCase());
  if (!inv) throw new LedgerError('Invoice not found', 404);
  return inv;
}

function cleanInput(input) {
  const client_name = String(input.client_name || '').trim();
  if (!client_name) throw new LedgerError('Client name is required');
  const currency = String(input.currency || 'CAD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new LedgerError('Currency must be a 3-letter code');
  const issue_date = input.issue_date || todayToronto();
  if (!isDate(issue_date)) throw new LedgerError('Issue date is invalid');
  const totals = computeTotals({
    line_items: input.line_items,
    subtotal_cents: input.subtotal_cents,
    hst_enabled: input.hst_enabled !== false,
  });
  if (totals.total_cents <= 0) throw new LedgerError('Total must be more than zero');
  const schedule = input.schedule || 'one_time';
  const lines = input.lines?.length
    ? normaliseLines(input.lines, totals.total_cents)
    : buildSchedule({ total_cents: totals.total_cents, schedule, count: input.count, first_due: input.first_due || issue_date });
  if (schedule === 'one_time' && lines.length !== 1) throw new LedgerError('A one-time invoice has exactly one payment');
  return {
    client_name,
    client_email: String(input.client_email || '').trim(),
    description: String(input.description || '').trim(),
    currency,
    hst_enabled: input.hst_enabled !== false,
    schedule,
    issue_date,
    notes: String(input.notes || '').trim(),
    ...totals,
    lines,
  };
}

const idTaken = (db, id) => !!db.prepare('SELECT 1 FROM invoices WHERE id = ?').get(id);

// A fresh, unused invoice ID. It isn't reserved until an invoice is created with it.
export function nextInvoiceId(db) {
  for (let tries = 0; tries <= 50; tries++) {
    const id = randomInvoiceId();
    if (!idTaken(db, id)) return id;
  }
  throw new LedgerError('Could not generate a unique invoice ID', 500);
}

export function createInvoice(db, input) {
  const v = cleanInput(input);
  return tx(db, () => {
    // Keep the number the form showed, unless it was taken in the meantime.
    const wanted = String(input.id || '').toUpperCase();
    const id = isInvoiceId(wanted) && !idTaken(db, wanted) ? wanted : nextInvoiceId(db);
    const now = nowIso();
    db.prepare(`
      INSERT INTO invoices (id, client_name, client_email, description, line_items, currency,
        subtotal_cents, hst_enabled, hst_cents, total_cents, schedule, issue_date, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, v.client_name, v.client_email, v.description, JSON.stringify(v.line_items), v.currency,
        v.subtotal_cents, v.hst_enabled ? 1 : 0, v.hst_cents, v.total_cents, v.schedule, v.issue_date, v.notes, now, now);
    const ins = db.prepare('INSERT INTO payment_lines (invoice_id, suffix, amount_cents, due_date) VALUES (?, ?, ?, ?)');
    for (const l of v.lines) ins.run(id, l.suffix, l.amount_cents, l.due_date);
    audit(db, 'invoice', id, 'create', {
      client_name: v.client_name, total_cents: v.total_cents, currency: v.currency,
      schedule: v.schedule, payments: v.lines.length,
    });
    return id;
  });
}

const ALWAYS_EDITABLE = ['client_name', 'client_email', 'description', 'notes'];

export function updateInvoice(db, id, input) {
  const inv = requireInvoice(db, id);
  if (inv.voided_at) throw new LedgerError('A void invoice can’t be edited');
  const hasPayments = db.prepare(`
    SELECT 1 FROM payments p JOIN payment_lines pl ON pl.id = p.payment_line_id
     WHERE pl.invoice_id = ? AND p.ignored_at IS NULL LIMIT 1`).get(inv.id);
  // Amounts and the schedule can only change before the invoice is sent or paid,
  // and before a Stripe link has been made for the old amounts.
  const fullyEditable = !inv.sent_date && !hasPayments && !inv.stripe_link_id;

  return tx(db, () => {
    const changes = {};
    if (fullyEditable) {
      const v = cleanInput({ ...input, issue_date: input.issue_date || inv.issue_date });
      const fields = ['client_name', 'client_email', 'description', 'currency', 'subtotal_cents', 'hst_cents',
        'total_cents', 'schedule', 'issue_date', 'notes'];
      for (const f of fields) if (v[f] !== inv[f]) changes[f] = { from: inv[f], to: v[f] };
      if ((v.hst_enabled ? 1 : 0) !== inv.hst_enabled) changes.hst_enabled = { from: !!inv.hst_enabled, to: v.hst_enabled };
      const newItems = JSON.stringify(v.line_items);
      if (newItems !== inv.line_items) changes.line_items = { from: JSON.parse(inv.line_items), to: v.line_items };
      const oldLines = db.prepare('SELECT suffix, amount_cents, due_date FROM payment_lines WHERE invoice_id = ? ORDER BY suffix').all(inv.id);
      const linesChanged = JSON.stringify(oldLines.map((l) => [l.suffix, l.amount_cents, l.due_date]))
        !== JSON.stringify(v.lines.map((l) => [l.suffix, l.amount_cents, l.due_date]));
      if (linesChanged && v.lines.length < oldLines.length) {
        throw new LedgerError('Payments can’t be removed once created. Void the invoice and create a new one instead.');
      }
      db.prepare(`
        UPDATE invoices SET client_name = ?, client_email = ?, description = ?, line_items = ?, currency = ?,
          subtotal_cents = ?, hst_enabled = ?, hst_cents = ?, total_cents = ?, schedule = ?, issue_date = ?,
          notes = ?, updated_at = ? WHERE id = ?`)
        .run(v.client_name, v.client_email, v.description, newItems, v.currency, v.subtotal_cents,
          v.hst_enabled ? 1 : 0, v.hst_cents, v.total_cents, v.schedule, v.issue_date, v.notes, nowIso(), inv.id);
      if (linesChanged) {
        const upd = db.prepare('UPDATE payment_lines SET amount_cents = ?, due_date = ? WHERE invoice_id = ? AND suffix = ?');
        const ins = db.prepare('INSERT INTO payment_lines (invoice_id, suffix, amount_cents, due_date) VALUES (?, ?, ?, ?)');
        for (const l of v.lines) {
          if (l.suffix <= oldLines.length) upd.run(l.amount_cents, l.due_date, inv.id, l.suffix);
          else ins.run(inv.id, l.suffix, l.amount_cents, l.due_date);
        }
        changes.payments = { from: oldLines, to: v.lines };
      }
    } else {
      const sets = [];
      const vals = [];
      for (const f of ALWAYS_EDITABLE) {
        if (input[f] === undefined) continue;
        const val = String(input[f]).trim();
        if (f === 'client_name' && !val) throw new LedgerError('Client name is required');
        if (val !== inv[f]) { changes[f] = { from: inv[f], to: val }; sets.push(`${f} = ?`); vals.push(val); }
      }
      if (sets.length) db.prepare(`UPDATE invoices SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), inv.id);
    }
    if (Object.keys(changes).length) audit(db, 'invoice', inv.id, 'edit', changes);
    return { changed: Object.keys(changes), fullyEditable };
  });
}

export function markSent(db, id, { sent_date, sent_to, sent_via }) {
  const inv = requireInvoice(db, id);
  if (inv.voided_at) throw new LedgerError('A void invoice can’t be sent');
  const date = sent_date || todayToronto();
  if (!isDate(date)) throw new LedgerError('Sent date is invalid');
  const via = String(sent_via || 'email').toLowerCase();
  if (!SENT_VIA.includes(via)) throw new LedgerError('Sent via must be Stripe, email or other');
  const to = String(sent_to || inv.client_email || '').trim();
  tx(db, () => {
    db.prepare('UPDATE invoices SET sent_date = ?, sent_to = ?, sent_via = ?, updated_at = ? WHERE id = ?')
      .run(date, to, via, nowIso(), inv.id);
    audit(db, 'invoice', inv.id, 'send', {
      sent_date: date, sent_to: to, sent_via: via,
      ...(inv.sent_date ? { previously: { sent_date: inv.sent_date, sent_to: inv.sent_to, sent_via: inv.sent_via } } : {}),
    });
  });
}

export function voidInvoice(db, id, reason = '') {
  const inv = requireInvoice(db, id);
  if (inv.voided_at) throw new LedgerError('Invoice is already void');
  tx(db, () => {
    db.prepare('UPDATE invoices SET voided_at = ?, void_reason = ?, updated_at = ? WHERE id = ?')
      .run(nowIso(), String(reason).trim(), nowIso(), inv.id);
    audit(db, 'invoice', inv.id, 'void', { reason: String(reason).trim() });
  });
}

export function setStripeLink(db, id, { link_id, url }) {
  tx(db, () => {
    db.prepare('UPDATE invoices SET stripe_link_id = ?, stripe_link_url = ?, updated_at = ? WHERE id = ?')
      .run(link_id, url, nowIso(), id);
    audit(db, 'invoice', id, 'stripe_link', { link_id, url });
  });
}

function requireLine(db, lineId) {
  const line = db.prepare(`
    SELECT pl.*, i.currency, i.voided_at, i.id AS inv_id FROM payment_lines pl
      JOIN invoices i ON i.id = pl.invoice_id WHERE pl.id = ?`).get(Number(lineId));
  if (!line) throw new LedgerError('Payment line not found', 404);
  return line;
}

export function recordManualPayment(db, { line_id, amount_cents, received_at, method, note }) {
  const line = requireLine(db, line_id);
  if (line.voided_at) throw new LedgerError('Can’t record a payment on a void invoice');
  const amount = cents(amount_cents, 'Amount');
  if (amount <= 0) throw new LedgerError('Amount must be more than zero');
  const date = received_at || todayToronto();
  if (!isDate(date)) throw new LedgerError('Payment date is invalid');
  const m = String(method || 'other').toLowerCase();
  if (!MANUAL_METHODS.includes(m)) throw new LedgerError('Method must be e-transfer, cheque, cash or other');
  return tx(db, () => {
    const now = nowIso();
    const r = db.prepare(`
      INSERT INTO payments (source, method, amount_cents, currency, received_at, note,
        payment_line_id, matched_at, match_method, created_at)
      VALUES ('manual', ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`)
      .run(m, amount, line.currency, date, String(note || '').trim(), line.id, now, now);
    const pid = Number(r.lastInsertRowid);
    audit(db, 'payment', pid, 'record_manual', {
      line: lineRef(line.invoice_id, line.suffix), amount_cents: amount, method: m, received_at: date,
    });
    return pid;
  });
}

function requirePayment(db, pid) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(pid));
  if (!p) throw new LedgerError('Payment not found', 404);
  return p;
}

export function assignPayment(db, pid, lineId, method = 'manual') {
  const p = requirePayment(db, pid);
  if (p.payment_line_id) throw new LedgerError('Payment is already matched');
  if (p.ignored_at) throw new LedgerError('Payment is ignored. Restore it first.');
  const line = requireLine(db, lineId);
  if (line.voided_at) throw new LedgerError('Can’t assign a payment to a void invoice');
  if (p.currency !== line.currency) throw new LedgerError(`Payment is in ${p.currency} but the invoice is in ${line.currency}`);
  tx(db, () => {
    db.prepare('UPDATE payments SET payment_line_id = ?, matched_at = ?, match_method = ? WHERE id = ?')
      .run(line.id, nowIso(), method, p.id);
    audit(db, 'payment', p.id, 'match', {
      line: lineRef(line.invoice_id, line.suffix), method, amount_cents: p.amount_cents, stripe_id: p.stripe_object_id,
    });
  });
  return lineRef(line.invoice_id, line.suffix);
}

export function unassignPayment(db, pid) {
  const p = requirePayment(db, pid);
  if (!p.payment_line_id) throw new LedgerError('Payment isn’t matched');
  if (p.source === 'manual') throw new LedgerError('A manual payment can’t be unassigned. Ignore it instead.');
  const line = requireLine(db, p.payment_line_id);
  tx(db, () => {
    db.prepare('UPDATE payments SET payment_line_id = NULL, matched_at = NULL, match_method = NULL WHERE id = ?').run(p.id);
    audit(db, 'payment', p.id, 'unmatch', { line: lineRef(line.invoice_id, line.suffix) });
  });
}

export function ignorePayment(db, pid, note = '') {
  const p = requirePayment(db, pid);
  if (p.ignored_at) throw new LedgerError('Payment is already ignored');
  tx(db, () => {
    db.prepare('UPDATE payments SET ignored_at = ?, note = COALESCE(NULLIF(?, \'\'), note) WHERE id = ?')
      .run(nowIso(), String(note).trim(), p.id);
    audit(db, 'payment', p.id, 'ignore', { note: String(note).trim() });
  });
}

export function restorePayment(db, pid) {
  const p = requirePayment(db, pid);
  if (!p.ignored_at) throw new LedgerError('Payment isn’t ignored');
  tx(db, () => {
    db.prepare('UPDATE payments SET ignored_at = NULL WHERE id = ?').run(p.id);
    audit(db, 'payment', p.id, 'restore', {});
  });
}

// ---------- Stripe payments ----------

// The next payment line on an invoice that still owes money.
function nextOpenLine(db, invoiceId) {
  return db.prepare(`
    SELECT pl.*, COALESCE(SUM(p.amount_cents), 0) AS paid_cents FROM payment_lines pl
      LEFT JOIN payments p ON p.payment_line_id = pl.id AND p.ignored_at IS NULL
     WHERE pl.invoice_id = ? GROUP BY pl.id HAVING paid_cents < pl.amount_cents
     ORDER BY pl.suffix LIMIT 1`).get(invoiceId);
}

function findLineFor(db, { id, suffix }) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv || inv.voided_at) return null;
  if (suffix) {
    const line = db.prepare('SELECT * FROM payment_lines WHERE invoice_id = ? AND suffix = ?').get(id, suffix);
    if (line) return { line, inv };
  }
  const line = nextOpenLine(db, id);
  return line ? { line, inv } : null;
}

// Work out which payment line a Stripe payment belongs to:
// 1. invoice_id (+ payment_suffix) in the metadata, set on links the ledger creates;
// 2. an invoice number the payer typed at checkout or that's in the description.
function autoMatchTarget(db, p) {
  const meta = JSON.parse(p.metadata || '{}');
  if (meta.invoice_id) {
    const hit = findLineFor(db, {
      id: String(meta.invoice_id).toUpperCase(),
      suffix: meta.payment_suffix ? Number(meta.payment_suffix) : null,
    });
    if (hit) return { ...hit, method: 'auto: Stripe metadata' };
  }
  for (const [text, label] of [[p.invoice_ref_entered, 'auto: invoice number entered at checkout'], [p.description, 'auto: payment description']]) {
    for (const ref of findRefs(text)) {
      const hit = findLineFor(db, ref);
      if (hit) return { ...hit, method: label };
    }
  }
  return null;
}

// Insert or update a payment from Stripe, keyed on `ref` (the PaymentIntent ID
// where there is one) so the several events Stripe sends for one payment
// collapse into a single row. Returns what happened.
export function upsertStripePayment(db, rec) {
  return tx(db, () => {
    const now = nowIso();
    let p = db.prepare('SELECT * FROM payments WHERE ref = ?').get(rec.ref);
    let created = false;
    if (!p) {
      const r = db.prepare(`
        INSERT INTO payments (source, ref, stripe_type, stripe_object_id, stripe_event_id, stripe_subscription,
          method, amount_cents, currency, received_at, payer_name, payer_email, description,
          invoice_ref_entered, metadata, created_at)
        VALUES ('stripe', ?, ?, ?, ?, ?, 'card', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(rec.ref, rec.stripe_type, rec.stripe_object_id, rec.stripe_event_id, rec.stripe_subscription || null,
          rec.amount_cents, rec.currency, rec.received_at, rec.payer_name || null, rec.payer_email || null,
          rec.description || null, rec.invoice_ref_entered || null, JSON.stringify(rec.metadata || {}), now);
      p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(r.lastInsertRowid));
      created = true;
      audit(db, 'payment', p.id, 'receive', {
        stripe_type: rec.stripe_type, stripe_id: rec.stripe_object_id, amount_cents: rec.amount_cents, currency: rec.currency,
      });
    } else {
      // A later event for the same payment: fill in anything we didn't have.
      const meta = { ...JSON.parse(p.metadata || '{}'), ...(rec.metadata || {}) };
      db.prepare(`
        UPDATE payments SET
          stripe_subscription = COALESCE(stripe_subscription, ?),
          payer_name = COALESCE(payer_name, ?), payer_email = COALESCE(payer_email, ?),
          description = COALESCE(description, ?), invoice_ref_entered = COALESCE(invoice_ref_entered, ?),
          metadata = ? WHERE id = ?`)
        .run(rec.stripe_subscription || null, rec.payer_name || null, rec.payer_email || null,
          rec.description || null, rec.invoice_ref_entered || null, JSON.stringify(meta), p.id);
      p = db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
    }

    let matched = null;
    let invoicePaid = false;
    if (!p.payment_line_id && !p.ignored_at) {
      const t = autoMatchTarget(db, p);
      if (t && t.inv.currency === p.currency) {
        db.prepare('UPDATE payments SET payment_line_id = ?, matched_at = ?, match_method = ? WHERE id = ?')
          .run(t.line.id, now, t.method, p.id);
        matched = lineRef(t.inv.id, t.line.suffix);
        audit(db, 'payment', p.id, 'match', { line: matched, method: t.method, amount_cents: p.amount_cents, stripe_id: p.stripe_object_id });
        invoicePaid = !nextOpenLine(db, t.inv.id);
        p.invoice_id = t.inv.id;
      }
    }
    return { payment_id: p.id, created, matched, invoice_paid: invoicePaid, invoice_id: p.invoice_id || null, subscription: p.stripe_subscription };
  });
}

// ---------- CSV ----------

export function toCsv(rows) {
  const cols = [
    ['Invoice', (r) => r.id], ['Client', (r) => r.client_name], ['Client email', (r) => r.client_email],
    ['Currency', (r) => r.currency], ['Subtotal', (r) => r.subtotal_cents / 100], ['HST', (r) => r.hst_cents / 100],
    ['Total', (r) => r.total_cents / 100], ['Paid', (r) => r.paid_cents / 100], ['Outstanding', (r) => r.outstanding_cents / 100],
    ['Status', (r) => r.status], ['Schedule', (r) => r.schedule], ['Payments', (r) => r.payment_count],
    ['Issue date', (r) => r.issue_date], ['Date sent', (r) => r.sent_date || ''], ['Sent to', (r) => r.sent_to || ''],
    ['Sent via', (r) => r.sent_via || ''], ['Description', (r) => r.description], ['Notes', (r) => r.notes],
  ];
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map((c) => esc(c[1](r))).join(','))].join('\r\n') + '\r\n';
}
