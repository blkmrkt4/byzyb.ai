// Matching money to the bank. Stripe payouts are pulled from the API and broken
// down into the payments, refunds and fees inside each one. Manual payments
// (e-transfers, cheques, cash) sit alongside them. A bank statement CSV can be
// imported so each deposit is ticked off against a payout or a manual payment.
import crypto from 'node:crypto';
import { lineRef } from './ids.mjs';
import { tx } from './db.mjs';
import { LedgerError, audit, getSetting, setSetting, todayToronto } from './ledger.mjs';
import { isDate, daysBetween, localDate } from './reports.mjs';

const nowIso = () => new Date().toISOString();
const DAY_S = 86_400;
const dateOf = (unix) => todayToronto(new Date(unix * 1000));
const idOf = (v) => (typeof v === 'string' ? v : v?.id) || null;

function add(totals, currency, cents) {
  totals[currency] = (totals[currency] || 0) + cents;
  return totals;
}

// Stripe's own fee lines (e.g. monthly billing fees) are fees too, not just the
// per-charge fee on each payment.
const FEE_TYPES = ['stripe_fee', 'tax'];
const feeOf = (t) => t.fee_cents + (FEE_TYPES.includes(t.type) ? -t.amount_cents : 0);

const TXN_LABEL = {
  charge: 'Payment', payment: 'Payment', refund: 'Refund', payment_refund: 'Refund',
  adjustment: 'Adjustment', dispute: 'Dispute', stripe_fee: 'Stripe fee', tax: 'Tax on Stripe fees',
  payment_failure_refund: 'Failed payment returned', refund_failure: 'Refund returned',
};
export const txnLabel = (type) => TXN_LABEL[type] || type.replace(/_/g, ' ');

// ---------- Stripe sync ----------

export class StripePermissionError extends LedgerError {}

function friendly(err) {
  if (/permission/i.test(err.message)) {
    return new StripePermissionError('The Stripe key can’t read payouts yet. In Stripe, edit the ledger’s restricted key and set Balance, Payouts and Charges to Read.', 400);
  }
  return err;
}

async function listAll(stripe, path, params, max = 2000) {
  const out = [];
  let after;
  do {
    const page = await stripe.get(path, { ...params, limit: 100, ...(after ? { starting_after: after } : {}) });
    out.push(...page.data);
    after = page.has_more && page.data.length ? page.data.at(-1).id : null;
  } while (after && out.length < max);
  return out;
}

// Balance transactions with their charge expanded, so each one can be tied to a
// ledger payment. Expanding needs Charges: Read; without it they're matched by
// amount and date instead.
async function listTxns(stripe, params, state) {
  if (state.expand !== false) {
    try {
      return await listAll(stripe, '/balance_transactions', { ...params, expand: ['data.source'] });
    } catch (err) {
      if (!/permission/i.test(err.message)) throw err;
      state.expand = false;
    }
  }
  return listAll(stripe, '/balance_transactions', params);
}

function upsertPayout(db, p, now) {
  db.prepare(`
    INSERT INTO stripe_payouts (id, amount_cents, currency, status, arrival_date, created_at, method, automatic,
      description, failure_message, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET amount_cents = excluded.amount_cents, status = excluded.status,
      arrival_date = excluded.arrival_date, method = excluded.method, description = excluded.description,
      failure_message = excluded.failure_message, synced_at = excluded.synced_at`)
    .run(p.id, p.amount, String(p.currency).toUpperCase(), p.status, dateOf(p.arrival_date), new Date(p.created * 1000).toISOString(),
      p.method || null, p.automatic === false ? 0 : 1, p.statement_descriptor || p.description || null, p.failure_message || null, now);
}

function upsertTxn(db, t, payoutId, now) {
  const src = typeof t.source === 'object' && t.source ? t.source : null;
  const pi = idOf(src?.payment_intent);
  const payer = src?.billing_details?.name || src?.billing_details?.email || null;
  db.prepare(`
    INSERT INTO stripe_txns (id, payout_id, type, source_id, payment_intent, payer, amount_cents, fee_cents, net_cents,
      currency, created_at, available_on, status, description, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payout_id = COALESCE(excluded.payout_id, stripe_txns.payout_id),
      payment_intent = COALESCE(excluded.payment_intent, stripe_txns.payment_intent),
      payer = COALESCE(excluded.payer, stripe_txns.payer),
      status = excluded.status, available_on = excluded.available_on, synced_at = excluded.synced_at`)
    .run(t.id, payoutId, t.type, idOf(t.source), pi, payer, t.amount, t.fee || 0, t.net, String(t.currency).toUpperCase(),
      new Date(t.created * 1000).toISOString(), t.available_on ? dateOf(t.available_on) : null, t.status || null,
      t.description || null, now);
}

