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
  assert.equal(signIn.headers.get('location'), '/admin/invoices');
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
  const cookie = `pk_admin=${A.createSession(db)}`;
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
