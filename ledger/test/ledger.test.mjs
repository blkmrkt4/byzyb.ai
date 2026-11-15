import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../lib/db.mjs';
import * as L from '../lib/ledger.mjs';
import { randomInvoiceId, findRefs, ID_ALPHABET } from '../lib/ids.mjs';
import { signStripePayload, verifyStripeSignature, paymentFromEvent, createPaymentLink, createLineCheckout, adjustmentFromEvent } from '../lib/stripe.mjs';
import * as A from '../lib/auth.mjs';
import * as R from '../lib/reports.mjs';
import { createApp, makeConfig } from '../server.mjs';

const fresh = () => openDb(':memory:');
const invoice = (db, over = {}) => L.createInvoice(db, {
  client_name: 'Acme Dental', client_email: 'ap@acme.test', subtotal_cents: 100000, issue_date: '2026-11-01', ...over,
});

// ---------- IDs ----------

test('invoice IDs are 4 characters without 0, O, 1, I or L', () => {
  for (const c of '0O1IL') assert.ok(!ID_ALPHABET.includes(c));
  for (let i = 0; i < 500; i++) assert.match(randomInvoiceId(), /^[2-9A-HJKMNP-Z]{4}$/);
});

test('findRefs pulls invoice numbers out of free text', () => {
  assert.deepEqual(findRefs('inv k7m2-01 thanks'), [{ id: 'K7M2', suffix: 1 }]);
  assert.deepEqual(findRefs('Payment for K7M2'), [{ id: 'K7M2', suffix: null }]);
  assert.deepEqual(findRefs('K7M2 - 03'), [{ id: 'K7M2', suffix: 3 }]);
  assert.deepEqual(findRefs('order 1234'), []); // contains 1
  assert.deepEqual(findRefs('ABCDE'), []); // 5 chars
});

// ---------- totals and schedules ----------

test('HST is 13% by default and can be switched off', () => {
  assert.deepEqual(L.computeTotals({ subtotal_cents: 100000 }).total_cents, 113000);
  assert.equal(L.computeTotals({ subtotal_cents: 100000, hst_enabled: false }).total_cents, 100000);
  const t = L.computeTotals({ line_items: [{ description: 'Design', amount_cents: 50000 }, { description: 'Build', amount_cents: 25050 }] });
  assert.equal(t.subtotal_cents, 75050);
  assert.equal(t.hst_cents, 9757); // 9756.5 rounds up
});

test('a monthly schedule numbers payments -01 to -12 and splits cents onto the first', () => {
  const db = fresh();
  const id = invoice(db, { subtotal_cents: 100000, schedule: 'monthly', count: 12, first_due: '2026-01-31' });
  const inv = L.getInvoice(db, id);
  assert.equal(inv.lines.length, 12);
  assert.equal(inv.lines[0].ref, `${id}-01`);
  assert.equal(inv.lines[11].ref, `${id}-12`);
  assert.equal(inv.lines.reduce((a, l) => a + l.amount_cents, 0), 113000);
  assert.equal(inv.lines[0].amount_cents, 9424); // 9416 + 8 leftover cents
  assert.equal(inv.lines[1].due_date, '2026-02-28'); // clamps to month end
  assert.equal(inv.lines[2].due_date, '2026-03-31');
});

test('a one-time invoice has just -01; custom lines must add up to the total', () => {
  const db = fresh();
  const id = invoice(db);
  assert.deepEqual(L.getInvoice(db, id).lines.map((l) => l.ref), [`${id}-01`]);
  assert.throws(() => invoice(db, { schedule: 'monthly', lines: [{ amount_cents: 1, due_date: '2026-11-01' }] }), /add up/);
});

// ---------- status ----------

test('status moves Draft → Sent → Partly paid → Paid, and Overdue when late', () => {
  const db = fresh();
  const id = invoice(db, { schedule: 'monthly', count: 2, first_due: '2026-11-01' });
  const status = (today) => L.getInvoice(db, id, today).status;
  assert.equal(status('2026-11-02'), 'Draft');
  L.markSent(db, id, { sent_via: 'email' });
  assert.equal(status('2026-10-31'), 'Sent');
  assert.equal(status('2026-11-02'), 'Overdue');
  const [l1, l2] = L.getInvoice(db, id).lines;
  L.recordManualPayment(db, { line_id: l1.id, amount_cents: l1.amount_cents, method: 'e-transfer', received_at: '2026-11-01' });
  assert.equal(status('2026-11-15'), 'Partly paid');
  assert.equal(status('2026-12-15'), 'Overdue');
  L.recordManualPayment(db, { line_id: l2.id, amount_cents: l2.amount_cents, method: 'cheque' });
  assert.equal(status('2027-06-01'), 'Paid');
});

test('voiding keeps the record and every change is audited', () => {
  const db = fresh();
  const id = invoice(db);
  L.updateInvoice(db, id, { client_name: 'Acme Dental Inc', subtotal_cents: 200000 });
  L.markSent(db, id, { sent_via: 'stripe' });
  L.voidInvoice(db, id, 'Replaced');
  const inv = L.getInvoice(db, id);
  assert.equal(inv.status, 'Void');
  assert.equal(inv.total_cents, 226000);
  assert.equal(inv.outstanding_cents, 0);
  assert.deepEqual(inv.history.map((h) => h.action).reverse(), ['create', 'edit', 'send', 'void']);
  assert.throws(() => L.updateInvoice(db, id, { notes: 'x' }), /void/i);
  assert.equal(L.listInvoices(db).length, 1);
});

test('amounts lock once sent; client, description and notes stay editable', () => {
  const db = fresh();
  const id = invoice(db);
  L.markSent(db, id, {});
  const out = L.updateInvoice(db, id, { client_name: 'New name', subtotal_cents: 5 });
  assert.equal(out.fullyEditable, false);
  const inv = L.getInvoice(db, id);
  assert.equal(inv.client_name, 'New name');
  assert.equal(inv.subtotal_cents, 100000);
});

test('list filters by status, client and search', () => {
  const db = fresh();
  const a = invoice(db, { client_name: 'Alpha' });
  invoice(db, { client_name: 'Beta' });
  L.markSent(db, a, {});
  assert.equal(L.listInvoices(db, { status: 'Sent' }, '2026-10-01').length, 1);
  assert.equal(L.listInvoices(db, { client: 'Beta' }).length, 1);
  assert.equal(L.listInvoices(db, { q: a.toLowerCase() + '-01' })[0].id, a);
  assert.equal(L.listInvoices(db, { q: 'alp' })[0].id, a);
});

test('CSV escapes quotes and blocks spreadsheet formulas', () => {
  const db = fresh();
  invoice(db, { client_name: '=HYPERLINK("x")', description: 'a, "b"' });
  const csv = L.toCsv(L.listInvoices(db));
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"a, ""b"""/);
});

// ---------- Stripe matching ----------

const checkout = (over = {}) => ({
  id: 'evt_1', type: 'checkout.session.completed', created: 1794000000,
  data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 113000, currency: 'cad',
    customer_details: { name: 'Pat', email: 'pat@acme.test' }, metadata: {}, custom_fields: [], ...over } },
});

test('a payment with invoice metadata matches the right line', async () => {
  const db = fresh();
  const id = invoice(db);
  const rec = await paymentFromEvent(checkout({ metadata: { invoice_id: id, payment_suffix: '01' } }));
  const out = L.upsertStripePayment(db, rec);
  assert.equal(out.matched, `${id}-01`);
  assert.equal(out.invoice_paid, true);
  const inv = L.getInvoice(db, id);
  assert.equal(inv.status, 'Paid');
  assert.equal(inv.lines[0].payments[0].stripe_object_id, 'pi_1');
});

test('the invoice number typed at checkout is used to match', async () => {
  const db = fresh();
  const id = invoice(db);
  const rec = await paymentFromEvent(checkout({
    custom_fields: [{ key: 'invoicenumber', label: { custom: 'Invoice number' }, text: { value: ` ${id.toLowerCase()} ` } }],
  }));
  assert.equal(L.upsertStripePayment(db, rec).matched, `${id}-01`);
});

test('the same payment arriving twice is recorded once', async () => {
  const db = fresh();
  const id = invoice(db);
  L.upsertStripePayment(db, await paymentFromEvent(checkout({ metadata: { invoice_id: id } })));
  const pi = await paymentFromEvent({ id: 'evt_2', type: 'payment_intent.succeeded', created: 1794000001,
    data: { object: { id: 'pi_1', amount_received: 113000, currency: 'cad', metadata: { invoice_id: id } } } });
  const again = L.upsertStripePayment(db, pi);
  assert.equal(again.created, false);
  assert.equal(L.getInvoice(db, id).paid_cents, 113000);
});

test('unmatched payments can be assigned, unassigned, ignored and restored', async () => {
  const db = fresh();
  const id = invoice(db);
  const out = L.upsertStripePayment(db, await paymentFromEvent(checkout({ payment_intent: 'pi_old' })));
  assert.equal(out.matched, null);
  assert.equal(L.unmatchedPayments(db).length, 1);
  const line = L.openLines(db)[0];
  assert.equal(L.assignPayment(db, out.payment_id, line.id), `${id}-01`);
  assert.equal(L.unmatchedPayments(db).length, 0);
  L.unassignPayment(db, out.payment_id);
  L.ignorePayment(db, out.payment_id, 'Hosting');
  assert.equal(L.unmatchedPayments(db).length, 0);
  assert.equal(L.unmatchedPayments(db, { includeIgnored: true }).length, 1);
  L.restorePayment(db, out.payment_id);
  assert.equal(L.unmatchedPayments(db).length, 1);
});

