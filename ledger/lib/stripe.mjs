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
      // Subscription checkouts are recorded from invoice.paid, which also covers renewals.
      if (o.mode === 'subscription') return { skip: 'subscription checkout (recorded from invoice.paid)' };
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
        const list = await stripe.get('/invoice_payments', { invoice: o.id }).catch(() => null);
        pi = list?.data?.find((x) => x.status === 'paid')?.payment?.payment_intent || null;
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
    line_items: [{ quantity: 1, price_data: { currency: inv.currency.toLowerCase(), unit_amount: line.outstanding_cents, product_data: { name } } }],
    metadata: meta,
    payment_intent_data: { description: `Invoice ${ref} — ${inv.client_name}`, metadata: meta },
    customer_email: inv.client_email || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return session.url;
}

// Fallback when the key can't create Checkout Sessions: a reusable Payment
// Link for this one payment, with the same metadata so it matches the same way.
export async function createLinePaymentLink(stripe, inv, line, { successUrl }) {
  const ref = lineRef(inv.id, line.suffix);
  const of = inv.lines.length > 1 ? ` (payment ${line.suffix} of ${inv.lines.length})` : '';
  const meta = { invoice_id: inv.id, payment_suffix: String(line.suffix).padStart(2, '0'), invoice_ref: ref, source: 'pk-ledger' };
  const price = await stripe.post('/prices', {
    currency: inv.currency.toLowerCase(), unit_amount: line.outstanding_cents,
    product_data: { name: `Invoice ${ref}${line.label ? ` · ${line.label}` : ''}${of}` },
  });
  const link = await stripe.post('/payment_links', {
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: meta,
    payment_intent_data: { description: `Invoice ${ref} — ${inv.client_name}`, metadata: meta },
    after_completion: { type: 'redirect', redirect: { url: successUrl } },
  });
  return { id: link.id, url: link.url };
}

// ---------- payment links ----------

export async function createPaymentLink(stripe, inv, siteUrl) {
  const lines = inv.lines;
  const meta = { invoice_id: inv.id, source: 'pk-ledger' };
  const currency = inv.currency.toLowerCase();
  const redirect = { type: 'redirect', redirect: { url: `${siteUrl}/payment-thanks` } };

  if (inv.schedule === 'one_time') {
    const ref = lineRef(inv.id, 1);
    const lineMeta = { ...meta, payment_suffix: '01', invoice_ref: ref };
    const price = await stripe.post('/prices', {
      currency, unit_amount: lines[0].amount_cents,
      product_data: { name: `Invoice ${ref}` },
    });
    const link = await stripe.post('/payment_links', {
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: lineMeta,
      payment_intent_data: { description: `Invoice ${ref} — ${inv.client_name}`, metadata: lineMeta },
      after_completion: redirect,
    });
    return { link_id: link.id, url: link.url };
  }

  // Recurring: one subscription, one charge per payment line. The ledger
  // matches each renewal to the next unpaid line and cancels the subscription
  // after the last one.
  const amounts = new Set(lines.map((l) => l.amount_cents));
  if (amounts.size !== 1) {
    throw new Error('A Stripe subscription charges the same amount each time. Make every payment the same amount, or collect them another way.');
  }
  const interval = inv.schedule === 'monthly' ? 'month' : 'year';
  const desc = `Invoice ${inv.id} — ${lines.length} ${inv.schedule} payments (${lineRef(inv.id, 1)} to ${lineRef(inv.id, lines.length)})`;
  const price = await stripe.post('/prices', {
    currency, unit_amount: lines[0].amount_cents, recurring: { interval },
    product_data: { name: `Invoice ${inv.id}` },
  });
  const link = await stripe.post('/payment_links', {
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: meta,
    subscription_data: { description: desc, metadata: meta },
    after_completion: redirect,
  });
  return { link_id: link.id, url: link.url };
}

export async function cancelSubscriptionAtPeriodEnd(stripe, subId) {
  return stripe.post(`/subscriptions/${subId}`, { cancel_at_period_end: 'true' });
}
