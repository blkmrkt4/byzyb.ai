// Painkiller Labs invoice ledger. Plain node:http, node:sqlite and fetch; no dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.mjs';
import * as L from './lib/ledger.mjs';
import * as R from './lib/reports.mjs';
import * as B from './lib/bank.mjs';
import * as RM from './lib/reminders.mjs';
import * as A from './lib/auth.mjs';
import * as O from './lib/offers.mjs';
import { sendLoginEmail, sendInvoiceEmail } from './lib/email.mjs';
import { renderInvoicePage, renderNotFound, invoiceEmail, invoiceEmailDraft, renderPlanPage, planEmail, planEmailDraft, planChosenEmail } from './lib/invoice-page.mjs';
import {
  verifyStripeSignature, makeStripe, paymentFromEvent, createPaymentLink, cancelSubscriptionAtPeriodEnd, HANDLED_EVENTS,
  ADJUSTMENT_EVENTS, adjustmentFromEvent, createLineCheckout, createLinePaymentLink, listProductPrices,
} from './lib/stripe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function makeConfig(env = process.env) {
  const port = Number(env.PORT || 4400);
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');
  return {
    port,
    publicUrl,
    siteUrl: (env.SITE_URL || 'https://www.painkiller-labs.com').replace(/\/$/, ''),
    dbFile: env.DB_FILE || path.join(env.DATA_DIR || path.join(here, 'data'), 'ledger.db'),
    adminEmail: env.ADMIN_EMAIL || 'rh@pklabs.ca',
    // Admins added the first time the ledger starts with an empty access list.
    bootstrapAdmins: (env.ADMIN_EMAILS || env.ADMIN_EMAIL || 'rh@pklabs.ca').split(/[\s,;]+/).filter(Boolean),
    emailFrom: env.EMAIL_FROM || 'Painkiller Labs <admin@painkiller-labs.com>',
    resendKey: env.RESEND_API_KEY || '',
    stripeKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    secureCookies: publicUrl.startsWith('https://'),
    // Shown on the client's invoice. Canadian invoices with HST must show the HST number.
    business: {
      name: env.BUSINESS_NAME || 'Painkiller Labs Inc.',
      shortName: env.BUSINESS_SHORT_NAME || 'Painkiller Labs',
      address: (env.BUSINESS_ADDRESS || '8 Parkwood Avenue\nToronto, ON M4V 2W8\nCanada').replace(/\\n/g, '\n'),
      email: env.BUSINESS_EMAIL || env.ADMIN_EMAIL || 'rh@pklabs.ca',
      hstNumber: env.HST_NUMBER || '',
      etransferEmail: env.ETRANSFER_EMAIL || '',
      publicUrl,
    },
    // Local development only: /admin/dev-login signs in without email. Refused
    // unless PUBLIC_URL is localhost and the request comes from this machine.
    devLogin: env.LEDGER_DEV_LOGIN === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicUrl),
  };
}

const STATIC = {
  'admin.css': 'text/css; charset=utf-8',
  'admin.js': 'text/javascript; charset=utf-8',
};
const SETUP_MANUAL = ['webhook_events', 'checkout'];

const INVOICE_STATIC = {
  'invoice.css': 'text/css; charset=utf-8',
  'invoice.js': 'text/javascript; charset=utf-8',
};

