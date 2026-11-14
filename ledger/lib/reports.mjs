// Dashboard and reports. Everything is computed from the ledger tables on
// request; nothing here writes. Money is grouped by currency throughout.
import { lineRef } from './ids.mjs';
import { todayToronto, LedgerError } from './ledger.mjs';

const NET = '(p.amount_cents - p.refunded_cents - p.dispute_cents)';
const DAY = 86_400_000;

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
// Stripe payments are stored as UTC timestamps, manual ones as dates. Reports use Toronto dates.
export const localDate = (s) => (!s ? null : s.length === 10 ? s : todayToronto(new Date(s)));

// { CAD: 1200 } style totals.
function add(totals, currency, cents) {
  totals[currency] = (totals[currency] || 0) + cents;
  return totals;
}

export const AGE_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_plus'];
export function ageBucket(daysLate) {
  if (daysLate <= 0) return 'current';
  if (daysLate <= 30) return 'd1_30';
  if (daysLate <= 60) return 'd31_60';
  return 'd61_plus';
}

// Every open payment line on a live invoice, with what's owed and how late it is.
// Unsent drafts and undated payments are never late.
function openItems(db, today) {
  return db.prepare(`
    SELECT pl.id, pl.invoice_id, pl.suffix, pl.amount_cents, pl.due_date, pl.label,
           i.client_name, i.client_email, i.currency, i.sent_date, i.issue_date, i.description,
           COALESCE(SUM(${NET}), 0) AS paid_cents
      FROM payment_lines pl
      JOIN invoices i ON i.id = pl.invoice_id AND i.voided_at IS NULL
      LEFT JOIN payments p ON p.payment_line_id = pl.id AND p.ignored_at IS NULL
     GROUP BY pl.id
    HAVING paid_cents < pl.amount_cents
     ORDER BY pl.due_date IS NULL, pl.due_date, pl.invoice_id, pl.suffix`).all()
    .map((l) => {
      const late = l.sent_date && l.due_date ? Math.max(daysBetween(l.due_date, today), 0) : 0;
      return {
        ...l,
        ref: lineRef(l.invoice_id, l.suffix),
        outstanding_cents: l.amount_cents - l.paid_cents,
        days_late: late,
        bucket: ageBucket(late),
        sent: !!l.sent_date,
      };
    });
}

// Payments that count (not ignored), with the invoice they're on, if any.
function livePayments(db) {
  return db.prepare(`
    SELECT p.*, pl.invoice_id, pl.suffix, i.client_name, i.hst_cents, i.total_cents
      FROM payments p
      LEFT JOIN payment_lines pl ON pl.id = p.payment_line_id
      LEFT JOIN invoices i ON i.id = pl.invoice_id
     WHERE p.ignored_at IS NULL`).all()
    .map((p) => ({ ...p, date: localDate(p.received_at), ref: p.invoice_id ? lineRef(p.invoice_id, p.suffix) : null }));
}

// Refunds by the day they happened, from the audit log (Stripe reports the total
// refunded so far, and applyRefund logs each increase).
function refundEvents(db) {
  return db.prepare(`
    SELECT a.at, a.detail, p.id AS payment_id, p.currency, p.payer_name, p.payer_email, p.stripe_object_id,
           pl.invoice_id, pl.suffix, i.client_name, i.hst_cents, i.total_cents
      FROM audit_log a
      JOIN payments p ON p.id = CAST(a.entity_id AS INTEGER)
      LEFT JOIN payment_lines pl ON pl.id = p.payment_line_id
      LEFT JOIN invoices i ON i.id = pl.invoice_id
     WHERE a.entity = 'payment' AND a.action = 'refund' AND p.ignored_at IS NULL`).all()
    .map((r) => ({ ...r, detail: JSON.parse(r.detail), date: localDate(r.at), ref: r.invoice_id ? lineRef(r.invoice_id, r.suffix) : null }));
}

// The HST part of an amount paid on an invoice, in proportion to the invoice's tax.
const hstShare = (cents, p) => (p.total_cents ? Math.round((cents * p.hst_cents) / p.total_cents) : 0);

// ---------- dashboard ----------