test('subscription renewals fill the next unpaid line in turn', async () => {
  const db = fresh();
  const id = invoice(db, { subtotal_cents: 30000, hst_enabled: false, schedule: 'monthly', count: 3, first_due: '2026-11-01' });
  const paid = (n) => ({ id: `evt_${n}`, type: 'invoice.paid', created: 1794000000 + n,
    data: { object: { id: `in_${n}`, amount_paid: 10000, currency: 'cad', payment_intent: `pi_${n}`, subscription: 'sub_1',
      subscription_details: { metadata: { invoice_id: id } } } } });
  const results = [];
  for (const n of [1, 2, 3]) results.push(L.upsertStripePayment(db, await paymentFromEvent(paid(n))));
  assert.deepEqual(results.map((r) => r.matched), [`${id}-01`, `${id}-02`, `${id}-03`]);
  assert.deepEqual(results.map((r) => r.invoice_paid), [false, false, true]);
  assert.equal(results[2].subscription, 'sub_1');
});

test('a payment in the wrong currency is not auto-matched', async () => {
  const db = fresh();
  const id = invoice(db);
  const out = L.upsertStripePayment(db, await paymentFromEvent(checkout({ currency: 'usd', metadata: { invoice_id: id } })));
  assert.equal(out.matched, null);
});

test('payment links carry the invoice ID and suffix in metadata', async () => {
  const db = fresh();
  const id = invoice(db);
  const calls = [];
  const stripe = { post: async (path, params) => { calls.push([path, params]); return path === '/prices' ? { id: 'price_1' } : { id: 'plink_1', url: 'https://buy.stripe.com/x' }; } };
  const link = await createPaymentLink(stripe, L.getInvoice(db, id), 'https://www.painkiller-labs.com');
  assert.deepEqual(link, { link_id: 'plink_1', url: 'https://buy.stripe.com/x' });
  const pl = calls[1][1];
  assert.equal(pl.metadata.invoice_id, id);
  assert.equal(pl.payment_intent_data.metadata.payment_suffix, '01');
  assert.match(pl.payment_intent_data.description, new RegExp(`${id}-01`));
  assert.equal(calls[0][1].unit_amount, 113000);
});

// ---------- monthly plans and Stripe products ----------

test('monthly HST is worked out per payment so every payment is equal', () => {
  // $65.55 a month for 12 months: HST on the whole would be $1,022.58; per payment it's $8.52 × 12.
  const t = L.computeTotals({ subtotal_cents: 6555 * 12, hst_enabled: true, payments: 12 });
  assert.equal(t.hst_cents, 852 * 12);
  assert.equal(L.computeTotals({ subtotal_cents: 6555 * 12, hst_enabled: true }).hst_cents, 10226);
  const db = fresh();
  const id = invoice(db, { subtotal_cents: 6555 * 12, schedule: 'monthly', count: 12, first_due: '2026-11-15' });
  const inv = L.getInvoice(db, id);
  assert.deepEqual([...new Set(inv.lines.map((l) => l.amount_cents))], [6555 + 852]);
});

test('an invoice remembers its Stripe product, and rejects anything that isn’t one', () => {
  const db = fresh();
  const id = invoice(db, { subtotal_cents: 6000 * 12, hst_enabled: false, schedule: 'monthly', count: 12, first_due: '2026-11-15', stripe_product: 'prod_Hosting1' });
  assert.equal(L.getInvoice(db, id).stripe_product, 'prod_Hosting1');
  assert.throws(() => invoice(db, { stripe_product: 'price_123' }), /Stripe product/);
});

test('a subscription reuses the product’s price when the amount matches', async () => {
  const db = fresh();
  const calls = [];
  const stripe = {
    get: async (path, params) => { calls.push(['GET', path, params]); return { data: [
      { id: 'price_hosting', currency: 'cad', unit_amount: 6000, recurring: { interval: 'month', interval_count: 1 } },
    ] }; },
    post: async (path, params) => { calls.push(['POST', path, params]); return path === '/prices' ? { id: 'price_new' } : { id: 'plink_1', url: 'https://buy.stripe.com/x' }; },
  };
  const plan = (over) => L.getInvoice(db, invoice(db, { subtotal_cents: 6000 * 12, schedule: 'monthly', count: 12, first_due: '2026-11-15', stripe_product: 'prod_Hosting1', ...over }));

  await createPaymentLink(stripe, plan({ hst_enabled: false }), 'https://x');
  assert.equal(calls.find((c) => c[1] === '/payment_links')[2].line_items[0].price, 'price_hosting');
  assert.ok(!calls.some((c) => c[0] === 'POST' && c[1] === '/prices'));

  calls.length = 0;
  await createPaymentLink(stripe, plan({ hst_enabled: true }), 'https://x');
  const made = calls.find((c) => c[0] === 'POST' && c[1] === '/prices')[2];
  assert.equal(made.unit_amount, 6780);
  assert.equal(made.product, 'prod_Hosting1');
  assert.equal(made.product_data, undefined);
  assert.equal(calls.find((c) => c[1] === '/payment_links')[2].line_items[0].price, 'price_new');
});

test('a Pay button for a product invoice files the charge under that product', async () => {
  const db = fresh();
  const inv = L.getInvoice(db, invoice(db, { stripe_product: 'prod_Build1' }));
  let sent;
  const stripe = { post: async (path, params) => { sent = params; return { url: 'https://checkout.stripe.com/x' }; } };
  await createLineCheckout(stripe, inv, inv.lines[0], { successUrl: 'https://x', cancelUrl: 'https://x' });
  assert.equal(sent.line_items[0].price_data.product, 'prod_Build1');
  assert.equal(sent.line_items[0].price_data.product_data, undefined);
});

test('Stripe signatures are checked', () => {
  const body = '{"a":1}';
  assert.ok(verifyStripeSignature(body, signStripePayload(body, 'whsec_x'), 'whsec_x'));
  assert.ok(!verifyStripeSignature(body, signStripePayload(body, 'whsec_y'), 'whsec_x'));
  assert.ok(!verifyStripeSignature(body, signStripePayload(body, 'whsec_x', 1000), 'whsec_x'));
});

// ---------- server ----------

async function server(t, extra = {}, deps = {}) {
  const db = fresh();
  const emails = [];
  const cfg = { ...makeConfig({ PORT: '0', STRIPE_WEBHOOK_SECRET: 'whsec_test' }), ...extra };
  const srv = http.createServer(createApp(cfg, db, {
    stripe: null, sendEmail: async (m) => emails.push(m), sendInvoice: async (m) => emails.push(m), log: { error() {} }, ...deps,
  }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts });
  return { db, emails, req, cfg };
}

test('admin pages need a sign-in and are never indexed', async (t) => {
  const { req } = await server(t);
  const r = await req('/admin/invoices');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/admin/login');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await req('/admin/api/invoices')).status, 401);
  assert.match(await (await req('/robots.txt')).text(), /Disallow: \//);
});

test('magic link sign-in works once, only for the admin address', async (t) => {
  const { req, emails } = await server(t);
  const post = (path, body, cookie) => req(path, { method: 'POST', body: new URLSearchParams(body), headers: cookie ? { cookie } : {} });

  await post('/admin/login', { email: 'someone@else.test' });
  assert.equal(emails.length, 0);
  const r = await post('/admin/login', { email: 'RH@pklabs.ca' });
  assert.equal(r.headers.get('location'), '/admin/login?sent=1');
  assert.equal(emails.length, 1);
  const token = new URL(emails[0].link).searchParams.get('token');

  // Opening the link (as an email scanner would) doesn't use it up.
  assert.equal((await req(`/admin/auth?token=${token}`)).status, 200);
  const signIn = await post('/admin/auth', { token });
  assert.equal(signIn.headers.get('location'), '/admin/dashboard');
  const cookie = signIn.headers.get('set-cookie').split(';')[0];
  assert.match(signIn.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await post('/admin/auth', { token })).status, 400);

  assert.equal((await req('/admin/invoices', { headers: { cookie } })).status, 200);
  const api = await req('/admin/api/invoices', { headers: { cookie } });
  assert.deepEqual(await api.json(), { invoices: [], clients: [] });

  // Writes need the X-Ledger header (blocks cross-site form posts).
  const body = JSON.stringify({ client_name: 'Acme', subtotal_cents: 5000 });
  assert.equal((await req('/admin/api/invoices', { method: 'POST', body, headers: { cookie } })).status, 403);
  const created = await req('/admin/api/invoices', { method: 'POST', body, headers: { cookie, 'x-ledger': '1', 'content-type': 'application/json' } });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.match(id, /^[2-9A-HJKMNP-Z]{4}$/);

  const csv = await req('/admin/api/invoices.csv', { headers: { cookie } });
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.match(await csv.text(), new RegExp(`^Invoice,Client.*\\r\\n${id},Acme`, 's'));

  await post('/admin/logout', {}, cookie);
  assert.equal((await req('/admin/api/invoices', { headers: { cookie } })).status, 401);
});