const isPayoutTxn = (t) => String(t.type).startsWith('payout');

// Pull payouts, what's in them, recent unpaid-out activity and the balance.
// Safe to run any time; everything is an upsert.
export async function syncStripe(db, stripe, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!stripe) throw new LedgerError('Stripe isn’t connected (STRIPE_SECRET_KEY is not set).');
  const last = getSetting(db, 'bank.synced_at');
  const lastSec = last ? Math.floor(Date.parse(last) / 1000) : null;
  // First sync looks back 13 months; later ones re-read 45 days so payouts that
  // were in transit pick up their final status.
  const payoutSince = lastSec ? lastSec - 45 * DAY_S : nowSec - 400 * DAY_S;
  const txnSince = lastSec ? lastSec - 10 * DAY_S : nowSec - 90 * DAY_S;
  const state = {};
  const now = nowIso();
  const counts = { payouts: 0, txns: 0 };
  try {
    const payouts = await listAll(stripe, '/payouts', { created: { gte: payoutSince } });
    tx(db, () => { for (const p of payouts) upsertPayout(db, p, now); });
    counts.payouts = payouts.length;

    // What's inside each payout. Stripe only itemises automatic payouts. Once a
    // payout has landed and been read, it never changes, so it isn't read again.
    const toLoad = db.prepare(`
      SELECT id, status FROM stripe_payouts
       WHERE automatic = 1 AND status IN ('paid', 'in_transit', 'pending')
         AND (txns_loaded_at IS NULL OR txns_status IS NOT status)`).all();
    for (const p of toLoad) {
      const txns = await listTxns(stripe, { payout: p.id }, state);
      tx(db, () => {
        for (const t of txns) if (!isPayoutTxn(t)) upsertTxn(db, t, p.id, now);
        db.prepare('UPDATE stripe_payouts SET txns_loaded_at = ?, txns_status = ? WHERE id = ?').run(now, p.status, p.id);
      });
      counts.txns += txns.length;
    }

    // Recent activity, including money not paid out yet.
    const recent = await listTxns(stripe, { created: { gte: txnSince } }, state);
    tx(db, () => { for (const t of recent) if (!isPayoutTxn(t)) upsertTxn(db, t, null, now); });
    counts.txns += recent.length;

    const bal = await stripe.get('/balance');
    const sumBy = (arr = []) => Object.fromEntries(arr.map((b) => [String(b.currency).toUpperCase(), b.amount]));
    setSetting(db, 'bank.balance', JSON.stringify({ available: sumBy(bal.available), pending: sumBy(bal.pending), at: now }));
  } catch (err) {
    throw friendly(err);
  }
  setSetting(db, 'bank.synced_at', now);
  setSetting(db, 'bank.charges_readable', state.expand === false ? '0' : '1');
  return { ...counts, synced_at: now, charges_readable: state.expand !== false };
}

// ---------- linking Stripe activity to ledger payments ----------

function ledgerPayments(db) {
  return db.prepare(`
    SELECT p.id, p.ref, p.source, p.method, p.amount_cents, p.currency, p.received_at, p.payer_name, p.payer_email,
           p.ignored_at, pl.invoice_id, pl.suffix, i.client_name
      FROM payments p
      LEFT JOIN payment_lines pl ON pl.id = p.payment_line_id
      LEFT JOIN invoices i ON i.id = pl.invoice_id`).all();
}

const paymentView = (p) => p && ({
  payment_id: p.id, ref: p.invoice_id ? lineRef(p.invoice_id, p.suffix) : null, invoice_id: p.invoice_id || null,
  client_name: p.client_name || null, payer: p.payer_name || p.payer_email || null,
});