export function dashboard(db, today = todayToronto()) {
  const items = openItems(db, today);
  const in30 = addDays(today, 30);
  const month = today.slice(0, 7);
  const lastMonthDate = addDays(`${month}-01`, -1);
  const lastMonth = lastMonthDate.slice(0, 7);

  const owed = {}; const overdue = {}; const dueSoon = {}; const onCompletion = {}; const unsent = {};
  const aging = Object.fromEntries(AGE_BUCKETS.map((b) => [b, {}]));
  const clients = new Map();
  for (const l of items) {
    add(owed, l.currency, l.outstanding_cents);
    if (!l.sent) add(unsent, l.currency, l.outstanding_cents);
    if (l.days_late > 0) add(overdue, l.currency, l.outstanding_cents);
    else if (l.sent && l.due_date && l.due_date <= in30) add(dueSoon, l.currency, l.outstanding_cents);
    if (!l.due_date) add(onCompletion, l.currency, l.outstanding_cents);
    add(aging[l.bucket], l.currency, l.outstanding_cents);
    const c = clients.get(l.client_name) || { client_name: l.client_name, outstanding: {}, overdue: {}, invoices: new Set(), oldest_days_late: 0 };
    add(c.outstanding, l.currency, l.outstanding_cents);
    if (l.days_late > 0) add(c.overdue, l.currency, l.outstanding_cents);
    c.invoices.add(l.invoice_id);
    c.oldest_days_late = Math.max(c.oldest_days_late, l.days_late);
    clients.set(l.client_name, c);
  }

  const pays = livePayments(db);
  const refunds = refundEvents(db);
  const receivedIn = (ym) => {
    const t = {};
    for (const p of pays) if (p.date?.startsWith(ym)) add(t, p.currency, p.amount_cents);
    for (const r of refunds) if (r.date?.startsWith(ym)) add(t, r.currency, -(r.detail.amount_cents || 0));
    return t;
  };

  const unmatched = pays.filter((p) => !p.payment_line_id);
  const sumBy = (rows, key) => rows.reduce((t, r) => add(t, r.currency, r[key]), {});

  return {
    today,
    owed, overdue, due_30: dueSoon, on_completion: onCompletion, unsent,
    received_this_month: receivedIn(month),
    received_last_month: receivedIn(lastMonth),
    month, last_month: lastMonth,
    aging,
    clients: [...clients.values()]
      .map((c) => ({ ...c, invoices: c.invoices.size }))
      .sort((a, b) => b.oldest_days_late - a.oldest_days_late || Object.values(b.outstanding)[0] - Object.values(a.outstanding)[0]),
    overdue_items: items.filter((l) => l.days_late > 0).sort((a, b) => b.days_late - a.days_late),
    upcoming_items: items.filter((l) => l.sent && l.days_late === 0 && l.due_date && l.due_date <= in30),
    unsent_items: items.filter((l) => !l.sent),
    unmatched: { count: unmatched.length, total: sumBy(unmatched, 'amount_cents') },
    recent_payments: pays.sort((a, b) => String(b.received_at).localeCompare(String(a.received_at))).slice(0, 8)
      .map((p) => ({
        id: p.id, date: p.date, amount_cents: p.amount_cents, net_cents: p.amount_cents - p.refunded_cents - p.dispute_cents,
        currency: p.currency, ref: p.ref, client_name: p.client_name, payer: p.payer_name || p.payer_email || null,
        source: p.source, method: p.method,
      })),
  };
}

// ---------- receivables ----------

export function receivables(db, today = todayToronto()) {
  const items = openItems(db, today);
  const byClient = new Map();
  const totals = Object.fromEntries([...AGE_BUCKETS, 'total'].map((b) => [b, {}]));
  for (const l of items) {
    const c = byClient.get(l.client_name) || { client_name: l.client_name, items: [], ...Object.fromEntries([...AGE_BUCKETS, 'total'].map((b) => [b, {}])) };
    c.items.push(l);
    add(c[l.bucket], l.currency, l.outstanding_cents);
    add(c.total, l.currency, l.outstanding_cents);
    add(totals[l.bucket], l.currency, l.outstanding_cents);
    add(totals.total, l.currency, l.outstanding_cents);
    byClient.set(l.client_name, c);
  }
  return { as_of: today, clients: [...byClient.values()].sort((a, b) => a.client_name.localeCompare(b.client_name)), totals };
}

// ---------- payments received ----------

