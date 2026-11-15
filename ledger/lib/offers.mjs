// Plan choices. The client gets a link showing a few plans (for example
// hosting, or hosting plus changes) and picks one. Picking turns the plan
// choice into an invoice with the same number and the same link, so you know
// who chose what, and they land straight on their invoice.
import { tx } from './db.mjs';
import { randomToken, isInvoiceId } from './ids.mjs';
import {
  LedgerError, audit, todayToronto, nextInvoiceId, createInvoice, getInvoice, markSent, saveClientFromInvoice,
} from './ledger.mjs';
import { money } from './invoice-page.mjs';

const nowIso = () => new Date().toISOString();
const validEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const INTERVALS = { month: 'monthly', year: 'annual' };

function row(db, id) {
  const r = db.prepare('SELECT * FROM plan_offers WHERE id = ?').get(String(id || '').toUpperCase());
  if (!r) throw new LedgerError('Plan choice not found', 404);
  return r;
}

function shape(db, r) {
  const options = JSON.parse(r.options);
  const chosen = r.chosen_key ? options.find((o) => o.key === r.chosen_key) || null : null;
  const inv = r.chosen_key ? db.prepare('SELECT id, voided_at FROM invoices WHERE id = ?').get(r.id) : null;
  const status = r.cancelled_at ? 'Withdrawn' : chosen ? 'Chosen' : r.sent_date ? 'Waiting' : 'Not sent';
  return { ...r, hst_enabled: !!r.hst_enabled, options, chosen, invoice_id: inv?.id || null, status };
}

export function getOffer(db, id) { return shape(db, row(db, id)); }

export function getOfferByToken(db, token) {
  const r = typeof token === 'string' && /^[A-Za-z0-9_-]{20,40}$/.test(token)
    ? db.prepare('SELECT * FROM plan_offers WHERE public_token = ?').get(token) : null;
  if (!r) throw new LedgerError('Plan choice not found', 404);
  return shape(db, r);
}

export function listOffers(db, { open = false } = {}) {
  const where = open ? 'WHERE chosen_key IS NULL AND cancelled_at IS NULL' : '';
  return db.prepare(`SELECT * FROM plan_offers ${where} ORDER BY created_at DESC`).all().map((r) => shape(db, r));
}

// options: [{ price, name?, details? }] for a Stripe price: amount, currency,
// interval and product come from the matching price in `catalogue` (from
// listProductPrices), so what the client sees is what Stripe charges.
// Or [{ custom: true, name, amount_cents, interval: 'month' | 'year' | null, details? }]
// for anything else, in input.currency; Stripe gets a price made for the invoice.
function customOption(o, currency) {
  const name = String(o.name || '').trim().slice(0, 80);
  if (!name) throw new LedgerError('Give each custom option a name');
  const amount = Number(o.amount_cents);
  if (!Number.isInteger(amount) || amount <= 0) throw new LedgerError(`Enter an amount for “${name}”`);
  const interval = o.interval || null;
  if (interval && !INTERVALS[interval]) throw new LedgerError(`“${name}” must be monthly, yearly or one-time`);
  return { price: null, product: null, custom: true, name, details: String(o.details || '').trim().slice(0, 1500), amount_cents: amount, currency, interval };
}

