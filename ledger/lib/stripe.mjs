import crypto from 'node:crypto';
import { lineRef } from './ids.mjs';

// ---------- webhook signatures ----------

export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = Object.groupBy(String(header).split(',').map((kv) => kv.split('=')), ([k]) => k);
  const t = Number(parts.t?.[0]?.[1]);
  const sigs = (parts.v1 || []).map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => {
    const buf = Buffer.from(s, 'hex');
    return buf.length === expected.length && crypto.timingSafeEqual(buf, expected);
  });
}

// For tests and local development.
export function signStripePayload(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

// ---------- API ----------

function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

export function makeStripe(secretKey, fetchImpl = fetch) {
  if (!secretKey) return null;
  async function call(method, path, params) {
    const body = params ? formEncode(params).join('&') : '';
    const url = `https://api.stripe.com/v1${path}${method === 'GET' && body ? `?${body}` : ''}`;
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: method === 'GET' ? undefined : body,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Stripe: ${json.error?.message || res.status}`);
    return json;
  }
  return {
    get: (path, params) => call('GET', path, params),
    post: (path, params) => call('POST', path, params),
    del: (path, params) => call('DELETE', path, params),
  };
}

// ---------- events -> payment records ----------

export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'invoice.paid',
  'payment_intent.succeeded',
];

// Events that change a payment we already have: refunds and disputes.
export const ADJUSTMENT_EVENTS = [
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
];

const idOf = (v) => (typeof v === 'string' ? v : v?.id) || null;

// Returns { kind: 'refund' | 'dispute', ... } or { skip: reason }.
export function adjustmentFromEvent(event) {
  const o = event.data?.object || {};
  if (event.type === 'charge.refunded') {
    return { kind: 'refund', payment_intent: idOf(o.payment_intent), charge: o.id, amount_refunded: o.amount_refunded ?? 0 };
  }
  if (event.type.startsWith('charge.dispute.')) {
    return { kind: 'dispute', payment_intent: idOf(o.payment_intent), charge: idOf(o.charge), amount: o.amount ?? 0, status: o.status || 'needs_response' };
  }
  return { skip: `event type ${event.type} not handled` };
}

function invoiceNumberFromCustomFields(fields = []) {
  const f = fields.find((c) => /invoice/i.test(`${c.key} ${c.label?.custom || ''}`)) ;
  return f?.text?.value || f?.dropdown?.value || f?.numeric?.value || null;
}

const isoFromUnix = (s) => new Date((s || Math.floor(Date.now() / 1000)) * 1000).toISOString();

// Returns a payment record to upsert, or { skip: reason }.
// `stripe` (optional) is used to look up details the event leaves out.
export async function paymentFromEvent(event, stripe) {
  const o = event.data?.object || {};
  const base = { stripe_event_id: event.id, stripe_type: event.type, received_at: isoFromUnix(event.created) };

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      // Subscription checkouts: payments are recorded from invoice.paid (which also
      // covers renewals); this event says which invoice the subscription is for.
      if (o.mode === 'subscription') {
        const subId = idOf(o.subscription);
        if (!subId) return { skip: 'subscription checkout without a subscription' };
        let invoiceId = o.metadata?.invoice_id || null;
        if (!invoiceId && stripe) invoiceId = (await stripe.get(`/subscriptions/${subId}`)).metadata?.invoice_id || null;
        return invoiceId ? { subscription_started: { id: subId, invoice_id: String(invoiceId).toUpperCase() } } : { skip: 'subscription checkout not from the ledger' };
      }
      if (o.payment_status !== 'paid') return { skip: `checkout not paid yet (${o.payment_status})` };
      const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
      return {
        ...base,
        ref: pi || o.id,
        stripe_object_id: pi || o.id,
        amount_cents: o.amount_total ?? 0,
        currency: String(o.currency || '').toUpperCase(),
        payer_name: o.customer_details?.name,
        payer_email: o.customer_details?.email,
        invoice_ref_entered: invoiceNumberFromCustomFields(o.custom_fields),
        metadata: o.metadata || {},
      };
    }

    case 'invoice.paid': {
      if (!o.amount_paid) return { skip: 'zero-amount invoice' };
      const subId = o.subscription || o.parent?.subscription_details?.subscription || null;
      let metadata = o.subscription_details?.metadata || o.parent?.subscription_details?.metadata || {};
      if (subId && !Object.keys(metadata).length && stripe) {
        metadata = (await stripe.get(`/subscriptions/${subId}`)).metadata || {};
      }
      // Older API versions put the PaymentIntent on the invoice; newer ones list it under invoice payments.
      let pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
      if (!pi && stripe) {
        // If this lookup fails, let it throw: Stripe retries the event, rather than
        // the payment being stored under the wrong ID and recorded twice.
        const list = await stripe.get('/invoice_payments', { invoice: o.id });
        pi = idOf(list?.data?.find((x) => x.status === 'paid')?.payment?.payment_intent) || null;
      }
      return {
        ...base,
        ref: pi || o.id,
        stripe_object_id: o.id,
        stripe_subscription: subId,
        amount_cents: o.amount_paid,
        currency: String(o.currency || '').toUpperCase(),
        payer_name: o.customer_name,
        payer_email: o.customer_email,
        description: o.lines?.data?.[0]?.description || o.description || null,
        metadata,
      };
    }

    case 'payment_intent.succeeded': {
      return {
        ...base,
        ref: o.id,
        stripe_object_id: o.id,
        amount_cents: o.amount_received ?? o.amount ?? 0,
        currency: String(o.currency || '').toUpperCase(),
        payer_email: o.receipt_email,
        description: o.description,
        metadata: o.metadata || {},
      };
    }

    default:
      return { skip: `event type ${event.type} not handled` };
  }
}

// ---------- checkout for one payment ----------

// A Checkout Session for whatever is still owed on one payment of an invoice.
// Made when the client presses Pay, so the amount is always current.
export async function createLineCheckout(stripe, inv, line, { successUrl, cancelUrl }) {
  const ref = lineRef(inv.id, line.suffix);
  const of = inv.lines.length > 1 ? ` (payment ${line.suffix} of ${inv.lines.length})` : '';
  const name = `Invoice ${ref}${line.label ? ` · ${line.label}` : ''}${of}`;
  const meta = { invoice_id: inv.id, payment_suffix: String(line.suffix).padStart(2, '0'), invoice_ref: ref, source: 'pk-ledger' };
  const session = await stripe.post('/checkout/sessions', {
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: inv.currency.toLowerCase(), unit_amount: line.outstanding_cents, ...productOf(inv, name) } }],
    metadata: meta,
    payment_intent_data: { description: `Invoice ${ref} — ${inv.client_name}`, metadata: meta },
    customer_email: inv.client_email || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return { id: session.id || null, url: session.url };
}

// Fallback when the key can't create Checkout Sessions: a reusable Payment
// Link for this one payment, with the same metadata so it matches the same way.
export async function createLinePaymentLink(stripe, inv, line, { successUrl }) {
  const ref = lineRef(inv.id, line.suffix);
  const of = inv.lines.length > 1 ? ` (payment ${line.suffix} of ${inv.lines.length})` : '';
  const meta = { invoice_id: inv.id, payment_suffix: String(line.suffix).padStart(2, '0'), invoice_ref: ref, source: 'pk-ledger' };
  const price = await stripe.post('/prices', {
    currency: inv.currency.toLowerCase(), unit_amount: line.outstanding_cents,
    ...productOf(inv, `Invoice ${ref}${line.label ? ` · ${line.label}` : ''}${of}`),
  });
  const link = await stripe.post('/payment_links', {
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: meta,
    payment_intent_data: { description: `Invoice ${ref} — ${inv.client_name}`, metadata: meta },
    after_completion: { type: 'redirect', redirect: { url: successUrl } },
  });
  return { id: link.id, url: link.url };
}

// ---------- products ----------

// Charges for an invoice tied to a Stripe product are filed under that product;
// otherwise Stripe gets a one-off product named after the invoice.
function productOf(inv, name) {
  return inv.stripe_product ? { product: inv.stripe_product } : { product_data: { name } };
}

// For a subscription, reuse the product's existing price when it's the same
// amount and interval, so Stripe shows the client on that plan. Otherwise add
// a price to the product (for example, the same plan with HST added).
async function recurringPrice(stripe, inv, { currency, amount, interval }) {
  if (inv.stripe_product) {
    const { data = [] } = await stripe.get('/prices', { product: inv.stripe_product, active: 'true', type: 'recurring', limit: 100 });
    const same = data.find((p) => p.currency === currency && p.unit_amount === amount && p.recurring?.interval === interval && (p.recurring?.interval_count ?? 1) === 1);
    if (same) return same;
  }
  // What the client sees at checkout: what it's for, then the invoice number.
  const what = String(inv.description || '').split('\n')[0].trim().slice(0, 60);
  return stripe.post('/prices', { currency, unit_amount: amount, recurring: { interval }, ...productOf(inv, what ? `${what} · Invoice ${inv.id}` : `Invoice ${inv.id}`) });
}

// Which business a Stripe product belongs to, shown in front of its name in
// the ledger's pickers. The account also sells EZSay subscriptions; everything
// else is PK Labs. A product's "brand" metadata in Stripe overrides this.
const PRODUCT_BRANDS = {
  prod_UPymbPCbhJb1TB: 'EZSay', // Individual
  prod_UPymQUkBVib8sW: 'EZSay', // Professional Editor
};
const DEFAULT_BRAND = 'PK Labs';

// Active prices on the account, for the "Start from a Stripe product" picker.
// Leaves out the one-off products the ledger makes for invoices.
export async function listProductPrices(stripe) {
  const out = [];
  let starting_after;
  for (let page = 0; page < 5; page++) {
    const res = await stripe.get('/prices', { active: 'true', limit: 100, 'expand[]': 'data.product', starting_after });
    for (const p of res.data) {
      const prod = p.product;
      if (!prod || typeof prod !== 'object' || !prod.active || /^Invoice /.test(prod.name) || !p.unit_amount) continue;
      if (p.recurring && (p.recurring.interval_count ?? 1) !== 1) continue;
      const interval = p.recurring ? p.recurring.interval : null;
      if (interval && !['month', 'year'].includes(interval)) continue;
      const brand = String(prod.metadata?.brand || PRODUCT_BRANDS[prod.id] || DEFAULT_BRAND);
      out.push({ price: p.id, product: prod.id, brand, name: prod.name, description: prod.description || '', amount_cents: p.unit_amount, currency: p.currency.toUpperCase(), interval });
    }
    if (!res.has_more) break;
    starting_after = res.data.at(-1).id;
  }
  // PK Labs first, then by name and price.
  const rank = (b) => (b === DEFAULT_BRAND ? 0 : 1);
  return out.sort((a, b) => rank(a.brand) - rank(b.brand) || a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name) || a.amount_cents - b.amount_cents);
}

// ---------- payment links ----------

// today: the date in Toronto, so a first payment due later starts the
// subscription with a free trial until then.
export async function createPaymentLink(stripe, inv, siteUrl, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const lines = inv.lines;
  const meta = { invoice_id: inv.id, source: 'pk-ledger' };
  const currency = inv.currency.toLowerCase();
  const redirect = { type: 'redirect', redirect: { url: `${siteUrl}/payment-thanks` } };

  if (inv.schedule === 'one_time') {
    const ref = lineRef(inv.id, 1);
    const lineMeta = { ...meta, payment_suffix: '01', invoice_ref: ref };
    const price = await stripe.post('/prices', {
      currency, unit_amount: lines[0].amount_cents,
      ...productOf(inv, `Invoice ${ref}`),
    });
    const link = await stripe.post('/payment_links', {
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: lineMeta,
      payment_intent_data: { description: `Invoice ${ref} — ${inv.client_name}`, metadata: lineMeta },
      after_completion: redirect,
    });
    return { link_id: link.id, url: link.url };
  }

  const { items, extra, desc } = await subscriptionItems(stripe, inv);
  const first = lines[0].due_date;
  const waitDays = !extra && first && first > today ? daysFrom(today, first) : 0;
  const link = await stripe.post('/payment_links', {
    line_items: items,
    metadata: meta,
    subscription_data: { description: desc, metadata: meta, ...(waitDays >= 1 ? { trial_period_days: Math.min(waitDays, 730) } : {}) },
    after_completion: redirect,
  });
  return { link_id: link.id, url: link.url };
}

const daysFrom = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// Can a Stripe subscription collect this invoice? Every payment the same, or a
// larger first one that catches up on whole periods already passed (the extra
// is a one-time charge on the first Stripe invoice).
export function subscriptionShape(inv) {
  const lines = inv.lines || [];
  if (!['monthly', 'annual'].includes(inv.schedule) || !lines.length) return null;
  const regular = lines.at(-1).amount_cents;
  const rest = new Set(lines.slice(1).map((l) => l.amount_cents));
  const extra = lines[0].amount_cents - regular;
  if (!regular || rest.size !== 1 || extra < 0 || extra % regular !== 0) return null;
  return { regular, extra };
}

// Recurring: one subscription, one charge per payment line. The ledger
// matches each renewal to the next unpaid line and cancels the subscription
// after the last one.
async function subscriptionItems(stripe, inv) {
  const lines = inv.lines;
  const shape = subscriptionShape(inv);
  if (!shape) {
    throw new Error('A Stripe subscription charges the same amount each time. Make every payment the same amount, or collect them another way.');
  }
  const { regular, extra } = shape;
  const currency = inv.currency.toLowerCase();
  const interval = inv.schedule === 'monthly' ? 'month' : 'year';
  const desc = `Invoice ${inv.id} — ${lines.length} ${inv.schedule} payments (${lineRef(inv.id, 1)} to ${lineRef(inv.id, lines.length)})`;
  const price = await recurringPrice(stripe, inv, { currency, amount: regular, interval });
  const items = [{ price: price.id, quantity: 1 }];
  if (extra > 0) {
    const what = String(inv.description || '').split('\n')[0].trim().slice(0, 60);
    const catchUp = await stripe.post('/prices', {
      currency, unit_amount: extra,
      ...productOf(inv, `${what ? `${what} · ` : ''}Invoice ${inv.id}: ${lines[0].label || 'earlier months'}`),
    });
    items.push({ price: catchUp.id, quantity: 1 });
  }
  return { items, extra, desc };
}

// "Set up monthly payments": a fresh Checkout Session each time it's pressed,
// so a first payment due later waits until exactly that date, however long
// the client took to press it.
export async function createAutopayCheckout(stripe, inv, { today, successUrl, cancelUrl, nowSec = Math.floor(Date.now() / 1000) }) {
  const { items, extra, desc } = await subscriptionItems(stripe, inv);
  const meta = { invoice_id: inv.id, source: 'pk-ledger' };
  const first = inv.lines[0].due_date;
  const wait = {};
  if (!extra && first && first > today) {
    // Charge on the morning of the due date in Toronto (about 9 or 10 am).
    const at = Math.floor(Date.parse(`${first}T14:00:00Z`) / 1000);
    if (at - nowSec >= 2 * 86_400 + 600) wait.trial_end = at;
    else wait.trial_period_days = Math.max(1, daysFrom(today, first));
  }
  const session = await stripe.post('/checkout/sessions', {
    mode: 'subscription',
    line_items: items,
    metadata: meta,
    subscription_data: { description: desc, metadata: meta, ...wait },
    customer_email: inv.client_email || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return { id: session.id || null, url: session.url };
}

// Whether a Checkout Session made earlier was completed, is still open, or is done with.
export async function sessionStatus(stripe, id) {
  if (!id || !stripe.get) return null;
  try { return (await stripe.get(`/checkout/sessions/${id}`)).status || null; } catch { return null; }
}

export async function expireSession(stripe, id) {
  try { await stripe.post(`/checkout/sessions/${id}/expire`, {}); } catch { /* already finished */ }
}

export async function cancelSubscriptionNow(stripe, subId) {
  return stripe.del(`/subscriptions/${subId}`);
}

export async function deactivatePaymentLink(stripe, linkId) {
  return stripe.post(`/payment_links/${linkId}`, { active: 'false' });
}

export async function cancelSubscriptionAtPeriodEnd(stripe, subId) {
  return stripe.post(`/subscriptions/${subId}`, { cancel_at_period_end: 'true' });
}