test('the webhook rejects bad signatures and records good ones', async (t) => {
  const { req, db } = await server(t);
  const id = invoice(db);
  const raw = JSON.stringify(checkout({ metadata: { invoice_id: id, payment_suffix: '01' } }));
  const bad = await req('/api/stripe/webhook', { method: 'POST', body: raw, headers: { 'stripe-signature': signStripePayload(raw, 'nope') } });
  assert.equal(bad.status, 400);
  const good = await req('/api/stripe/webhook', { method: 'POST', body: raw, headers: { 'stripe-signature': signStripePayload(raw, 'whsec_test') } });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).matched, `${id}-01`);
  assert.equal(L.getInvoice(db, id).status, 'Paid');
});

test('a new invoice keeps the number the form showed, unless it is taken', () => {
  const db = openDb(':memory:');
  const shown = L.nextInvoiceId(db);
  assert.equal(invoice(db, { id: shown }), shown);
  const again = invoice(db, { id: shown });
  assert.notEqual(again, shown);
  assert.match(again, /^[2-9A-HJKMNP-Z]{4}$/);
  assert.notEqual(invoice(db, { id: 'OOPS' }), 'OOPS');
});

// ---------- split payments ----------

const split = (db, over = {}) => invoice(db, { subtotal_cents: 300000, hst_enabled: false, schedule: 'split', first_due: '2026-11-20', ...over });

test('a split defaults to a dated deposit and an undated final payment', () => {
  const db = fresh();
  const inv = L.getInvoice(db, split(db), '2026-12-31');
  assert.deepEqual(inv.lines.map((l) => [l.ref.slice(-2), l.amount_cents, l.due_date, l.label]),
    [['01', 150000, '2026-11-20', 'Deposit'], ['02', 150000, null, 'Final payment']]);
});

test('a split can have uneven amounts, labels and blank dates; other schedules need dates', () => {
  const db = fresh();
  const id = split(db, { lines: [
    { amount_cents: 100000, due_date: '2026-11-20', label: 'Deposit' },
    { amount_cents: 50000, due_date: '', label: 'Design sign-off' },
    { amount_cents: 150000, due_date: null, label: 'Launch' },
  ] });
  assert.deepEqual(L.getInvoice(db, id).lines.map((l) => [l.amount_cents, l.due_date, l.label]),
    [[100000, '2026-11-20', 'Deposit'], [50000, null, 'Design sign-off'], [150000, null, 'Launch']]);
  assert.throws(() => invoice(db, { subtotal_cents: 20000, hst_enabled: false, schedule: 'monthly', lines: [
    { amount_cents: 10000, due_date: '2026-11-01' }, { amount_cents: 10000, due_date: null }] }), /needs a due date/);
  assert.throws(() => split(db, { lines: [{ amount_cents: 300000, due_date: '2026-11-20' }] }), /at least two/);
});

test('undated payments are never overdue until a date is set', () => {
  const db = fresh();
  const id = split(db);
  L.markSent(db, id, { sent_date: '2026-11-15' });
  const line1 = L.getInvoice(db, id).lines[0];
  L.recordManualPayment(db, { line_id: line1.id, amount_cents: 150000, received_at: '2026-11-18', method: 'e-transfer' });
  assert.equal(L.getInvoice(db, id, '2027-06-01').status, 'Partly paid');
  L.setLineDueDate(db, id, 2, '2027-01-15');
  assert.equal(L.getInvoice(db, id, '2027-06-01').status, 'Overdue');
  assert.equal(L.getInvoice(db, id).history[0].action, 'due_date');
  L.setLineDueDate(db, id, 2, null);
  assert.equal(L.getInvoice(db, id, '2027-06-01').lines[1].due_date, null);
  assert.throws(() => L.setLineDueDate(db, invoice(db), 1, null), /Only a split/);
});

test('a client checkout is for what is still owed on that one payment', async () => {
  const db = fresh();
  const id = split(db, { client_email: 'pat@acme.test' });
  const line1 = L.getInvoice(db, id).lines[0];
  L.recordManualPayment(db, { line_id: line1.id, amount_cents: 50000, method: 'cheque' });
  const inv = L.getInvoice(db, id);
  const calls = [];
  const stripe = { post: async (path, params) => { calls.push([path, params]); return { url: 'https://checkout.stripe.com/c/pay/cs_x' }; } };
  const url = await createLineCheckout(stripe, inv, inv.lines[0], { successUrl: 'https://s/ok', cancelUrl: 'https://s/no' });
  assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_x');
  const [path, params] = calls[0];
  assert.equal(path, '/checkout/sessions');
  assert.equal(params.line_items[0].price_data.unit_amount, 100000);
  assert.equal(params.line_items[0].price_data.product_data.name, `Invoice ${id}-01 · Deposit (payment 1 of 2)`);
  assert.deepEqual(params.metadata, { invoice_id: id, payment_suffix: '01', invoice_ref: `${id}-01`, source: 'pk-ledger' });
  assert.deepEqual(params.payment_intent_data.metadata, params.metadata);
  assert.equal(params.customer_email, 'pat@acme.test');
});

// ---------- refunds and disputes ----------

test('a refund stops counting as paid; partial refunds count the rest', async () => {
  const db = fresh();
  const id = invoice(db);
  L.upsertStripePayment(db, await paymentFromEvent(checkout({ metadata: { invoice_id: id, payment_suffix: '01' } })));
  assert.equal(L.getInvoice(db, id).status, 'Paid');
  const refund = (amount) => adjustmentFromEvent({ type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: amount } } });
  assert.equal(L.applyRefund(db, refund(13000)).changed, true);
  let inv = L.getInvoice(db, id);
  assert.equal(inv.paid_cents, 100000);
  assert.equal(inv.outstanding_cents, 13000);
  assert.equal(inv.status, 'Partly paid');
  assert.equal(L.applyRefund(db, refund(13000)).changed, false);
  L.applyRefund(db, refund(113000));
  inv = L.getInvoice(db, id);
  assert.equal(inv.paid_cents, 0);
  assert.equal(inv.lines[0].payments[0].refunded_cents, 113000);
  assert.ok(inv.history.some((h) => h.action === 'refund'));
  assert.equal(L.openLines(db).length, 1);
  assert.deepEqual(L.applyRefund(db, { payment_intent: 'pi_unknown', amount_refunded: 5 }), { found: false });
});

test('an open or lost dispute stops counting as paid; a won one counts again', async () => {
  const db = fresh();
  const id = invoice(db);
  L.upsertStripePayment(db, await paymentFromEvent(checkout({ metadata: { invoice_id: id } })));
  const dispute = (type, status) => adjustmentFromEvent({ type, data: { object: { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 113000, status } } });
  L.applyDispute(db, dispute('charge.dispute.created', 'needs_response'));
  assert.equal(L.getInvoice(db, id).paid_cents, 0);
  L.applyDispute(db, dispute('charge.dispute.closed', 'won'));
  assert.equal(L.getInvoice(db, id).paid_cents, 113000);
  L.applyDispute(db, dispute('charge.dispute.closed', 'lost'));
  const inv = L.getInvoice(db, id);
  assert.equal(inv.paid_cents, 0);
  assert.equal(inv.lines[0].payments[0].dispute_status, 'lost');
});

test('the webhook applies refunds', async (t) => {
  const { req, db } = await server(t);
  const id = invoice(db);
  L.upsertStripePayment(db, await paymentFromEvent(checkout({ metadata: { invoice_id: id } })));
  const raw = JSON.stringify({ id: 'evt_r', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 113000 } } });
  const r = await req('/api/stripe/webhook', { method: 'POST', body: raw, headers: { 'stripe-signature': signStripePayload(raw, 'whsec_test') } });
  assert.deepEqual(await r.json(), { received: true, kind: 'refund', found: true, payment_id: 1, changed: true, invoice_id: id });
  assert.equal(L.getInvoice(db, id).outstanding_cents, 113000);
});

// ---------- client invoice page ----------