const BASE_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
const redirect = (res, to, extra = {}) => { res.writeHead(303, { ...BASE_HEADERS, Location: to, ...extra }); res.end(); };

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new L.LedgerError('Request too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} | Painkiller Labs admin</title>
<link rel="stylesheet" href="/admin/static/admin.css">
</head>
<body>
${body}
</body>
</html>`;
}

function authPage(heading, inner) {
  return page(heading, `<main class="auth"><div class="auth-card"><p class="eyebrow">Painkiller Labs admin</p><h1>${esc(heading)}</h1>${inner}</div></main>`);
}

export function createApp(cfg, db, { stripe = makeStripe(cfg.stripeKey), sendEmail = sendLoginEmail, sendInvoice = sendInvoiceEmail, log = console } = {}) {
  const shell = fs.readFileSync(path.join(here, 'public', 'admin.html'), 'utf8');
  A.seedUsers(db, cfg.bootstrapAdmins);
  const reminderOpts = {
    business: cfg.business, publicUrl: cfg.publicUrl,
    send: (m) => sendInvoice({ ...m, replyTo: cfg.adminEmail, apiKey: cfg.resendKey, from: cfg.emailFrom }),
  };

  async function handleWebhook(req, res) {
    const raw = await readBody(req, 2_000_000);
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], cfg.webhookSecret)) {
      return json(res, 400, { error: 'Invalid signature' });
    }
    const event = JSON.parse(raw);
    if (ADJUSTMENT_EVENTS.includes(event.type)) {
      const adj = adjustmentFromEvent(event);
      if (adj.skip) return json(res, 200, { received: true, skipped: adj.skip });
      const out = adj.kind === 'refund' ? L.applyRefund(db, adj) : L.applyDispute(db, adj);
      // A refund for a payment the ledger never saw (e.g. a plan payment) is fine to skip.
      return json(res, 200, { received: true, kind: adj.kind, ...out });
    }
    if (!HANDLED_EVENTS.includes(event.type)) return json(res, 200, { received: true, skipped: event.type });
    const rec = await paymentFromEvent(event, stripe);
    if (rec.skip) return json(res, 200, { received: true, skipped: rec.skip });
    const out = L.upsertStripePayment(db, rec);
    if (out.invoice_paid && out.subscription && stripe) {
      // Last payment on a recurring invoice: stop the subscription renewing.
      try {
        await cancelSubscriptionAtPeriodEnd(stripe, out.subscription);
        L.audit(db, 'invoice', out.invoice_id, 'subscription_end', { subscription: out.subscription });
      } catch (err) {
        log.error('[ledger] could not cancel subscription', out.subscription, err.message);
        L.audit(db, 'invoice', out.invoice_id, 'subscription_end_failed', { subscription: out.subscription, error: err.message });
      }
    }
    return json(res, 200, { received: true, ...out });
  }

  async function handleApi(req, res, url, parts, user) {
    const method = req.method;
    const isAdmin = user.role === 'admin';
    // A custom header can't be sent cross-site without a CORS preflight, which
    // this server never allows, so it blocks cross-site form posts.
    if (method !== 'GET' && req.headers['x-ledger'] !== '1') return json(res, 403, { error: 'Missing X-Ledger header' });
    const [a, b, c] = parts;
    const limit = a === 'bank' && b === 'import' ? 8_000_000 : 1_000_000;
    const body = method === 'GET' ? {} : JSON.parse((await readBody(req, limit)) || '{}');
    const q = Object.fromEntries(url.searchParams);
    // Read-only people can look at everything except the access list, and change nothing.
    if (!isAdmin && (method !== 'GET' || ['users', 'settings'].includes(a))) {
      return json(res, 403, { error: 'You have read-only access. Ask an admin to make this change.' });
    }

    if (method === 'GET' && a === 'config') {
      return json(res, 200, {
        me: user, reminders: RM.remindersEnabled(db),
        stripe: !!stripe, email: !!cfg.resendKey, admin_email: cfg.adminEmail, today: L.todayToronto(),
        public_url: cfg.publicUrl, hst_number: cfg.business.hstNumber,
      });
    }
    if (method === 'GET' && a === 'dashboard') return json(res, 200, { ...R.dashboard(db), setup: await setupStatus() });
    if (method === 'POST' && a === 'setup' && SETUP_MANUAL.includes(b)) {
      L.setSetting(db, `setup.${b}`, body.done ? 'done' : '');
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && a === 'reports') return reportsApi(res, b, q);
    if (a === 'bank' || a === 'bank.csv') return bankApi(req, res, method, parts, body, q);
    if (a === 'users') {
      if (method === 'GET' && !b) return json(res, 200, { users: A.listUsers(db), roles: A.ROLES, me: user.email });
      if (method === 'POST' && !b) return json(res, 201, { user: A.addUser(db, body, user.email) });
      if (method === 'POST' && b && c === 'remove') { A.removeUser(db, b, user.email); return json(res, 200, { ok: true }); }
      if (method === 'POST' && b && !c) return json(res, 200, { user: A.updateUser(db, b, body, user.email) });
    }
    if (a === 'settings') {
      if (method === 'GET' && !b) return json(res, 200, { reminders: RM.remindersEnabled(db), stages: RM.STAGES, due_today: RM.dueReminders(db), email: !!cfg.resendKey });
      if (method === 'POST' && b === 'reminders') { RM.setRemindersEnabled(db, !!body.enabled); return json(res, 200, { ok: true }); }
    }
    if (a === 'clients') {
      if (method === 'GET' && !b) return json(res, 200, { clients: L.listClients(db) });
      if (method === 'GET' && b === 'all') return json(res, 200, { clients: L.clientsOverview(db) });
      if (method === 'GET' && b === 'lookup') return json(res, 200, { client: L.findClientByName(db, q.name) });
      if (method === 'GET' && b) return json(res, 200, L.getClient(db, b));
      if (method === 'POST' && b && c === 'merge') return json(res, 200, L.mergeClients(db, b, body.into));
      if (method === 'POST' && b && !c) return json(res, 200, L.updateClient(db, b, body));
    }
    if (method === 'GET' && a === 'next-id') return json(res, 200, { id: L.nextInvoiceId(db) });
    if (a === 'offers') {
      if (method === 'GET' && !b) return json(res, 200, { offers: O.listOffers(db) });
      if (method === 'POST' && !b) {
        const { products } = await stripeProducts();
        if (!stripe) throw new L.LedgerError('Stripe isn’t connected, so there are no plans to offer');
        return json(res, 201, { id: O.createOffer(db, body, products) });
      }
      if (method === 'GET' && b && !c) return json(res, 200, { ...O.getOffer(db, b), link: offerLink(O.getOffer(db, b)) });
      if (method === 'POST' && b && c === 'email') return json(res, 200, await emailOffer(b, body.to, edits(body)));
      if (method === 'GET' && b && c === 'email-draft') {
        const o = O.getOffer(db, b);
        return json(res, 200, { to: o.client_email, ...planEmailDraft(o, { business: cfg.business }) });
      }
      if (method === 'POST' && b && c === 'cancel') { O.cancelOffer(db, b); return json(res, 200, { ok: true }); }
    }
    if (method === 'GET' && a === 'stripe-products') return json(res, 200, await stripeProducts());
    if (method === 'GET' && a === 'invoices' && !b) return json(res, 200, { invoices: L.listInvoices(db, q), clients: L.listClients(db) });
    if (method === 'GET' && a === 'invoices.csv') {
      const name = `invoices-${L.todayToronto()}.csv`;
      return send(res, 200, L.toCsv(L.listInvoices(db, q)), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}"` });
    }
    if (method === 'POST' && a === 'invoices' && !b) {
      const id = L.createInvoice(db, body);
      let linkError = null;
      if (body.create_stripe_link) linkError = await makeLink(id);
      return json(res, 201, { id, link_error: linkError });
    }
    if (method === 'GET' && a === 'invoices' && b && !c) return json(res, 200, L.getInvoice(db, b));
    if (method === 'GET' && a === 'invoices' && b && c === 'email-draft') {
      const inv = L.getInvoice(db, b);
      return json(res, 200, { to: inv.client_email, ...invoiceEmailDraft(inv, { business: cfg.business }) });
    }
    if (method === 'POST' && a === 'invoices' && b) {
      if (c === 'edit') return json(res, 200, L.updateInvoice(db, b, body));
      if (c === 'send') { L.markSent(db, b, body); return json(res, 200, { ok: true }); }
      if (c === 'void') { L.voidInvoice(db, b, body.reason); return json(res, 200, { ok: true }); }
      if (c === 'payments') return json(res, 201, { id: L.recordManualPayment(db, body) });
      if (c === 'email') return json(res, 200, await emailInvoice(b, body.to, edits(body)));
      if (c === 'remind') return json(res, 200, await RM.sendManualReminder(db, b, body, reminderOpts));
      if (c === 'reminders') { RM.setInvoiceReminders(db, b, !!body.on); return json(res, 200, { ok: true }); }
      if (c === 'lines' && parts[3] && parts[4] === 'due') {
        L.setLineDueDate(db, b, parts[3], body.due_date);
        return json(res, 200, { ok: true });
      }
      if (c === 'stripe-link') {
        const err = await makeLink(b.toUpperCase());
        return err ? json(res, 400, { error: err }) : json(res, 200, { ok: true });
      }
    }
    if (method === 'GET' && a === 'payments' && b === 'unmatched') {
      return json(res, 200, { payments: L.unmatchedPayments(db, { includeIgnored: q.ignored === '1' }), open_lines: L.openLines(db) });
    }
    if (method === 'POST' && a === 'payments' && b) {
      if (c === 'assign') return json(res, 200, { line: L.assignPayment(db, b, body.line_id) });
      if (c === 'unassign') { L.unassignPayment(db, b); return json(res, 200, { ok: true }); }
      if (c === 'ignore') { L.ignorePayment(db, b, body.note); return json(res, 200, { ok: true }); }
      if (c === 'restore') { L.restorePayment(db, b); return json(res, 200, { ok: true }); }
    }
    return json(res, 404, { error: 'Not found' });
  }

  // ---------- setup checklist ----------
  // Things only the owner can do outside the ledger. Each is detected where the
  // ledger can see it, and can be ticked off by hand where it can't.
  let checkoutCheck = { at: 0, ok: false };
  async function checkoutAllowed() {
    if (!stripe) return false;
    if (Date.now() - checkoutCheck.at < 10 * 60_000) return checkoutCheck.ok;
    let ok = false;
    try { await stripe.get('/checkout/sessions', { limit: 1 }); ok = true; } catch { ok = false; }
    checkoutCheck = { at: Date.now(), ok };
    return ok;
  }
  let bankCheck = { at: 0, ok: false };
  async function payoutsReadable() {
    if (!stripe) return false;
    if (L.getSetting(db, 'bank.synced_at') && L.getSetting(db, 'bank.charges_readable') === '1') return true;
    if (Date.now() - bankCheck.at < 10 * 60_000) return bankCheck.ok;
    let ok = false;
    try {
      await stripe.get('/balance');
      await stripe.get('/payouts', { limit: 1 });
      await stripe.get('/charges', { limit: 1 });
      ok = true;
    } catch { ok = false; }
    bankCheck = { at: Date.now(), ok };
    return ok;
  }
  async function setupStatus() {
    const manual = (k) => L.getSetting(db, `setup.${k}`) === 'done';
    const sawAdjustment = !!db.prepare("SELECT 1 FROM audit_log WHERE action IN ('refund', 'dispute') LIMIT 1").get();
    return [
      { key: 'webhook_events', done: manual('webhook_events') || sawAdjustment, manual: true },
      { key: 'checkout', done: manual('checkout') || await checkoutAllowed(), manual: true },
      { key: 'bank_read', done: await payoutsReadable(), manual: false },
      { key: 'hst_number', done: !!cfg.business.hstNumber, manual: false },
    ];
  }

  // ---------- bank ----------
  // Opening the Bank page syncs with Stripe if the last sync is over 30 minutes old.
  let syncing = null;
  async function sync() {
    syncing ||= B.syncStripe(db, stripe).finally(() => { syncing = null; });
    return syncing;
  }
  async function bankApi(req, res, method, [a, b, c, d], body, q) {
    if (method === 'GET' && a === 'bank' && !b) {
      let syncError = null;
      const last = L.getSetting(db, 'bank.synced_at');
      if (stripe && q.sync !== '0' && (!last || Date.now() - Date.parse(last) > 30 * 60_000)) {
        try { await sync(); } catch (err) { syncError = err.message; if (!(err instanceof B.StripePermissionError)) log.error('[ledger] stripe sync failed:', err.message); }
      }
      return json(res, 200, { ...B.bankReport(db, { from: q.from, to: q.to }), stripe: !!stripe, sync_error: syncError });
    }
    if (method === 'GET' && a === 'bank.csv') {
      const r = B.bankReport(db, { from: q.from, to: q.to });
      return send(res, 200, B.bankCsv(r), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="deposits-${q.from}-to-${q.to}.csv"` });
    }
    if (method === 'POST' && b === 'sync') return json(res, 200, await sync());
    if (method === 'POST' && b === 'import') return json(res, 200, B.importStatement(db, body.csv, { currency: body.currency }));
    if (method === 'POST' && b === 'lines' && c) {
      if (d === 'match') return json(res, 200, B.matchBankLine(db, c, { type: body.type, target: body.id }));
      if (d === 'unmatch') { B.unmatchBankLine(db, c); return json(res, 200, { ok: true }); }
      if (d === 'ignore') { B.ignoreBankLine(db, c, body.note); return json(res, 200, { ok: true }); }
      if (d === 'restore') { B.restoreBankLine(db, c); return json(res, 200, { ok: true }); }
    }
    return json(res, 404, { error: 'Not found' });
  }

  // ---------- reports ----------
  function reportsApi(res, name, q) {
    const csv = name?.endsWith('.csv');
    const kind = csv ? name.slice(0, -4) : name;
    const today = L.todayToronto();
    const file = (n, body) => send(res, 200, body, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${n}"` });
    if (kind === 'receivables') {
      const r = R.receivables(db, today);
      return csv ? file(`receivables-${today}.csv`, R.receivablesCsv(r)) : json(res, 200, r);
    }
    if (kind === 'payments') {
      const r = R.paymentsReport(db, { from: q.from, to: q.to });
      return csv ? file(`payments-${q.from}-to-${q.to}.csv`, R.paymentsCsv(r)) : json(res, 200, r);
    }
    if (kind === 'statement' && !csv) return json(res, 200, R.clientStatement(db, q.client, today));
    return json(res, 404, { error: 'Not found' });
  }

  // Your edits to the email, kept within sensible sizes.
  const edits = (body) => ({
    subject: String(body.subject || '').trim().slice(0, 200) || undefined,
    message: String(body.message || '').trim().slice(0, 6000) || undefined,
  });

  async function emailInvoice(id, toOverride, edited = {}) {
    const inv = L.getInvoice(db, id);
    if (inv.voided_at) throw new L.LedgerError('A void invoice can’t be emailed');
    const to = String(toOverride || inv.client_email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new L.LedgerError('Add the client’s email address first');
    const link = `${cfg.publicUrl}/invoice/${inv.public_token}`;
    const mail = invoiceEmail(inv, { business: cfg.business, link, ...edited });
    try {
      await sendInvoice({ to, ...mail, replyTo: cfg.adminEmail, apiKey: cfg.resendKey, from: cfg.emailFrom });
    } catch (err) {
      log.error('[ledger] invoice email failed:', err.message);
      throw new L.LedgerError(`The email didn’t send: ${err.message}`, 502);
    }
    L.markSent(db, inv.id, { sent_date: L.todayToronto(), sent_to: to, sent_via: 'email' });
    return { sent_to: to };
  }

  const offerLink = (o) => `${cfg.publicUrl}/invoice/${o.public_token}`;

  async function emailOffer(id, toOverride, edited = {}) {
    const o = O.getOffer(db, id);
    if (o.cancelled_at) throw new L.LedgerError('This plan choice was withdrawn');
    if (o.chosen_key) throw new L.LedgerError('The client has already chosen. Email the invoice instead.');
    const to = String(toOverride || o.client_email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new L.LedgerError('Add the client’s email address first');
    const mail = planEmail(o, { business: cfg.business, link: offerLink(o), ...edited });
    try {
      await sendInvoice({ to, ...mail, replyTo: cfg.adminEmail, apiKey: cfg.resendKey, from: cfg.emailFrom });
    } catch (err) {
      log.error('[ledger] plan email failed:', err.message);
      throw new L.LedgerError(`The email didn’t send: ${err.message}`, 502);
    }
    O.markOfferSent(db, o.id, { sent_to: to });
    return { sent_to: to };
  }

  // The client picked a plan: the invoice now exists at the same link. Set up
  // the Stripe subscription for it and tell the owner, then show the invoice.
  async function handleOffer(req, res, offer, action, key, extra, headers) {
    const self = offerLink(offer);
    if (!action && req.method === 'GET') {
      return send(res, 200, renderPlanPage(offer, { business: cfg.business, token: offer.public_token, today: L.todayToronto() }), 'text/html; charset=utf-8', headers);
    }
    if (action === 'choose' && req.method === 'POST' && /^\d$/.test(key || '')) {
      let out;
      if (extra && extra !== 'year') return send(res, 404, renderNotFound(cfg.business), 'text/html; charset=utf-8', headers);
      try { out = O.chooseOffer(db, offer.public_token, key, L.todayToronto(), { prepay: extra === 'year' }); } catch (err) {
        if (!(err instanceof L.LedgerError)) throw err;
        return redirect(res, self);
      }
      if (out.created) {
        if (stripe && out.option.interval && !out.prepay && L.getInvoice(db, out.invoice_id).lines.length > 1) {
          const err = await makeLink(out.invoice_id);
          if (err) log.error('[ledger] subscription link after plan choice failed', out.invoice_id, err);
        }
        const mail = planChosenEmail(offer, out.option, { prepay: out.prepay, business: cfg.business, adminLink: `${cfg.publicUrl}/admin/invoices/${out.invoice_id}` });
        sendInvoice({ to: cfg.adminEmail, ...mail, apiKey: cfg.resendKey, from: cfg.emailFrom })
          .catch((err) => log.error('[ledger] plan-chosen email failed:', err.message));
      }
      return redirect(res, `${self}?chosen=1`);
    }
    return send(res, 404, renderNotFound(cfg.business), 'text/html; charset=utf-8', headers);
  }

  // The client's invoice page and its Pay buttons. The token in the URL is the
  // only key, so these pages never show anything not on the invoice itself.
  async function handleInvoice(req, res, url, rest) {
    const headers = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'" };
    const [token, action, suffix] = rest;
    if (token === 'assets' && INVOICE_STATIC[action] && !suffix) {
      return send(res, 200, fs.readFileSync(path.join(here, 'public', action)), INVOICE_STATIC[action], { 'Cache-Control': 'no-cache' });
    }
    let inv;
    try { inv = L.getInvoiceByToken(db, token); } catch {
      // Not an invoice yet: maybe a plan choice waiting for the client to pick.
      let offer;
      try { offer = O.getOfferByToken(db, token); } catch {
        return send(res, 404, renderNotFound(cfg.business), 'text/html; charset=utf-8', headers);
      }
      return handleOffer(req, res, offer, action, suffix, rest[3], headers);
    }
    const self = `${cfg.publicUrl}/invoice/${inv.public_token}`;
    if (!action && req.method === 'GET') {
      const n = url.searchParams.get('paid') === '1' ? 'paid' : url.searchParams.get('pay') === 'unavailable' ? 'nopay'
        : url.searchParams.get('chosen') === '1' ? 'chosen' : null;
      return send(res, 200, renderInvoicePage(inv, {
        business: cfg.business, today: L.todayToronto(), token: inv.public_token, canPay: !!stripe, notice: n,
      }), 'text/html; charset=utf-8', headers);
    }
    if (action === 'pay' && req.method === 'POST' && /^\d{2}$/.test(suffix || '')) {
      const line = inv.lines.find((l) => l.suffix === Number(suffix));
      if (!line || inv.voided_at || !line.outstanding_cents) return redirect(res, self);
      if (!stripe) return redirect(res, `${self}?pay=unavailable`);
      try {
        return redirect(res, await createLineCheckout(stripe, inv, line, { successUrl: `${self}?paid=1`, cancelUrl: self }));
      } catch (err) {
        log.error('[ledger] checkout failed, trying a payment link', inv.id, err.message);
      }
      // Fallback: a payment link for this payment, reused while the amount owed is the same.
      try {
        if (line.pay_link_url && line.pay_link_amount === line.outstanding_cents) return redirect(res, line.pay_link_url);
        const link = await createLinePaymentLink(stripe, inv, line, { successUrl: `${self}?paid=1` });
        L.savePayLink(db, line.id, link.url, line.outstanding_cents);
        return redirect(res, link.url);
      } catch (err) {
        log.error('[ledger] payment link failed', inv.id, err.message);
        L.audit(db, 'invoice', inv.id, 'checkout_failed', { line: line.ref, error: err.message });
        return redirect(res, `${self}?pay=unavailable`);
      }
    }
    return send(res, 404, renderNotFound(cfg.business), 'text/html; charset=utf-8', headers);
  }

  // Your Stripe products and prices, for starting an invoice from one. Cached briefly.
  let productCache = null;
  async function stripeProducts() {
    if (!stripe) return { products: [] };
    if (productCache && Date.now() - productCache.at < 5 * 60_000) return productCache.value;
    try {
      const value = { products: await listProductPrices(stripe) };
      productCache = { at: Date.now(), value };
      return value;
    } catch (err) {
      log.error('[ledger] could not list Stripe products', err.message);
      return { products: [], error: 'Couldn’t load your Stripe products.' };
    }
  }

  async function makeLink(id) {
    if (!stripe) return 'Stripe isn’t connected (STRIPE_SECRET_KEY is not set).';
    const inv = L.getInvoice(db, id);
    if (inv.voided_at) return 'Invoice is void.';
    if (inv.stripe_link_url) return 'This invoice already has a payment link.';
    try {
      L.setStripeLink(db, id, await createPaymentLink(stripe, inv, cfg.siteUrl, { today: L.todayToronto() }));
      return null;
    } catch (err) {
      L.audit(db, 'invoice', id, 'stripe_link_failed', { error: err.message });
      return err.message;
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p === '/health') return send(res, 200, 'ok', 'text/plain');
    if (p === '/api/stripe/webhook' && req.method === 'POST') return handleWebhook(req, res);
    if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', 'text/plain');

    if (p.startsWith('/invoice/')) {
      return handleInvoice(req, res, url, p.slice('/invoice/'.length).split('/').map(decodeURIComponent));
    }

    if (p.startsWith('/admin/static/')) {
      const name = p.slice('/admin/static/'.length);
      if (!STATIC[name]) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, fs.readFileSync(path.join(here, 'public', name)), STATIC[name], { 'Cache-Control': 'no-cache' });
    }

    if (p === '/admin/login' && req.method === 'GET') {
      const sent = url.searchParams.get('sent') === '1';
      return send(res, 200, authPage('Sign in', sent
        ? `<p>If that address is on the access list, a sign-in link is on its way. It works once and expires in 15 minutes.</p><p><a href="/admin/login">Send another link</a></p>`
        : `<p>Enter your email. If you're on the access list, we'll send you a one-time sign-in link.</p>
           <form method="post" action="/admin/login" class="stack">
             <label>Email <input type="email" name="email" required autocomplete="email" autofocus></label>
             <button class="btn" type="submit">Email me a sign-in link</button>
           </form>`));
    }
    if (p === '/admin/login' && req.method === 'POST') {
      const email = new URLSearchParams(await readBody(req, 10_000)).get('email');
      const issued = A.issueLoginToken(db, email);
      if (issued) {
        const link = `${cfg.publicUrl}/admin/auth?token=${encodeURIComponent(issued.raw)}`;
        try { await sendEmail({ to: issued.email, link, apiKey: cfg.resendKey, from: cfg.emailFrom }); }
        catch (err) { log.error('[ledger] sign-in email failed:', err.message); }
      }
      return redirect(res, '/admin/login?sent=1');
    }
    // The emailed link only shows a button. Email scanners (Microsoft Safe
    // Links) open links before you do, so the token is spent on the POST.
    if (p === '/admin/auth' && req.method === 'GET') {
      const t = url.searchParams.get('token') || '';
      if (!A.loginTokenValid(db, t)) {
        return send(res, 400, authPage('Link expired', `<p>This sign-in link has expired or has already been used.</p><p><a class="btn" href="/admin/login">Get a new link</a></p>`));
      }
      return send(res, 200, authPage('Sign in', `<form method="post" action="/admin/auth" class="stack">
        <input type="hidden" name="token" value="${esc(t)}">
        <button class="btn" type="submit">Sign in to admin</button></form>`));
    }
    if (p === '/admin/auth' && req.method === 'POST') {
      const t = new URLSearchParams(await readBody(req, 10_000)).get('token');
      const session = A.redeemLoginToken(db, t);
      if (!session) return send(res, 400, authPage('Link expired', `<p>This sign-in link has expired or has already been used.</p><p><a class="btn" href="/admin/login">Get a new link</a></p>`));
      return redirect(res, '/admin/dashboard', { 'Set-Cookie': A.sessionCookie(session, cfg.secureCookies) });
    }
    if (p === '/admin/dev-login' && cfg.devLogin && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      const who = A.getUser(db, url.searchParams.get('as') || '') || db.prepare("SELECT email FROM users WHERE role = 'admin' AND removed_at IS NULL LIMIT 1").get();
      return redirect(res, '/admin/dashboard', { 'Set-Cookie': A.sessionCookie(A.createSession(db, who.email), false) });
    }
    if (p === '/admin/logout' && req.method === 'POST') {
      A.endSession(db, req);
      return redirect(res, '/admin/login', { 'Set-Cookie': A.clearCookie(cfg.secureCookies) });
    }

    if (p === '/admin' || p.startsWith('/admin/')) {
      const user = A.sessionUser(db, req);
      if (p.startsWith('/admin/api/')) {
        if (!user) return json(res, 401, { error: 'Signed out' });
        return L.actor.run(user, () => handleApi(req, res, url, p.slice('/admin/api/'.length).split('/').map(decodeURIComponent), user));
      }
      if (!user) return redirect(res, '/admin/login');
      if (p === '/admin') return redirect(res, '/admin/dashboard');
      return send(res, 200, shell);
    }

    return send(res, 404, 'Not found', 'text/plain');
  }

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      const status = err instanceof L.LedgerError ? err.status : err instanceof SyntaxError ? 400 : 500;
      if (status === 500) log.error('[ledger]', err);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = makeConfig();
  const db = openDb(cfg.dbFile);
  const server = http.createServer(createApp(cfg, db));
  // Railway sends SIGTERM when it replaces a deployment. Finish open requests,
  // close the database and exit 0 so a routine restart isn't reported as a crash.
  const stop = (sig) => {
    console.log(`[ledger] ${sig} received, shutting down`);
    server.close(() => { db.close(); process.exit(0); });
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  server.listen(cfg.port, () => {
    console.log(`[ledger] listening on :${cfg.port} · db ${cfg.dbFile} · stripe ${cfg.stripeKey ? 'on' : 'off'} · email ${cfg.resendKey ? 'resend' : 'log only'}`);
    if (!cfg.webhookSecret) console.warn('[ledger] STRIPE_WEBHOOK_SECRET is not set; webhooks will be rejected.');
  });
  // Payment reminders: checked hourly, sent only when switched on and during the working day.
  const reminderOpts = {
    business: cfg.business, publicUrl: cfg.publicUrl,
    send: (m) => sendInvoiceEmail({ ...m, replyTo: cfg.adminEmail, apiKey: cfg.resendKey, from: cfg.emailFrom }),
  };
  const tick = () => L.actor.run({ email: 'automatic reminders' }, () => RM.runReminders(db, reminderOpts))
    .then((r) => { if (r.sent || r.failed) console.log('[ledger] reminders', r); })
    .catch((err) => console.error('[ledger] reminders run failed', err));
  setTimeout(tick, 2 * 60_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}