// Ties each balance transaction to a ledger payment: by PaymentIntent when the
// charge was readable, otherwise a Stripe payment of the same amount within a day.
function linker(db) {
  const pays = ledgerPayments(db);
  const byRef = new Map(pays.filter((p) => p.ref).map((p) => [p.ref, p]));
  const stripePays = pays.filter((p) => p.source === 'stripe');
  const used = new Set();
  return (t) => {
    let p = (t.payment_intent && byRef.get(t.payment_intent)) || (t.source_id && byRef.get(t.source_id)) || null;
    if (!p && ['charge', 'payment'].includes(t.type)) {
      const d = localDate(t.created_at);
      p = stripePays.find((x) => !used.has(x.id) && x.amount_cents === t.amount_cents && x.currency === t.currency
        && Math.abs(daysBetween(localDate(x.received_at), d)) <= 1) || null;
    }
    if (p) used.add(p.id);
    return p;
  };
}

// ---------- the reconciliation report ----------

const MANUAL_DEPOSITS = ['e-transfer', 'cheque', 'cash', 'other'];

export function bankReport(db, { from, to }) {
  if (!isDate(from) || !isDate(to)) throw new LedgerError('Choose a start and end date');
  if (from > to) throw new LedgerError('The start date is after the end date');
  const inRange = (d) => d && d >= from && d <= to;
  const link = linker(db);

  const bankFor = db.prepare(`SELECT id, date, description, amount_cents FROM bank_lines WHERE match_type = ? AND match_id = ? AND ignored_at IS NULL`);
  const txnRow = (t) => {
    const p = link(t);
    return {
      id: t.id, type: t.type, label: txnLabel(t.type), date: localDate(t.created_at), currency: t.currency,
      amount_cents: t.amount_cents, fee_cents: feeOf(t), net_cents: t.net_cents,
      description: t.description, payer: t.payer, ...(p ? paymentView(p) : { payment_id: null, ref: null }),
    };
  };

  const allTxns = db.prepare('SELECT * FROM stripe_txns ORDER BY created_at').all();
  const byPayout = new Map();
  for (const t of allTxns) {
    if (!t.payout_id) continue;
    if (!byPayout.has(t.payout_id)) byPayout.set(t.payout_id, []);
    byPayout.get(t.payout_id).push(t);
  }

  const payouts = db.prepare('SELECT * FROM stripe_payouts WHERE arrival_date BETWEEN ? AND ? ORDER BY arrival_date DESC, id').all(from, to)
    .map((po) => {
      const txns = (byPayout.get(po.id) || []).map(txnRow);
      const sum = (k) => txns.reduce((a, t) => a + t[k], 0);
      const net = sum('net_cents');
      const bank = bankFor.get('payout', po.id) || null;
      return {
        id: po.id, date: po.arrival_date, status: po.status, currency: po.currency, amount_cents: po.amount_cents,
        automatic: !!po.automatic, itemised: !!po.txns_loaded_at && !!po.automatic, failure_message: po.failure_message,
        gross_cents: sum('amount_cents') - txns.filter((t) => FEE_TYPES.includes(t.type)).reduce((a, t) => a + t.amount_cents, 0),
        fee_cents: sum('fee_cents'), net_cents: net,
        // An itemised payout should add up exactly; if not, something is missing from the breakdown.
        balanced: !po.automatic || !po.txns_loaded_at ? null : net === po.amount_cents,
        txns, bank,
      };
    });

  // Collected by Stripe but not in any payout yet.
  const pending = allTxns.filter((t) => !t.payout_id).map(txnRow);
  const onTheWay = db.prepare("SELECT id, arrival_date AS date, amount_cents, currency, status FROM stripe_payouts WHERE status IN ('pending', 'in_transit') ORDER BY arrival_date").all();
  let balance = null;
  try { balance = JSON.parse(getSetting(db, 'bank.balance') || 'null'); } catch { balance = null; }

  const manual = ledgerPayments(db)
    .filter((p) => p.source === 'manual' && !p.ignored_at && MANUAL_DEPOSITS.includes(p.method) && inRange(localDate(p.received_at)))
    .map((p) => ({
      ...paymentView(p), date: localDate(p.received_at), method: p.method, amount_cents: p.amount_cents, currency: p.currency,
      bank: bankFor.get('payment', String(p.id)) || null,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.payment_id - a.payment_id);

  const lines = bankLines(db, { from, to });

  // Fees are counted by the date Stripe charged them, so a period's fees don't
  // depend on when the payout happened to land.
  const fees = {};
  const feeRows = [];
  for (const t of allTxns) {
    const d = localDate(t.created_at);
    if (!inRange(d) || !feeOf(t)) continue;
    add(fees, t.currency, feeOf(t));
    feeRows.push(t);
  }

  const totals = {
    deposited: payouts.filter((p) => p.status === 'paid').reduce((t, p) => add(t, p.currency, p.amount_cents), {}),
    fees,
    manual: manual.reduce((t, p) => add(t, p.currency, p.amount_cents), {}),
    pending: pending.reduce((t, x) => add(t, x.currency, x.net_cents), {}),
    on_the_way: onTheWay.reduce((t, p) => add(t, p.currency, p.amount_cents), {}),
  };
  const toMatch = [
    ...payouts.filter((p) => p.status === 'paid' && !p.bank),
    ...manual.filter((m) => !m.bank),
  ].length;

  return {
    from, to, payouts, pending, on_the_way: onTheWay, balance, manual, bank_lines: lines, totals,
    fee_count: feeRows.length,
    counts: {
      payouts: payouts.length,
      unbalanced: payouts.filter((p) => p.balanced === false).length,
      not_in_bank: toMatch,
      bank_unmatched: lines.filter((l) => !l.match_type && !l.ignored_at).length,
      bank_lines_total: db.prepare('SELECT COUNT(*) AS n FROM bank_lines').get().n,
    },
    synced_at: getSetting(db, 'bank.synced_at'),
    charges_readable: getSetting(db, 'bank.charges_readable') !== '0',
  };
}

// For the accountant: one row per item in each payout.
export function bankCsv(report) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['Deposit date', 'Payout', 'Payout amount', 'Item date', 'Type', 'Invoice payment', 'Client / payer', 'Gross', 'Stripe fee', 'Net', 'Currency', 'In bank']];
  for (const p of report.payouts) {
    const inBank = p.bank ? `yes (${p.bank.date})` : 'no';
    if (!p.txns.length) rows.push([p.date, p.id, p.amount_cents / 100, '', p.automatic ? 'Not itemised yet' : 'Manual payout', '', '', '', '', p.amount_cents / 100, p.currency, inBank]);
    for (const t of p.txns) {
      rows.push([p.date, p.id, p.amount_cents / 100, t.date, t.label, t.ref || '', t.client_name || t.payer || t.description || '',
        (FEE_TYPES.includes(t.type) ? 0 : t.amount_cents) / 100, t.fee_cents / 100, t.net_cents / 100, t.currency, inBank]);
    }
  }
  for (const m of report.manual) {
    rows.push([m.date, '', m.amount_cents / 100, m.date, `Manual ${m.method}`, m.ref || '', m.client_name || '', m.amount_cents / 100, 0, m.amount_cents / 100, m.currency, m.bank ? `yes (${m.bank.date})` : 'no']);
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ---------- bank statement CSV ----------

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ''));
}