test('the client invoice page shows the invoice and a Pay button per open payment', async (t) => {
  const stripe = { post: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_x' }) };
  const { req, db } = await server(t, { business: { ...makeConfig({}).business, hstNumber: '123456789 RT0001' } }, { stripe });
  const id = split(db, { client_name: 'Acme Dental', description: 'New website' });
  const inv = L.getInvoice(db, id);
  assert.match(inv.public_token, /^[A-Za-z0-9_-]{24}$/);

  const page = await req(`/invoice/${inv.public_token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  const html = await page.text();
  assert.match(html, new RegExp(`Invoice number</dt><dd class="ref">${id}`));
  assert.match(html, /HST no\. 123456789 RT0001/);
  assert.match(html, /Painkiller Labs Inc\./);
  assert.match(html, /Payment 1 of 2 · Deposit/);
  assert.match(html, /Payment 2 of 2 · Final payment/);
  assert.match(html, /On completion/);
  assert.equal((html.match(/class="pay"/g) || []).length, 2);

  const pay = await req(`/invoice/${inv.public_token}/pay/01`, { method: 'POST' });
  assert.equal(pay.status, 303);
  assert.equal(pay.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_x');

  assert.equal((await req('/invoice/not-a-real-token-at-all-xx')).status, 404);
  assert.equal((await req(`/invoice/${inv.public_token}/pay/09`, { method: 'POST' })).status, 303);
  assert.equal((await req('/invoice/assets/invoice.css')).status, 200);
});

test('a paid or void invoice has no Pay buttons', async (t) => {
  const stripe = { post: async () => ({ url: 'x' }) };
  const { req, db } = await server(t, {}, { stripe });
  const id = invoice(db);
  L.recordManualPayment(db, { line_id: L.getInvoice(db, id).lines[0].id, amount_cents: 113000, method: 'cheque' });
  const paid = await (await req(`/invoice/${L.getInvoice(db, id).public_token}`)).text();
  assert.match(paid, /Paid in full/);
  assert.doesNotMatch(paid, /class="pay"/);
  const v = invoice(db);
  L.voidInvoice(db, v, 'Replaced');
  const voided = await (await req(`/invoice/${L.getInvoice(db, v).public_token}`)).text();
  assert.match(voided, /cancelled/);
  assert.doesNotMatch(voided, /class="pay"/);
});

test('emailing an invoice sends the client link and marks it sent', async (t) => {
  const { req, db, emails } = await server(t);
  const id = split(db, { client_email: 'pat@acme.test' });
  const cookie = `pk_admin=${A.createSession(db, 'rh@pklabs.ca')}`;
  const r = await req(`/admin/api/invoices/${id}/email`, { method: 'POST', body: '{}', headers: { cookie, 'x-ledger': '1' } });
  assert.equal(r.status, 200);
  const mail = emails.at(-1);
  assert.equal(mail.to, 'pat@acme.test');
  assert.equal(mail.replyTo, 'rh@pklabs.ca');
  assert.match(mail.subject, new RegExp(`Invoice ${id}`));
  assert.match(mail.text, new RegExp(`/invoice/${L.getInvoice(db, id).public_token}`));
  assert.match(mail.text, /paid in 2 payments\. Payment 1 of 2 · Deposit/);
  const inv = L.getInvoice(db, id);
  assert.equal(inv.sent_via, 'email');
  assert.equal(inv.sent_to, 'pat@acme.test');

  const noEmail = split(db, { client_email: "" });
  const bad = await req(`/admin/api/invoices/${noEmail}/email`, { method: 'POST', body: '{}', headers: { cookie, 'x-ledger': '1' } });
  assert.equal(bad.status, 400);
});

// ---------- upgrading an existing database ----------

test('an older database is upgraded without losing rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE invoices (id TEXT PRIMARY KEY, client_name TEXT NOT NULL, client_email TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', line_items TEXT NOT NULL DEFAULT '[]', currency TEXT NOT NULL DEFAULT 'CAD',
      subtotal_cents INTEGER NOT NULL, hst_enabled INTEGER NOT NULL DEFAULT 1, hst_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
      schedule TEXT NOT NULL DEFAULT 'one_time', issue_date TEXT NOT NULL, sent_date TEXT, sent_to TEXT, sent_via TEXT,
      voided_at TEXT, void_reason TEXT, notes TEXT NOT NULL DEFAULT '', stripe_link_id TEXT, stripe_link_url TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE payment_lines (id INTEGER PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), suffix INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL, due_date TEXT NOT NULL, UNIQUE (invoice_id, suffix));
    CREATE TABLE payments (id INTEGER PRIMARY KEY, source TEXT NOT NULL, ref TEXT UNIQUE, stripe_type TEXT, stripe_object_id TEXT,
      stripe_event_id TEXT, stripe_subscription TEXT, method TEXT, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
      received_at TEXT NOT NULL, payer_name TEXT, payer_email TEXT, description TEXT, invoice_ref_entered TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', payment_line_id INTEGER REFERENCES payment_lines(id), matched_at TEXT,
      match_method TEXT, ignored_at TEXT, note TEXT, created_at TEXT NOT NULL);
    INSERT INTO invoices (id, client_name, subtotal_cents, hst_cents, total_cents, issue_date, created_at, updated_at)
      VALUES ('K7M2', 'Acme', 100000, 13000, 113000, '2026-11-01', 'x', 'x');
    INSERT INTO payment_lines (id, invoice_id, suffix, amount_cents, due_date) VALUES (7, 'K7M2', 1, 113000, '2026-11-15');
    INSERT INTO payments (source, method, amount_cents, currency, received_at, payment_line_id, created_at)
      VALUES ('manual', 'cheque', 113000, 'CAD', '2026-11-10', 7, 'x');`);
  old.close();

  const db = openDb(file);
  const inv = L.getInvoice(db, 'K7M2');
  assert.equal(inv.status, 'Paid');
  assert.equal(inv.lines[0].id, 7);
  assert.equal(inv.lines[0].label, '');
  assert.match(inv.public_token, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(db.prepare('PRAGMA table_info(payment_lines)').all().find((c) => c.name === 'due_date').notnull, 0);
  db.close();
  assert.equal(openDb(file).prepare('SELECT public_token FROM invoices').get().public_token, inv.public_token);
});

test('if Checkout is not allowed, Pay falls back to a reusable payment link for that payment', async (t) => {
  const calls = [];
  const stripe = { post: async (path, params) => {
    calls.push([path, params]);
    if (path === '/checkout/sessions') throw new Error('Stripe: more_permissions_required');
    return path === '/prices' ? { id: 'price_1' } : { id: 'plink_1', url: 'https://buy.stripe.com/line1' };
  } };
  const { req, db } = await server(t, {}, { stripe });
  const id = split(db);
  const token = L.getInvoice(db, id).public_token;
  const first = await req(`/invoice/${token}/pay/01`, { method: 'POST' });
  assert.equal(first.headers.get('location'), 'https://buy.stripe.com/line1');
  const link = calls.find(([p]) => p === '/payment_links')[1];
  assert.deepEqual(link.metadata, { invoice_id: id, payment_suffix: '01', invoice_ref: `${id}-01`, source: 'pk-ledger' });
  assert.equal(calls.find(([p]) => p === '/prices')[1].unit_amount, 150000);
  const again = await req(`/invoice/${token}/pay/01`, { method: 'POST' });
  assert.equal(again.headers.get('location'), 'https://buy.stripe.com/line1');
  assert.equal(calls.filter(([p]) => p === '/payment_links').length, 1);
});

// ---------- dashboard and reports ----------

// Three clients: one paid, one late, one with a draft split.
function book(db) {
  const paid = invoice(db, { client_name: 'Paid Co', issue_date: '2026-10-01', first_due: '2026-10-15' });
  L.markSent(db, paid, { sent_date: '2026-10-01' });
  L.recordManualPayment(db, { line_id: L.getInvoice(db, paid).lines[0].id, amount_cents: 113000, received_at: '2026-11-03', method: 'e-transfer' });
  const late = invoice(db, { client_name: 'Late Ltd', issue_date: '2026-09-01', subtotal_cents: 30000, schedule: 'monthly', count: 3, first_due: '2026-09-01' });
  L.markSent(db, late, { sent_date: '2026-09-01' });
  const draft = split(db, { client_name: 'Draft Inc', issue_date: '2026-11-10', first_due: '2026-11-20' });
  return { paid, late, draft };
}

test('the dashboard totals what is owed, overdue, due soon and received', () => {
  const db = fresh();
  const { late } = book(db);
  const d = R.dashboard(db, '2026-11-14');
  // Late Ltd: 3 × 11,300 (Sep 1, Oct 1, Nov 1 all past). Draft Inc: 300,000 unsent.
  assert.deepEqual(d.owed, { CAD: 33900 + 300000 });
  assert.deepEqual(d.overdue, { CAD: 33900 });
  assert.deepEqual(d.unsent, { CAD: 300000 });
  assert.deepEqual(d.on_completion, { CAD: 150000 });
  assert.deepEqual(d.received_this_month, { CAD: 113000 });
  assert.deepEqual(d.received_last_month, {});
  assert.deepEqual(d.aging.d61_plus, { CAD: 11300 });
  assert.deepEqual(d.aging.d31_60, { CAD: 11300 });
  assert.deepEqual(d.aging.d1_30, { CAD: 11300 });
  assert.deepEqual(d.aging.current, { CAD: 300000 });
  assert.equal(d.overdue_items[0].ref, `${late}-01`);
  assert.equal(d.overdue_items[0].days_late, 74);
  assert.deepEqual(d.clients.map((c) => c.client_name), ['Late Ltd', 'Draft Inc']);
});

test('the receivables report groups by client and adds up to what is owed', () => {
  const db = fresh();
  book(db);
  const r = R.receivables(db, '2026-11-14');
  assert.deepEqual(r.clients.map((c) => c.client_name), ['Draft Inc', 'Late Ltd']);
  assert.deepEqual(r.totals.total, { CAD: 333900 });
  assert.match(R.receivablesCsv(r), /^Client,Payment number,.*\r\nDraft Inc,/s);
});

test('the payments report works out HST, refunds by date, and HST invoiced', async () => {
  const db = fresh();
  const { paid } = book(db);
  const card = invoice(db, { client_name: 'Card Corp', issue_date: '2026-11-05' });
  L.upsertStripePayment(db, await paymentFromEvent(checkout({ created: Date.parse('2026-11-06T15:00:00Z') / 1000, metadata: { invoice_id: card } })));
  L.applyRefund(db, { payment_intent: 'pi_1', amount_refunded: 11300 });
  const r = R.paymentsReport(db, { from: '2026-11-01', to: '2026-11-30' });
  // Two payments of 1,130 each (HST 130 each), and a 113 refund (HST 13) today.
  assert.deepEqual(r.totals.received, { CAD: 226000 });
  assert.deepEqual(r.totals.refunded, { CAD: -11300 });
  assert.deepEqual(r.totals.net, { CAD: 214700 });
  assert.deepEqual(r.totals.hst, { CAD: 26000 - 1300 });
  assert.deepEqual(r.totals.before_tax, { CAD: 214700 - 24700 });
  // Invoiced in November: Card Corp 1,130 (HST 130) and Draft Inc 3,000 (no HST).
  assert.deepEqual(r.invoiced.CAD, { count: 2, subtotal: 400000, hst: 13000, total: 413000 });
  assert.equal(r.rows[0].ref, `${paid}-01`);
  assert.throws(() => R.paymentsReport(db, { from: '2026-12-01', to: '2026-11-01' }), /after/);
  assert.match(R.paymentsCsv(r), /HST portion/);
});

test('a client statement keeps a running balance', () => {
  const db = fresh();
  const { paid } = book(db);
  const s = R.clientStatement(db, 'Paid Co', '2026-11-14');
  assert.deepEqual(s.entries.map((e) => [e.kind, e.balance_cents]), [['invoice', 113000], ['payment', 0]]);
  assert.deepEqual(s.balance, { CAD: 0 });
  assert.equal(s.entries[1].ref, `${paid}-01`);
  assert.throws(() => R.clientStatement(db, 'Nobody'), /No invoices/);
});

test('the dashboard API includes the setup checklist, and items can be ticked off', async (t) => {
  const { req, db } = await server(t);
  const cookie = `pk_admin=${A.createSession(db, 'rh@pklabs.ca')}`;
  const get = async () => (await (await req('/admin/api/dashboard', { headers: { cookie } })).json()).setup;
  assert.deepEqual((await get()).map((s) => [s.key, s.done]), [['webhook_events', false], ['checkout', false], ['bank_read', false], ['hst_number', false]]);
  await req('/admin/api/setup/webhook_events', { method: 'POST', body: '{"done":true}', headers: { cookie, 'x-ledger': '1' } });
  assert.equal((await get())[0].done, true);
  assert.equal((await req('/admin/api/setup/hst_number', { method: 'POST', body: '{"done":true}', headers: { cookie, 'x-ledger': '1' } })).status, 404);
  const csv = await req('/admin/api/reports/payments.csv?from=2026-11-01&to=2026-11-30', { headers: { cookie } });
  assert.match(csv.headers.get('content-disposition'), /payments-2026-11-01-to-2026-11-30\.csv/);
});

// ---------- bank reconciliation ----------

import * as B from '../lib/bank.mjs';

const noon = (d) => Date.UTC(...d.split('-').map((n, i) => (i === 1 ? n - 1 : +n)), 12) / 1000;

// A fake Stripe with one landed payout (the Acme card payment) and one payment
// not paid out yet. `chargesReadable: false` makes expanding the charge fail.
function fakeStripe({ chargesReadable = true } = {}) {
  const calls = [];
  const charge = (id, pi, name) => ({ id, object: 'charge', payment_intent: pi, billing_details: { name } });
  const txn = (id, over) => ({ id, type: 'charge', currency: 'cad', created: 1794000000, status: 'available', available_on: 1794200000, ...over });
  return {
    calls,
    async get(path, params = {}) {
      calls.push([path, params]);
      if (params.expand && !chargesReadable) throw new Error('Stripe: Permission denied. Enabling Charges Read would allow this request');
      const src = (id, pi, name) => (params.expand ? charge(id, pi, name) : id);
      if (path === '/payouts') {
        return { has_more: false, data: [{ id: 'po_1', amount: 109693, currency: 'cad', status: 'paid', arrival_date: noon('2026-11-10'), created: noon('2026-11-08'), automatic: true, method: 'standard' }] };
      }
      if (path === '/balance_transactions' && params.payout === 'po_1') {
        return { has_more: false, data: [
          txn('txn_1', { amount: 113000, fee: 3307, net: 109693, source: src('ch_1', 'pi_1', 'Pat') }),
          txn('txn_po', { type: 'payout', amount: -109693, fee: 0, net: -109693, source: 'po_1' }),
        ] };
      }
      if (path === '/balance_transactions') {
        return { has_more: false, data: [txn('txn_2', { amount: 5650, fee: 194, net: 5456, status: 'pending', created: noon('2026-11-13'), source: src('ch_2', 'pi_2', 'Walk-in') })] };
      }
      if (path === '/balance') return { available: [{ currency: 'cad', amount: 0 }], pending: [{ currency: 'cad', amount: 5456 }] };
      throw new Error(`unexpected ${path}`);
    },
  };
}

async function bankBook() {
  const db = fresh();
  const card = invoice(db, { client_name: 'Acme Dental' });
  L.upsertStripePayment(db, await paymentFromEvent(checkout({ metadata: { invoice_id: card, payment_suffix: '01' } })));
  const et = invoice(db, { client_name: 'Bloor Physio', subtotal_cents: 50000 });
  L.recordManualPayment(db, { line_id: L.getInvoice(db, et).lines[0].id, amount_cents: 56500, received_at: '2026-11-05', method: 'e-transfer' });
  return { db, card, et };
}

const RBC = `Account Type,Account Number,Transaction Date,Cheque Number,Description 1,Description 2,CAD$,USD$
Chequing,05555-1234567,11/11/2026,,STRIPE,MSP/DIV,1096.93,
Chequing,05555-1234567,11/06/2026,,E-TRANSFER,BLOOR PHYSIO,565.00,
Chequing,05555-1234567,11/07/2026,,RENT,,-2000.00,
Chequing,05555-1234567,11/08/2026,,MISC DEPOSIT,,50.00,
`;

test('a Stripe sync breaks each payout into payments and fees, and shows what is not paid out yet', async () => {
  const { db, card } = await bankBook();
  const stripe = fakeStripe();
  const out = await B.syncStripe(db, stripe, { nowSec: noon('2026-11-14') });
  assert.equal(out.charges_readable, true);
  const r = B.bankReport(db, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.payouts.length, 1);
  const po = r.payouts[0];
  assert.equal(po.balanced, true);
  assert.equal(po.txns.length, 1); // the payout's own line is left out
  assert.equal(po.txns[0].ref, `${card}-01`);
  assert.equal(po.txns[0].fee_cents, 3307);
  assert.equal(po.gross_cents, 113000);
  assert.deepEqual(r.totals.deposited, { CAD: 109693 });
  assert.deepEqual(r.totals.fees, { CAD: 3501 });
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].ref, null); // a Stripe payment the ledger never saw
  assert.equal(r.pending[0].payer, 'Walk-in');
  assert.deepEqual(r.balance.pending, { CAD: 5456 });
  assert.equal(r.manual.length, 1);
  assert.equal(r.counts.not_in_bank, 2);

  // A landed payout isn't read again on the next sync.
  stripe.calls.length = 0;
  await B.syncStripe(db, stripe, { nowSec: noon('2026-11-14') });
  assert.ok(!stripe.calls.some(([, p]) => p.payout));
  assert.match(B.bankCsv(r), /po_1,1096.93,2026-11-06,Payment,.*-01,Acme Dental,1130,33.07,1096.93,CAD,no/);
});