export function createOffer(db, input, catalogue) {
  const client_name = String(input.client_name || '').trim();
  if (!client_name) throw new LedgerError('Client name is required');
  const client_email = String(input.client_email || '').trim();
  if (client_email && !validEmail(client_email)) throw new LedgerError('Client email doesn’t look right');
  const payments = Number(input.payments ?? 12);
  if (!Number.isInteger(payments) || payments < 1 || payments > 120) throw new LedgerError('Number of payments must be between 1 and 120');
  const picked = Array.isArray(input.options) ? input.options : [];
  if (picked.length < 1) throw new LedgerError('Pick at least one plan to offer');
  if (picked.length > 4) throw new LedgerError('Offer at most four plans');
  const fromStripe = picked.filter((o) => !o.custom).map((o) => catalogue.find((c) => c.price === o.price)).filter(Boolean);
  const currency = String(fromStripe[0]?.currency || input.currency || 'CAD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new LedgerError('Currency must be a 3-letter code');
  const options = picked.map((o, i) => {
    if (o.custom) return { key: String(i + 1), ...customOption(o, currency) };
    const p = catalogue.find((c) => c.price === o.price);
    if (!p) throw new LedgerError('One of those plans isn’t an active price in Stripe any more. Reload and pick again.');
    return {
      key: String(i + 1), price: p.price, product: p.product,
      name: String(o.name || p.name).trim().slice(0, 80) || p.name,
      details: String(o.details ?? p.description ?? '').trim().slice(0, 1500),
      amount_cents: p.amount_cents, currency: p.currency, interval: p.interval,
    };
  });
  if (new Set(options.map((o) => o.currency)).size > 1) throw new LedgerError('All the plans need to be in the same currency');
  const prices = options.filter((o) => o.price).map((o) => o.price);
  if (new Set(prices).size !== prices.length) throw new LedgerError('Each plan can only be offered once');

  return tx(db, () => {
    const wanted = String(input.id || '').toUpperCase();
    const taken = (id) => db.prepare('SELECT 1 FROM invoices WHERE id = ? UNION ALL SELECT 1 FROM plan_offers WHERE id = ?').get(id, id);
    const id = isInvoiceId(wanted) && !taken(wanted) ? wanted : nextInvoiceId(db);
    const client = saveClientFromInvoice(db, { client_name, client_email, client_address: String(input.client_address || '').trim() });
    const now = nowIso();
    db.prepare(`INSERT INTO plan_offers (id, client_id, client_name, client_email, client_address, message, options, hst_enabled, payments,
        public_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, client.id, client.name, client_email, String(input.client_address || '').trim(), String(input.message || '').trim().slice(0, 3000),
        JSON.stringify(options), input.hst_enabled === false ? 0 : 1, payments, randomToken(), now, now);
    audit(db, 'invoice', id, 'offer_create', { client_name: client.name, plans: options.map((o) => o.name) });
    return id;
  });
}

export function markOfferSent(db, id, { sent_to, sent_date = todayToronto() }) {
  const r = row(db, id);
  if (r.cancelled_at) throw new LedgerError('This plan choice was withdrawn');
  db.prepare('UPDATE plan_offers SET sent_date = COALESCE(sent_date, ?), sent_to = ?, updated_at = ? WHERE id = ?').run(sent_date, sent_to || '', nowIso(), r.id);
  audit(db, 'invoice', r.id, 'offer_sent', { sent_to });
}

export function cancelOffer(db, id) {
  const r = row(db, id);
  if (r.chosen_key) throw new LedgerError('The client has already chosen. Void the invoice instead.');
  if (r.cancelled_at) return;
  db.prepare('UPDATE plan_offers SET cancelled_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), r.id);
  audit(db, 'invoice', r.id, 'offer_cancel', {});
}

// The client picks a plan. Creates the invoice: N monthly (or yearly) payments
// of that plan's price, first one due today, filed under its Stripe product.
// Returns { invoice_id, option, created }; picking again is harmless.
export function chooseOffer(db, token, key, today = todayToronto()) {
  return tx(db, () => {
    const o = getOfferByToken(db, token);
    if (o.cancelled_at) throw new LedgerError('This plan choice was withdrawn', 410);
    if (o.chosen_key) return { invoice_id: o.id, option: o.chosen, created: false };
    const opt = o.options.find((x) => x.key === String(key));
    if (!opt) throw new LedgerError('That plan isn’t one of the choices', 400);
    const id = createInvoice(db, {
      id: o.id,
      client_name: o.client_name, client_email: o.client_email, client_address: o.client_address,
      description: opt.details ? `${opt.name}\n${opt.details}` : opt.name,
      currency: o.options[0].currency, hst_enabled: o.hst_enabled,
      // A one-time item (like a website build) is a single payment due today.
      schedule: INTERVALS[opt.interval] || 'one_time', count: opt.interval ? o.payments : 1, first_due: today, issue_date: today,
      line_items: [opt.interval ? {
        description: `${opt.name}: ${o.payments} ${opt.interval}${o.payments === 1 ? '' : 's'} × ${money(opt.amount_cents, opt.currency)}`,
        amount_cents: opt.amount_cents * o.payments,
      } : { description: opt.name, amount_cents: opt.amount_cents }],
      stripe_product: opt.product,
      notes: `The client chose “${opt.name}” from plan choice ${o.id} on ${today}.`,
    }, { reserved: { public_token: o.public_token } });
    db.prepare('UPDATE plan_offers SET chosen_key = ?, chosen_at = ?, updated_at = ? WHERE id = ?').run(opt.key, nowIso(), nowIso(), o.id);
    audit(db, 'invoice', id, 'plan_chosen', { plan: opt.name, amount_cents: opt.amount_cents, currency: opt.currency, interval: opt.interval });
    // The client already has the link, so the invoice counts as sent.
    markSent(db, id, { sent_date: today, sent_to: o.sent_to || o.client_email || '', sent_via: 'other' });
    return { invoice_id: id, option: opt, created: true };
  });
}