// "1,234.56", "$1,234.56", "(12.00)", "12.00-", "12.00 CR" -> cents. null if not a number.
export function parseAmount(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\s*DR$/i.test(s)) { sign = -1; s = s.replace(/\s*DR$/i, ''); }
  s = s.replace(/\s*CR$/i, '');
  if (s.endsWith('-')) { sign = -sign; s = s.slice(0, -1); }
  s = s.replace(/[\s$,]|CAD|USD|C\$|US\$/gi, '');
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return sign * (Number(whole) * 100 + Number(frac.padEnd(2, '0')));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ymd = (y, m, d) => {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isDate(iso) && new Date(`${iso}T00:00:00Z`).getUTCDate() === d ? iso : null;
};

// dayFirst: whether slash dates are DD/MM (decided once for the whole file).
export function parseDate(v, dayFirst = false) {
  const s = String(v ?? '').trim();
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) return dayFirst ? ymd(+m[3], +m[2], +m[1]) : ymd(+m[3], +m[1], +m[2]);
  if ((m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ,]+(\d{2,4})$/))) return MONTHS[m[2].toLowerCase()] ? ymd(+m[3], MONTHS[m[2].toLowerCase()], +m[1]) : null;
  if ((m = s.match(/^([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2}),? (\d{4})$/))) return MONTHS[m[1].toLowerCase()] ? ymd(+m[3], MONTHS[m[1].toLowerCase()], +m[2]) : null;
  return null;
}