export function paymentsReport(db, { from, to }) {
  if (!isDate(from) || !isDate(to)) throw new LedgerError('Choose a start and end date');
  if (from > to) throw new LedgerError('The start date is after the end date');
  const inRange = (d) => d && d >= from && d <= to;

  const rows = [];
  for (const p of livePayments(db)) {
    if (!inRange(p.date)) continue;
    rows.push({
      kind: 'payment', date: p.date, payment_id: p.id, ref: p.ref, client_name: p.client_name,
      payer: p.payer_name || p.payer_email || null, method: p.source === 'stripe' ? `Stripe ${p.method || 'card'}` : p.method,
      stripe_id: p.stripe_object_id, currency: p.currency, amount_cents: p.amount_cents,
      hst_cents: p.payment_line_id ? hstShare(p.amount_cents, p) : 0,
      matched: !!p.payment_line_id,
      dispute_cents: p.dispute_cents, dispute_status: p.dispute_status,
    });
  }
  for (const r of refundEvents(db)) {
    if (!inRange(r.date)) continue;
    const amt = -(r.detail.amount_cents || 0);
    rows.push({
      kind: 'refund', date: r.date, payment_id: r.payment_id, ref: r.ref, client_name: r.client_name,
      payer: r.payer_name || r.payer_email || null, method: 'Stripe refund', stripe_id: r.stripe_object_id,
      currency: r.currency, amount_cents: amt, hst_cents: r.invoice_id ? hstShare(amt, r) : 0, matched: !!r.invoice_id,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.payment_id - b.payment_id);

  const sum = (pred, key) => rows.filter(pred).reduce((t, r) => add(t, r.currency, r[key]), {});
  // HST charged on invoices issued in the period: what you report if you file on
  // the invoice (accrual) basis, which is the default for HST.
  const issued = db.prepare(`
    SELECT currency, COUNT(*) AS n, SUM(subtotal_cents) AS subtotal, SUM(hst_cents) AS hst, SUM(total_cents) AS total
      FROM invoices WHERE voided_at IS NULL AND issue_date BETWEEN ? AND ? GROUP BY currency`).all(from, to);

  const received = sum((r) => r.kind === 'payment', 'amount_cents');
  const refunded = sum((r) => r.kind === 'refund', 'amount_cents');
  const net = sum(() => true, 'amount_cents');
  const hst = sum(() => true, 'hst_cents');
  const unmatched = sum((r) => !r.matched, 'amount_cents');
  const disputed = sum((r) => r.kind === 'payment' && r.dispute_cents, 'dispute_cents');
  const beforeTax = Object.fromEntries(Object.entries(net).map(([c, v]) => [c, v - (hst[c] || 0)]));

  return {
    from, to, rows,
    totals: { received, refunded, net, hst, before_tax: beforeTax, unmatched, disputed },
    invoiced: Object.fromEntries(issued.map((r) => [r.currency, { count: r.n, subtotal: r.subtotal, hst: r.hst, total: r.total }])),
  };
}

// ---------- client statement ----------

export function clientStatement(db, clientName, today = todayToronto()) {
  const name = String(clientName || '');
  const invoices = db.prepare('SELECT * FROM invoices WHERE client_name = ? AND voided_at IS NULL ORDER BY issue_date, created_at').all(name);
  if (!invoices.length) throw new LedgerError('No invoices for that client', 404);
  const ids = new Set(invoices.map((i) => i.id));
  const entries = invoices.map((i) => ({
    date: i.issue_date, kind: 'invoice', ref: i.id, currency: i.currency,
    text: `Invoice ${i.id}${i.description ? ` · ${i.description.split('\n')[0]}` : ''}`, charge_cents: i.total_cents, credit_cents: 0,
  }));
  for (const p of livePayments(db)) {
    if (!ids.has(p.invoice_id)) continue;
    const how = p.source === 'stripe' ? 'card' : p.method;
    entries.push({ date: p.date, kind: 'payment', ref: p.ref, currency: p.currency, text: `Payment ${p.ref} (${how})`, charge_cents: 0, credit_cents: p.amount_cents });
    if (p.dispute_cents) entries.push({ date: p.date, kind: 'dispute', ref: p.ref, currency: p.currency, text: `Card dispute on ${p.ref}`, charge_cents: p.dispute_cents, credit_cents: 0 });
  }
  for (const r of refundEvents(db)) {
    if (!ids.has(r.invoice_id)) continue;
    entries.push({ date: r.date, kind: 'refund', ref: r.ref, currency: r.currency, text: `Refund on ${r.ref}`, charge_cents: r.detail.amount_cents || 0, credit_cents: 0 });
  }
  const order = { invoice: 0, payment: 1, refund: 2, dispute: 3 };
  entries.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind]);
  const running = {};
  for (const e of entries) e.balance_cents = add(running, e.currency, e.charge_cents - e.credit_cents)[e.currency];

  const open = openItems(db, today).filter((l) => ids.has(l.invoice_id));
  return {
    client_name: name, client_email: invoices.at(-1).client_email, as_of: today,
    entries, balance: running, open_items: open,
  };
}

// ---------- CSV ----------

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsvRows = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function paymentsCsv(report) {
  return toCsvRows(
    ['Date', 'Type', 'Payment number', 'Client', 'Payer', 'Method', 'Stripe ID', 'Currency', 'Amount', 'HST portion', 'Before tax', 'Matched'],
    report.rows.map((r) => [r.date, r.kind, r.ref || '', r.client_name || '', r.payer || '', r.method || '', r.stripe_id || '', r.currency,
      (r.amount_cents / 100).toFixed(2), (r.hst_cents / 100).toFixed(2), ((r.amount_cents - r.hst_cents) / 100).toFixed(2), r.matched ? 'yes' : 'no']),
  );
}

export function receivablesCsv(report) {
  return toCsvRows(
    ['Client', 'Payment number', 'Label', 'Due date', 'Sent', 'Days late', 'Currency', 'Outstanding'],
    report.clients.flatMap((c) => c.items.map((l) => [c.client_name, l.ref, l.label, l.due_date || 'on completion', l.sent ? 'yes' : 'no',
      l.days_late, l.currency, (l.outstanding_cents / 100).toFixed(2)])),
  );
}