test('without Charges: Read, Stripe payments are matched by amount and date instead', async () => {
  const { db, card } = await bankBook();
  const out = await B.syncStripe(db, fakeStripe({ chargesReadable: false }), { nowSec: noon('2026-11-14') });
  assert.equal(out.charges_readable, false);
  const r = B.bankReport(db, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.payouts[0].txns[0].ref, `${card}-01`);
  assert.equal(r.charges_readable, false);
});

test('a Stripe key without payout access gets a plain explanation', async () => {
  const db = fresh();
  const stripe = { async get() { throw new Error('Stripe: Permission denied. Enabling Payouts Read (payout_read)...'); } };
  await assert.rejects(B.syncStripe(db, stripe), (e) => e instanceof B.StripePermissionError && /Balance, Payouts and Charges/.test(e.message));
});

test('reading bank statements: RBC with a header, TD without one, and odd amounts', () => {
  const rbc = B.readStatement(RBC);
  assert.equal(rbc.rows.length, 4);
  assert.deepEqual(rbc.rows[0], { date: '2026-11-11', amount_cents: 109693, description: 'STRIPE · MSP/DIV', currency: null });
  assert.equal(rbc.rows[2].amount_cents, -200000);

  const td = B.readStatement('11/11/2026,STRIPE PAYOUT,,1096.93,5000.00\n11/07/2026,RENT,2000.00,,3903.07\n');
  assert.deepEqual(td.rows.map((r) => [r.date, r.amount_cents, r.description]), [['2026-11-11', 109693, 'STRIPE PAYOUT'], ['2026-11-07', -200000, 'RENT']]);

  const dmy = B.readStatement('Date,Description,Amount\n25/11/2026,Deposit,"1,234.50"\n03/11/2026,Fee,(4.00)\n');
  assert.deepEqual(dmy.rows.map((r) => [r.date, r.amount_cents]), [['2026-11-25', 123450], ['2026-11-03', -400]]);

  assert.equal(B.parseAmount('12.00-'), -1200);
  assert.equal(B.parseAmount('$1,000.5 CR'), 100050);
  assert.equal(B.parseAmount('abc'), null);
  assert.equal(B.parseDate('Nov 14, 2026'), '2026-11-14');
  assert.equal(B.parseDate('14-Nov-2026'), '2026-11-14');
  assert.equal(B.parseDate('2026-02-30'), null);
  assert.throws(() => B.readStatement('a,b\n1,2\n'), /date column/);
});