// Works out which columns hold the date, description and amount, with or
// without a header row. Handles one signed amount column, or separate
// debit/credit columns (TD, RBC and most Canadian bank exports).
export function readStatement(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new LedgerError('That file is empty');
  const headerIdx = rows.findIndex((r, i) => i < 10 && r.some((c) => /date/i.test(c)) && !r.some((c) => parseDate(c)));
  const header = headerIdx >= 0 ? rows[headerIdx].map((h) => h.toLowerCase()) : null;
  const data = rows.slice(headerIdx + 1);
  const width = Math.max(...data.map((r) => r.length));
  const colVals = (i) => data.map((r) => r[i] ?? '').filter((v) => v !== '');
  const isNumCol = (i) => { const v = colVals(i); return v.length > 0 && v.every((x) => parseAmount(x) !== null); };
  const isDateCol = (i) => { const v = colVals(i); return v.length > 0 && v.filter((x) => parseDate(x) || parseDate(x, true)).length >= v.length * 0.9; };

  let dateCol = -1, amountCol = -1, creditCol = -1, debitCol = -1, currencyCol = -1;
  let descCols = [];
  if (header) {
    const find = (re, not) => header.findIndex((h) => re.test(h) && !(not && not.test(h)));
    dateCol = find(/date|posted/);
    creditCol = find(/credit|deposit|money in|paid in/);
    debitCol = find(/debit|withdraw|money out|paid out/);
    amountCol = find(/amount|cad\$|usd\$|^cad$|value/, /balance/);
    currencyCol = find(/^currency$/);
    descCols = header.map((h, i) => (/desc|memo|detail|payee|narrative|name|transaction|particular/.test(h) && i !== dateCol && !/date|type|number|amount/.test(h) ? i : -1)).filter((i) => i >= 0);
  } else {
    for (let i = 0; i < width; i++) if (isDateCol(i)) { dateCol = i; break; }
    const nums = [...Array(width).keys()].filter((i) => i !== dateCol && isNumCol(i));
    const exclusive = (a, b) => data.every((r) => !!(r[a] || '') !== !!(r[b] || ''));
    if (nums.length >= 2 && exclusive(nums[0], nums[1])) { debitCol = nums[0]; creditCol = nums[1]; }
    else if (nums.length) amountCol = nums[0];
    descCols = [...Array(width).keys()].filter((i) => i !== dateCol && !nums.includes(i));
  }
  if (dateCol < 0) throw new LedgerError('Couldn’t find a date column in that file');
  if (amountCol < 0 && creditCol < 0) throw new LedgerError('Couldn’t find an amount or deposit column in that file');

  // Slash dates are month-first (Canadian banks) unless a day over 12 says otherwise.
  const dayFirst = data.some((r) => { const m = String(r[dateCol] || '').match(/^(\d{1,2})[-/.](\d{1,2})[-/.]/); return m && +m[1] > 12; });

  const out = [];
  let skipped = 0;
  for (const r of data) {
    const date = parseDate(r[dateCol], dayFirst);
    let cents = null;
    if (creditCol >= 0 && (r[creditCol] || '') !== '') cents = Math.abs(parseAmount(r[creditCol]) ?? NaN);
    else if (debitCol >= 0 && (r[debitCol] || '') !== '') cents = -Math.abs(parseAmount(r[debitCol]) ?? NaN);
    else if (amountCol >= 0) cents = parseAmount(r[amountCol]);
    if (!date || cents === null || Number.isNaN(cents)) { skipped++; continue; }
    out.push({
      date, amount_cents: cents,
      description: descCols.map((i) => r[i]).filter(Boolean).join(' · ').slice(0, 300),
      currency: currencyCol >= 0 && /^[A-Z]{3}$/i.test(r[currencyCol] || '') ? r[currencyCol].toUpperCase() : null,
    });
  }
  return { rows: out, skipped };
}

// Only deposits are imported: the ledger tracks money coming in.
export function importStatement(db, text, { currency = 'CAD' } = {}) {
  const { rows, skipped } = readStatement(text);
  const cur = /^[A-Z]{3}$/.test(String(currency).toUpperCase()) ? String(currency).toUpperCase() : 'CAD';
  const importId = `imp_${Date.now().toString(36)}`;
  const seen = new Map();
  let imported = 0, duplicates = 0, withdrawals = 0;
  const now = nowIso();
  tx(db, () => {
    const insert = db.prepare(`INSERT OR IGNORE INTO bank_lines (import_id, fingerprint, date, description, amount_cents, currency, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      if (r.amount_cents <= 0) { withdrawals++; continue; }
      const c = r.currency || cur;
      // The same deposit twice on one day (two identical e-transfers) stays two
      // lines; the same statement imported twice doesn't double up.
      const key = `${r.date}|${r.amount_cents}|${c}|${r.description.toLowerCase()}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      const fp = crypto.createHash('sha256').update(`${key}|${n}`).digest('base64url').slice(0, 22);
      const res = insert.run(importId, fp, r.date, r.description, r.amount_cents, c, now);
      if (res.changes) imported++; else duplicates++;
    }
    audit(db, 'bank_import', importId, 'import', { imported, duplicates, withdrawals, skipped });
  });
  const matched = autoMatchBank(db);
  return { import_id: importId, imported, duplicates, withdrawals, skipped, matched };
}

// ---------- matching bank lines ----------

function openTargets(db) {
  const taken = new Set(db.prepare('SELECT match_type, match_id FROM bank_lines WHERE match_type IS NOT NULL AND ignored_at IS NULL').all()
    .map((r) => `${r.match_type}:${r.match_id}`));
  const payouts = db.prepare("SELECT id, arrival_date AS date, amount_cents, currency, status FROM stripe_payouts WHERE status IN ('paid', 'in_transit')").all()
    .filter((p) => !taken.has(`payout:${p.id}`))
    .map((p) => ({ type: 'payout', id: p.id, date: p.date, amount_cents: p.amount_cents, currency: p.currency, label: `Stripe payout ${p.id.slice(-8)}` }));
  const manual = ledgerPayments(db)
    .filter((p) => p.source === 'manual' && !p.ignored_at && MANUAL_DEPOSITS.includes(p.method) && !taken.has(`payment:${p.id}`))
    .map((p) => ({
      type: 'payment', id: String(p.id), date: localDate(p.received_at), amount_cents: p.amount_cents, currency: p.currency,
      label: `${p.method}${p.invoice_id ? ` for ${lineRef(p.invoice_id, p.suffix)}` : ''}${p.client_name ? ` · ${p.client_name}` : ''}`,
    }));
  return [...payouts, ...manual];
}

// How far a bank date may be from the payout or payment date. Payouts land a
// day or two either side; cheques and e-transfers can be deposited later.
const WINDOW = { payout: [-2, 5], payment: [-3, 14] };
const fits = (t, line) => {
  const d = daysBetween(t.date, line.date);
  return t.currency === line.currency && t.amount_cents === line.amount_cents && d >= WINDOW[t.type][0] && d <= WINDOW[t.type][1];
};

// Matches a bank line only when one candidate is clearly the right one.
export function autoMatchBank(db) {
  const lines = db.prepare('SELECT * FROM bank_lines WHERE match_type IS NULL AND ignored_at IS NULL ORDER BY date, id').all();
  if (!lines.length) return 0;
  let targets = openTargets(db);
  let n = 0;
  tx(db, () => {
    for (const line of lines) {
      const hits = targets.filter((t) => fits(t, line))
        .map((t) => ({ t, dist: Math.abs(daysBetween(t.date, line.date)) }))
        .sort((a, b) => a.dist - b.dist);
      if (!hits.length || (hits[1] && hits[1].dist === hits[0].dist)) continue;
      const t = hits[0].t;
      setMatch(db, line, t, 'auto');
      targets = targets.filter((x) => x !== t);
      n++;
    }
  });
  return n;
}