test('importing a bank statement ticks off payouts and e-transfers, once', async () => {
  const { db, et } = await bankBook();
  await B.syncStripe(db, fakeStripe(), { nowSec: noon('2026-11-14') });
  const out = B.importStatement(db, RBC);
  assert.deepEqual({ imported: out.imported, withdrawals: out.withdrawals, matched: out.matched }, { imported: 3, withdrawals: 1, matched: 2 });

  let r = B.bankReport(db, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.payouts[0].bank.date, '2026-11-11');
  assert.equal(r.manual[0].bank.date, '2026-11-06');
  assert.equal(r.manual[0].ref, `${et}-01`);
  assert.equal(r.counts.not_in_bank, 0);
  assert.equal(r.counts.bank_unmatched, 1);
  const misc = r.bank_lines.find((l) => l.description === 'MISC DEPOSIT');
  assert.deepEqual(misc.options, []); // nothing left to match it to

  // Importing the same statement again adds nothing.
  assert.deepEqual([B.importStatement(db, RBC).imported, B.importStatement(db, RBC).duplicates], [0, 3]);

  B.ignoreBankLine(db, misc.id, 'Owner top-up');
  r = B.bankReport(db, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.counts.bank_unmatched, 0);

  // Undo a match, then match it by hand.
  const stripeLine = r.bank_lines.find((l) => l.match_type === 'payout');
  B.unmatchBankLine(db, stripeLine.id);
  assert.throws(() => B.matchBankLine(db, misc.id, { type: 'payout', target: 'po_1' }), /Restore/);
  assert.equal(B.matchBankLine(db, stripeLine.id, { type: 'payout', target: 'po_1' }).amount_differs, false);
  assert.throws(() => B.matchBankLine(db, misc.id, { type: 'payout', target: 'po_1' }), /Restore|already/);
  B.restoreBankLine(db, misc.id);
  assert.throws(() => B.matchBankLine(db, misc.id, { type: 'payout', target: 'po_1' }), /already matched/);
});

test('two identical deposits that could each be either payment are left for you to match', async () => {
  const db = fresh();
  for (const name of ['A Co', 'B Co']) {
    const id = invoice(db, { client_name: name, subtotal_cents: 10000 });
    L.recordManualPayment(db, { line_id: L.getInvoice(db, id).lines[0].id, amount_cents: 11300, received_at: '2026-11-05', method: 'cheque' });
  }
  const out = B.importStatement(db, 'Date,Description,Amount\n2026-11-06,Cheque deposit,113.00\n');
  assert.equal(out.matched, 0);
  const [line] = B.bankReport(db, { from: '2026-11-01', to: '2026-11-30' }).bank_lines;
  assert.equal(line.options.length, 2);
  assert.ok(line.options.every((o) => o.exact));
});

test('the bank API syncs, imports and matches', async (t) => {
  const { req, db } = await server(t, {}, { stripe: fakeStripe() });
  const cookie = `pk_admin=${A.createSession(db, 'rh@pklabs.ca')}`;
  const post = (p, body) => req(`/admin/api/${p}`, { method: 'POST', body: JSON.stringify(body), headers: { cookie, 'x-ledger': '1' } });
  const r = await (await req('/admin/api/bank?from=2026-11-01&to=2026-11-30', { headers: { cookie } })).json();
  assert.equal(r.sync_error, null);
  assert.ok(r.synced_at);
  assert.equal(r.payouts.length, 1);
  const imp = await (await post('bank/import', { csv: RBC })).json();
  assert.equal(imp.imported, 3);
  assert.equal(imp.matched, 1); // the payout; there's no e-transfer in this ledger
  const csv = await req('/admin/api/bank.csv?from=2026-11-01&to=2026-11-30', { headers: { cookie } });
  assert.match(csv.headers.get('content-disposition'), /deposits-2026-11-01-to-2026-11-30/);
  assert.match(await csv.text(), /yes \(2026-11-11\)/);
  const lines = (await (await req('/admin/api/bank?from=2026-11-01&to=2026-11-30', { headers: { cookie } })).json()).bank_lines;
  const et = lines.find((l) => l.description.startsWith('E-TRANSFER'));
  assert.equal((await post(`bank/lines/${et.id}/ignore`, { note: 'personal' })).status, 200);
  assert.equal((await post('bank/import', { csv: 'nothing here' })).status, 400);
});

// ---------- access list ----------

import * as RM from '../lib/reminders.mjs';

test('only people on the access list get sign-in links, each to their own address', async (t) => {
  const { req, db, emails } = await server(t, { bootstrapAdmins: ['Boss@pklabs.test', 'ps@pklabs.test'] });
  // The list was empty, so the bootstrap admins were added.
  assert.deepEqual(A.listUsers(db).map((u) => [u.email, u.role]), [['boss@pklabs.test', 'admin'], ['ps@pklabs.test', 'admin']]);
  const post = (p, body) => req(p, { method: 'POST', body: new URLSearchParams(body), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  await post('/admin/login', { email: 'rh@pklabs.ca' }); // not on this list
  await post('/admin/login', { email: ' PS@pklabs.test ' });
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'ps@pklabs.test');
  // Starting again with people already on the list doesn't add anyone.
  assert.equal(A.seedUsers(db, ['new@x.test']), 0);
});

test('read-only people can look but not change anything or see the access list', async (t) => {
  const { req, db } = await server(t);
  A.addUser(db, { email: 'viewer@pklabs.test', role: 'viewer' }, 'rh@pklabs.ca');
  const cookie = `pk_admin=${A.createSession(db, 'viewer@pklabs.test')}`;
  const get = (p) => req(`/admin/api/${p}`, { headers: { cookie } });
  const post = (p, body = {}) => req(`/admin/api/${p}`, { method: 'POST', body: JSON.stringify(body), headers: { cookie, 'x-ledger': '1' } });
  assert.equal((await get('invoices')).status, 200);
  assert.equal((await get('dashboard')).status, 200);
  assert.equal((await (await get('config')).json()).me.role, 'viewer');
  assert.equal((await get('users')).status, 403);
  const r = await post('invoices', { client_name: 'X', subtotal_cents: 100 });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /read-only/);
  assert.equal(L.listInvoices(db).length, 0);
});

test('admins add, change and remove people; removal signs them out at once', async (t) => {
  const { req, db } = await server(t);
  const admin = `pk_admin=${A.createSession(db, 'rh@pklabs.ca')}`;
  const post = (p, body = {}, cookie = admin) => req(`/admin/api/${p}`, { method: 'POST', body: JSON.stringify(body), headers: { cookie, 'x-ledger': '1' } });
  assert.equal((await post('users', { email: 'Pat@Example.test', name: 'Pat', role: 'viewer' })).status, 201);
  assert.equal((await post('users', { email: 'pat@example.test' })).status, 400); // already there
  assert.equal((await post('users', { email: 'nope' })).status, 400);
  const pat = `pk_admin=${A.createSession(db, 'pat@example.test')}`;
  assert.equal((await post('invoices', { client_name: 'X', subtotal_cents: 100 }, pat)).status, 403);
  await post('users/pat@example.test', { role: 'admin' });
  assert.equal((await post('invoices', { client_name: 'X', subtotal_cents: 100 }, pat)).status, 201); // takes effect straight away
  await post('users/pat@example.test/remove');
  assert.equal((await req('/admin/api/invoices', { headers: { cookie: pat } })).status, 401);
  assert.equal(A.getUser(db, 'pat@example.test'), null);
  // The history says who did it.
  const inv = L.getInvoice(db, L.listInvoices(db)[0].id);
  assert.equal(inv.history[0].actor, 'pat@example.test');
});

test('you can’t lock everyone out', async () => {
  const db = fresh();
  A.seedUsers(db, ['a@x.test']);
  assert.throws(() => A.removeUser(db, 'a@x.test', 'a@x.test'), /yourself/);
  assert.throws(() => A.updateUser(db, 'a@x.test', { role: 'viewer' }, 'a@x.test'), /your own/);
  A.addUser(db, { email: 'b@x.test', role: 'viewer' }, 'a@x.test');
  assert.throws(() => A.updateUser(db, 'a@x.test', { role: 'viewer' }, 'b@x.test'), /at least one admin/);
  assert.throws(() => A.addUser(db, { email: 'c@x.test', role: 'owner' }, 'a@x.test'), /admin.*viewer/);
  A.removeUser(db, 'b@x.test', 'a@x.test');
  assert.equal(A.addUser(db, { email: 'b@x.test', role: 'admin' }, 'a@x.test').role, 'admin'); // can be added back
  assert.equal(A.issueLoginToken(db, 'nobody@x.test'), null);
  const tok = A.issueLoginToken(db, 'B@x.test');
  assert.equal(tok.email, 'b@x.test');
  A.removeUser(db, 'b@x.test', 'a@x.test');
  assert.equal(A.redeemLoginToken(db, tok.raw), null); // a removed person's link stops working
});