function setMatch(db, line, t, how) {
  db.prepare('UPDATE bank_lines SET match_type = ?, match_id = ?, matched_at = ?, match_method = ? WHERE id = ?')
    .run(t.type, String(t.id), nowIso(), how, line.id);
  audit(db, 'bank_line', line.id, 'match', { [t.type]: String(t.id), how, amount_cents: line.amount_cents, date: line.date });
}

function requireLine(db, id) {
  const line = db.prepare('SELECT * FROM bank_lines WHERE id = ?').get(Number(id));
  if (!line) throw new LedgerError('Bank line not found', 404);
  return line;
}

export function matchBankLine(db, id, { type, target }) {
  return tx(db, () => {
    const line = requireLine(db, id);
    if (line.ignored_at) throw new LedgerError('Restore this line before matching it');
    const t = openTargets(db).find((x) => x.type === type && x.id === String(target));
    if (!t) throw new LedgerError('That payout or payment is already matched, or doesn’t exist');
    if (t.currency !== line.currency) throw new LedgerError('The currencies don’t match');
    if (line.match_type) audit(db, 'bank_line', line.id, 'unmatch', { [line.match_type]: line.match_id });
    setMatch(db, line, t, 'manual');
    return { ok: true, amount_differs: t.amount_cents !== line.amount_cents };
  });
}

export function unmatchBankLine(db, id) {
  tx(db, () => {
    const line = requireLine(db, id);
    if (!line.match_type) return;
    db.prepare('UPDATE bank_lines SET match_type = NULL, match_id = NULL, matched_at = NULL, match_method = NULL WHERE id = ?').run(line.id);
    audit(db, 'bank_line', line.id, 'unmatch', { [line.match_type]: line.match_id });
  });
}

export function ignoreBankLine(db, id, note) {
  tx(db, () => {
    const line = requireLine(db, id);
    db.prepare('UPDATE bank_lines SET ignored_at = ?, note = ?, match_type = NULL, match_id = NULL, matched_at = NULL, match_method = NULL WHERE id = ?')
      .run(nowIso(), String(note || '').trim().slice(0, 300), line.id);
    audit(db, 'bank_line', line.id, 'ignore', { note: String(note || '').trim() });
  });
}

export function restoreBankLine(db, id) {
  tx(db, () => {
    const line = requireLine(db, id);
    db.prepare('UPDATE bank_lines SET ignored_at = NULL, note = NULL WHERE id = ?').run(line.id);
    audit(db, 'bank_line', line.id, 'restore', {});
  });
}

// Bank lines in a period, each with what it's matched to or, if unmatched,
// the payouts and payments it could be.
export function bankLines(db, { from, to }) {
  const targets = openTargets(db);
  const describe = (type, id) => {
    if (type === 'payout') {
      const p = db.prepare('SELECT arrival_date, amount_cents, currency FROM stripe_payouts WHERE id = ?').get(id);
      return p ? `Stripe payout of ${(p.amount_cents / 100).toFixed(2)} ${p.currency}, ${p.arrival_date}` : `Stripe payout ${id}`;
    }
    const p = ledgerPayments(db).find((x) => String(x.id) === String(id));
    return p ? `${p.method} ${p.invoice_id ? `for ${lineRef(p.invoice_id, p.suffix)}` : ''}${p.client_name ? ` · ${p.client_name}` : ''}, ${localDate(p.received_at)}` : `Payment ${id}`;
  };
  return db.prepare('SELECT * FROM bank_lines WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC').all(from, to).map((l) => {
    const base = {
      id: l.id, date: l.date, description: l.description, amount_cents: l.amount_cents, currency: l.currency,
      match_type: l.match_type, match_id: l.match_id, match_method: l.match_method, ignored_at: l.ignored_at, note: l.note,
    };
    if (l.match_type) return { ...base, matched_to: describe(l.match_type, l.match_id) };
    if (l.ignored_at) return base;
    const options = targets
      .filter((t) => t.currency === l.currency && Math.abs(daysBetween(t.date, l.date)) <= 30)
      .map((t) => ({ ...t, exact: t.amount_cents === l.amount_cents, dist: Math.abs(daysBetween(t.date, l.date)) }))
      .sort((a, b) => b.exact - a.exact || a.dist - b.dist)
      .slice(0, 25);
    return { ...base, options };
  });
}