// ---------- saved clients ----------

test('invoices for the same client name share one saved client, whatever the case', () => {
  const db = fresh();
  const a = invoice(db, { client_name: 'Acme Dental', client_email: '' });
  const b = invoice(db, { client_name: '  acme dental ', client_email: 'ap@acme.test', client_address: '1 Main St\nToronto' });
  const ia = L.getInvoice(db, a), ib = L.getInvoice(db, b);
  assert.equal(ia.client_id, ib.client_id);
  assert.equal(ib.client_name, 'Acme Dental');
  const c = L.getClient(db, ia.client_id);
  assert.equal(c.email, 'ap@acme.test');
  assert.equal(c.address, '1 Main St\nToronto');
  assert.equal(c.invoices.length, 2);
  assert.deepEqual(L.clientsOverview(db)[0].owed, { CAD: 226000 });
  assert.equal(L.findClientByName(db, 'ACME DENTAL').id, c.id);
});

test('renaming a client renames their invoices; merging moves them over', () => {
  const db = fresh();
  const a = invoice(db, { client_name: 'Acme' });
  const b = invoice(db, { client_name: 'Acme Dental Inc' });
  const ca = L.getInvoice(db, a).client_id, cb = L.getInvoice(db, b).client_id;
  assert.throws(() => L.updateClient(db, ca, { name: 'acme dental inc' }), /Merge/);
  L.updateClient(db, ca, { name: 'Acme Dental' });
  assert.equal(L.getInvoice(db, a).client_name, 'Acme Dental');
  assert.equal(L.mergeClients(db, cb, ca).moved, 1);
  assert.equal(L.getInvoice(db, b).client_name, 'Acme Dental');
  assert.equal(L.clientsOverview(db).length, 1);
  assert.deepEqual(L.listClients(db), ['Acme Dental']);
  // The old name can be used again for a new client.
  invoice(db, { client_name: 'Acme Dental Inc' });
  assert.equal(L.clientsOverview(db).length, 2);
});

test('an older database gets a saved client for each invoice name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'old.db');
  let db = openDb(file);
  invoice(db, { client_name: 'Bloor Physio', client_email: 'a@bloor.test' });
  invoice(db, { client_name: 'bloor physio' });
  db.exec('UPDATE invoices SET client_id = NULL; DELETE FROM clients;');
  db.close();
  db = openDb(file);
  const rows = db.prepare('SELECT client_id, client_name FROM invoices').all();
  assert.equal(new Set(rows.map((r) => r.client_id)).size, 1);
  assert.ok(rows.every((r) => r.client_name === 'Bloor Physio'));
  assert.equal(db.prepare('SELECT email FROM clients').get().email, 'a@bloor.test');
  db.close();
});

// ---------- reminders ----------

function remindBook() {
  const db = fresh();
  const id = invoice(db, { client_name: 'Late Co', client_email: 'ap@late.test', schedule: 'split', count: 2, first_due: '2026-11-10', issue_date: '2026-11-01' });
  L.setLineDueDate(db, id, 2, '2026-12-20');
  L.markSent(db, id, { sent_date: '2026-11-01', sent_to: 'ap@late.test', sent_via: 'email' });
  const sent = [];
  const opts = { business: { shortName: 'Painkiller Labs' }, publicUrl: 'https://x.test', send: async (m) => { sent.push(m); } };
  return { db, id, sent, opts };
}

test('reminders go out at each stage once, only when switched on and in working hours', async () => {
  const { db, id, sent, opts } = remindBook();
  const at = (d, h = 14) => new Date(`${d}T${String(h + 5).padStart(2, '0')}:00:00Z`); // Toronto is UTC-5 in winter
  assert.deepEqual(await RM.runReminders(db, opts, { now: at('2026-11-11') }), { skipped: 'off' });
  RM.setRemindersEnabled(db, true);
  assert.deepEqual(await RM.runReminders(db, opts, { now: at('2026-11-11', 7) }), { skipped: 'outside working hours' });
  // The deposit was due Nov 10: a day late.
  assert.deepEqual(RM.dueReminders(db, '2026-11-11').map((r) => [r.ref, r.kind]), [[`${id}-01`, 'late1']]);
  await RM.runReminders(db, opts, { now: at('2026-11-11') });
  await RM.runReminders(db, opts, { now: at('2026-11-12') });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Overdue/);
  assert.equal(sent[0].to, 'ap@late.test');
  // A week late, then the final payment 3 days before it's due.
  await RM.runReminders(db, opts, { now: at('2026-11-17') });
  await RM.runReminders(db, opts, { now: at('2026-12-17') });
  assert.deepEqual(sent.map((m) => m.subject.split(':')[0]), ['Overdue', 'Overdue', 'Reminder']);
  // Way past the last stage: no more emails.
  assert.equal(RM.dueReminders(db, '2027-01-30').filter((r) => r.ref === `${id}-01`).length, 0);
  // Paid or switched off for this invoice: nothing.
  RM.setInvoiceReminders(db, id, false);
  assert.equal(RM.dueReminders(db, '2026-12-22').length, 0);
  assert.equal(L.getInvoice(db, id).reminders.length, 3);
});

test('a reminder can be sent by hand, and a failed send is recorded and retried later', async () => {
  const { db, id, opts } = remindBook();
  const out = await RM.sendManualReminder(db, id, {}, opts);
  assert.deepEqual(out, { sent_to: 'ap@late.test', ref: `${id}-01` });
  // A manual reminder holds off the automatic one for a few days.
  assert.equal(RM.dueReminders(db, '2026-11-11').length, 0);
  const broken = { ...opts, send: async () => { throw new Error('Resend 500'); } };
  await assert.rejects(RM.sendManualReminder(db, id, { suffix: 2 }, broken), /didn’t send: Resend 500/);
  assert.equal(L.getInvoice(db, id).reminders[0].error, 'Resend 500');
  assert.ok(L.getInvoice(db, id).history.some((h) => h.action === 'reminder_failed'));
});

test('unsent invoices and clients without an email get no reminders', () => {
  const db = fresh();
  invoice(db, { client_name: 'Draft Co', first_due: '2026-11-10' });
  const id = invoice(db, { client_name: 'No Email Co', client_email: '', first_due: '2026-11-10' });
  L.markSent(db, id, { sent_date: '2026-11-01', sent_via: 'other' });
  assert.equal(RM.dueReminders(db, '2026-11-11').length, 0);
});

// ---------- plan choices ----------

const PLANS = [
  { price: 'price_host', product: 'prod_host', name: 'Website Hosting', description: 'Hosting\nBackups', amount_cents: 6000, currency: 'CAD', interval: 'month' },
  { price: 'price_care', product: 'prod_care', name: 'Website care plus', description: '', amount_cents: 25000, currency: 'CAD', interval: 'month' },
  { price: 'price_build', product: 'prod_build', name: 'Website build', description: '', amount_cents: 800000, currency: 'CAD', interval: null },
];

test('a plan choice reserves its invoice number and only offers active Stripe prices', async () => {
  const O = await import('../lib/offers.mjs');
  const db = fresh();
  const id = O.createOffer(db, { client_name: 'Cavera Insurance', options: [{ price: 'price_host' }, { price: 'price_care', details: 'Hosting\nChanges' }] }, PLANS);
  const o = O.getOffer(db, id);
  assert.equal(o.status, 'Not sent');
  assert.deepEqual(o.options.map((x) => [x.name, x.amount_cents, x.details]), [['Website Hosting', 6000, 'Hosting\nBackups'], ['Website care plus', 25000, 'Hosting\nChanges']]);
  // Nobody else can be given that number.
  assert.equal(invoice(db, { id }) === id, false);
  assert.throws(() => O.createOffer(db, { client_name: 'X', options: [{ price: 'price_gone' }] }, PLANS), /isn’t an active price/);
  assert.throws(() => O.createOffer(db, { client_name: 'X', options: [] }, PLANS), /at least one/);
});

test('the client picks a plan and it becomes their invoice at the same link', async (t) => {
  const posts = [];
  const stripe = {
    get: async () => ({ has_more: false, data: [
      { id: 'price_host', active: true, unit_amount: 6000, currency: 'cad', recurring: { interval: 'month', interval_count: 1 }, product: { id: 'prod_host', name: 'Website Hosting', description: 'Hosting', active: true } },
      { id: 'price_care', active: true, unit_amount: 25000, currency: 'cad', recurring: { interval: 'month', interval_count: 1 }, product: { id: 'prod_care', name: 'Website care plus', active: true } },
    ] }),
    post: async (path, params) => { posts.push([path, params]); return path === '/prices' ? { id: 'price_new' } : { id: 'plink_1', url: 'https://buy.stripe.com/sub' }; },
  };
  const { db, req, emails } = await server(t, {}, { stripe });
  const cookie = `pk_admin=${A.createSession(db, 'rh@pklabs.ca')}`;
  const api = (path, body) => req(`/admin/api/${path}`, { method: body ? 'POST' : 'GET', headers: { cookie, 'X-Ledger': '1', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

  const created = await (await api('offers', { client_name: 'Cavera Insurance', client_email: 'ap@cavera.test', payments: 12, options: [{ price: 'price_host' }, { price: 'price_care' }] })).json();
  const id = created.id;
  const offer = await (await api(`offers/${id}`)).json();
  const path = new URL(offer.link).pathname;

  await api(`offers/${id}/email`, {});
  assert.equal(emails.at(-1).to, 'ap@cavera.test');
  assert.match(emails.at(-1).text, /Website Hosting: \$60\.00 a month \+ HST/);

  const page = await (await req(path)).text();
  assert.match(page, /Choose your plan/);
  assert.match(page, new RegExp(`>${id}<`));
  assert.match(page, /\$67\.80 a month in total/);
  assert.equal(L.listInvoices(db, {}).length, 0);

  const r = await req(`${path}/choose/1`, { method: 'POST' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), `${offer.link}?chosen=1`);
  const inv = L.getInvoice(db, id);
  assert.equal(inv.public_token, offer.public_token);
  assert.equal(inv.schedule, 'monthly');
  assert.equal(inv.lines.length, 12);
  assert.deepEqual([...new Set(inv.lines.map((l) => l.amount_cents))], [6780]);
  assert.equal(inv.stripe_product, 'prod_host');
  assert.equal(inv.line_items[0].description, 'Website Hosting: 12 months × $60.00');
  assert.ok(inv.sent_date);
  assert.equal(inv.stripe_link_url, 'https://buy.stripe.com/sub');
  assert.equal(posts.find((p) => p[0] === '/prices')[1].product, 'prod_host');
  assert.ok(emails.some((m) => m.subject === 'Cavera Insurance chose Website Hosting'));

  const after = await (await req(`${path}?chosen=1`)).text();
  assert.match(after, /Thank you for choosing Website Hosting/);
  assert.match(after, /Set up monthly payments/);

  // Choosing again, or the other plan, changes nothing.
  await req(`${path}/choose/2`, { method: 'POST' });
  assert.equal(L.getInvoice(db, id).total_cents, 6780 * 12);
  assert.equal(L.listInvoices(db, {}).length, 1);
});

test('a withdrawn plan choice can’t be picked', async (t) => {
  const O = await import('../lib/offers.mjs');
  const { db, req } = await server(t);
  const id = O.createOffer(db, { client_name: 'Cavera Insurance', options: [{ price: 'price_host' }] }, PLANS);
  O.cancelOffer(db, id);
  const { public_token } = O.getOffer(db, id);
  assert.match(await (await req(`/invoice/${public_token}`)).text(), /no longer available/);
  await req(`/invoice/${public_token}/choose/1`, { method: 'POST' });
  assert.equal(L.listInvoices(db, {}).length, 0);
});

test('a one-time item in a plan choice becomes a single-payment invoice', async () => {
  const O = await import('../lib/offers.mjs');
  const db = fresh();
  const id = O.createOffer(db, { client_name: 'Cavera Insurance', hst_enabled: false, options: [{ price: 'price_host' }, { price: 'price_build' }] }, PLANS);
  const out = O.chooseOffer(db, O.getOffer(db, id).public_token, '2', '2026-11-20');
  const inv = L.getInvoice(db, out.invoice_id);
  assert.equal(inv.schedule, 'one_time');
  assert.equal(inv.lines.length, 1);
  assert.equal(inv.total_cents, 800000);
  assert.equal(inv.lines[0].due_date, '2026-11-20');
  assert.equal(inv.stripe_product, 'prod_build');
});

test('Stripe products are labelled by business, PK Labs first', async () => {
  const { listProductPrices } = await import('../lib/stripe.mjs');
  const price = (id, prod, name, amount, recurring, metadata = {}) => ({ id, unit_amount: amount, currency: 'cad', recurring, product: { id: prod, name, active: true, metadata } });
  const stripe = { get: async () => ({ has_more: false, data: [
    price('p1', 'prod_UPymbPCbhJb1TB', 'Individual', 1200, { interval: 'month', interval_count: 1 }),
    price('p2', 'prod_hosting', 'Website Hosting', 6000, { interval: 'month', interval_count: 1 }),
    price('p3', 'prod_other', 'Thing', 500, null, { brand: 'Side project' }),
    price('p4', 'prod_inv', 'Invoice ABCD-01', 100, null),
  ] }) };
  const list = await listProductPrices(stripe);
  assert.deepEqual(list.map((p) => [p.brand, p.name]), [['PK Labs', 'Website Hosting'], ['EZSay', 'Individual'], ['Side project', 'Thing']]);
});

test('a custom option needs no Stripe product and becomes a normal invoice', async () => {
  const O = await import('../lib/offers.mjs');
  const db = fresh();
  const id = O.createOffer(db, { client_name: 'Cavera Insurance', hst_enabled: false, payments: 6, options: [
    { price: 'price_host' },
    { custom: true, name: 'Hosting, friends rate', amount_cents: 4500, interval: 'month', details: 'Hosting\nBackups' },
  ] }, PLANS);
  const o = O.getOffer(db, id);
  assert.deepEqual(o.options.map((x) => [x.name, x.amount_cents, x.currency, x.product]), [['Website Hosting', 6000, 'CAD', 'prod_host'], ['Hosting, friends rate', 4500, 'CAD', null]]);
  const out = O.chooseOffer(db, o.public_token, '2', '2026-11-20');
  const inv = L.getInvoice(db, out.invoice_id);
  assert.equal(inv.schedule, 'monthly');
  assert.equal(inv.lines.length, 6);
  assert.deepEqual([...new Set(inv.lines.map((l) => l.amount_cents))], [4500]);
  assert.equal(inv.stripe_product, null);
  assert.equal(inv.line_items[0].description, 'Hosting, friends rate: 6 months × $45.00');

  assert.throws(() => O.createOffer(db, { client_name: 'X', options: [{ custom: true, name: '', amount_cents: 100 }] }, PLANS), /name/);
  assert.throws(() => O.createOffer(db, { client_name: 'X', options: [{ custom: true, name: 'A', amount_cents: 0 }] }, PLANS), /amount/);
  assert.throws(() => O.createOffer(db, { client_name: 'X', options: [{ custom: true, name: 'A', amount_cents: 100, interval: 'week' }] }, PLANS), /monthly, yearly or one-time/);
  // On its own, a custom option is in CAD; next to a USD plan it follows that plan.
  const usd = O.createOffer(db, { client_name: 'Y', options: [{ custom: true, name: 'A', amount_cents: 100 }] }, PLANS);
  assert.equal(O.getOffer(db, usd).options[0].currency, 'CAD');
});

test('paying a monthly plan upfront: the year for 10 months’ price, as one payment', async () => {
  const O = await import('../lib/offers.mjs');
  const db = fresh();
  const id = O.createOffer(db, { client_name: 'Cavera Insurance', hst_enabled: false, prepay_free_months: 2, options: [{ price: 'price_host' }, { price: 'price_care' }, { price: 'price_build' }] }, PLANS);
  const o = O.getOffer(db, id);
  assert.deepEqual(O.prepayFor(o, o.options[1]), { months: 12, free: 2, amount_cents: 250000, regular_cents: 300000, saving_cents: 50000 });
  assert.equal(O.prepayFor(o, o.options[2]), null); // one-time items have no upfront option
  assert.throws(() => O.chooseOffer(db, o.public_token, '3', '2026-11-20', { prepay: true }), /isn’t offered/);

  const out = O.chooseOffer(db, o.public_token, '2', '2026-11-20', { prepay: true });
  const inv = L.getInvoice(db, out.invoice_id);
  assert.equal(inv.schedule, 'one_time');
  assert.equal(inv.total_cents, 250000);
  assert.equal(inv.lines.length, 1);
  assert.equal(inv.stripe_product, 'prod_care');
  assert.match(inv.line_items[0].description, /12 months, paid upfront with 2 months free \(regularly \$3,000\.00\)/);
  assert.equal(O.getOffer(db, id).chosen_prepay, true);

  assert.throws(() => O.createOffer(db, { client_name: 'X', payments: 2, prepay_free_months: 2, options: [{ price: 'price_host' }] }, PLANS), /fewer than/);
});

test('the client page offers monthly or the year upfront, and the upfront choice skips the subscription', async (t) => {
  const O = await import('../lib/offers.mjs');
  const posts = [];
  const stripe = { get: async () => ({ data: [] }), post: async (path, p) => { posts.push(path); return { id: 'x', url: 'https://buy.stripe.com/x' }; } };
  const { db, req, emails } = await server(t, {}, { stripe });
  const id = O.createOffer(db, { client_name: 'Cavera Insurance', hst_enabled: false, prepay_free_months: 2, options: [{ price: 'price_care' }] }, PLANS);
  const { public_token } = O.getOffer(db, id);
  const page = await (await req(`/invoice/${public_token}`)).text();
  assert.match(page, /Pay monthly: \$250\.00 a month/);
  assert.match(page, /Pay for the year: \$2,500\.00/);
  assert.match(page, /Get 2 months free · save \$500\.00/);
  assert.equal((await req(`/invoice/${public_token}/choose/1/year`, { method: 'POST' })).status, 303);
  assert.equal(L.getInvoice(db, id).total_cents, 250000);
  assert.deepEqual(posts, []);
  assert.ok(emails.some((m) => m.subject === 'Cavera Insurance chose Website care plus, paid upfront'));
  assert.match(await (await req(`/invoice/${public_token}?chosen=1`)).text(), /Thank you for choosing Website care plus, paid upfront for the year/);
});
