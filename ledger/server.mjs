// Painkiller Labs invoice ledger. Plain node:http, node:sqlite and fetch; no dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.mjs';
import * as L from './lib/ledger.mjs';
import * as R from './lib/reports.mjs';
import * as A from './lib/auth.mjs';
import { sendLoginEmail, sendInvoiceEmail } from './lib/email.mjs';
import { renderInvoicePage, renderNotFound, invoiceEmail } from './lib/invoice-page.mjs';
import {
  verifyStripeSignature, makeStripe, paymentFromEvent, createPaymentLink, cancelSubscriptionAtPeriodEnd, HANDLED_EVENTS,
  ADJUSTMENT_EVENTS, adjustmentFromEvent, createLineCheckout, createLinePaymentLink,
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

  async function handleApi(req, res, url, parts) {
    const method = req.method;
    // A custom header can't be sent cross-site without a CORS preflight, which
    // this server never allows, so it blocks cross-site form posts.
    if (method !== 'GET' && req.headers['x-ledger'] !== '1') return json(res, 403, { error: 'Missing X-Ledger header' });
    const body = method === 'GET' ? {} : JSON.parse((await readBody(req)) || '{}');
    const q = Object.fromEntries(url.searchParams);
    const [a, b, c] = parts;

    if (method === 'GET' && a === 'config') {
      return json(res, 200, {
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
    if (method === 'GET' && a === 'clients') return json(res, 200, { clients: L.listClients(db) });
    if (method === 'GET' && a === 'next-id') return json(res, 200, { id: L.nextInvoiceId(db) });
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
    if (method === 'POST' && a === 'invoices' && b) {
      if (c === 'edit') return json(res, 200, L.updateInvoice(db, b, body));
      if (c === 'send') { L.markSent(db, b, body); return json(res, 200, { ok: true }); }
      if (c === 'void') { L.voidInvoice(db, b, body.reason); return json(res, 200, { ok: true }); }
      if (c === 'payments') return json(res, 201, { id: L.recordManualPayment(db, body) });
      if (c === 'email') return json(res, 200, await emailInvoice(b, body.to));
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
  async function setupStatus() {
    const manual = (k) => L.getSetting(db, `setup.${k}`) === 'done';
    const sawAdjustment = !!db.prepare("SELECT 1 FROM audit_log WHERE action IN ('refund', 'dispute') LIMIT 1").get();
    return [
      { key: 'webhook_events', done: manual('webhook_events') || sawAdjustment, manual: true },
      { key: 'checkout', done: manual('checkout') || await checkoutAllowed(), manual: true },
      { key: 'hst_number', done: !!cfg.business.hstNumber, manual: false },
    ];
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

  async function emailInvoice(id, toOverride) {
    const inv = L.getInvoice(db, id);
    if (inv.voided_at) throw new L.LedgerError('A void invoice can’t be emailed');
    const to = String(toOverride || inv.client_email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new L.LedgerError('Add the client’s email address first');
    const link = `${cfg.publicUrl}/invoice/${inv.public_token}`;
    const mail = invoiceEmail(inv, { business: cfg.business, link });
    try {
      await sendInvoice({ to, ...mail, replyTo: cfg.adminEmail, apiKey: cfg.resendKey, from: cfg.emailFrom });
    } catch (err) {
      log.error('[ledger] invoice email failed:', err.message);
      throw new L.LedgerError(`The email didn’t send: ${err.message}`, 502);
    }
    L.markSent(db, inv.id, { sent_date: L.todayToronto(), sent_to: to, sent_via: 'email' });
    return { sent_to: to };
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
      return send(res, 404, renderNotFound(cfg.business), 'text/html; charset=utf-8', headers);
    }
    const self = `${cfg.publicUrl}/invoice/${inv.public_token}`;
    if (!action && req.method === 'GET') {
      const n = url.searchParams.get('paid') === '1' ? 'paid' : url.searchParams.get('pay') === 'unavailable' ? 'nopay' : null;
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

  async function makeLink(id) {
    if (!stripe) return 'Stripe isn’t connected (STRIPE_SECRET_KEY is not set).';
    const inv = L.getInvoice(db, id);
    if (inv.voided_at) return 'Invoice is void.';
    if (inv.stripe_link_url) return 'This invoice already has a payment link.';
    try {
      L.setStripeLink(db, id, await createPaymentLink(stripe, inv, cfg.siteUrl));
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
        ? `<p>If that address is the admin's, a sign-in link is on its way. It works once and expires in 15 minutes.</p><p><a href="/admin/login">Send another link</a></p>`
        : `<p>We'll email a one-time sign-in link to the admin address.</p>
           <form method="post" action="/admin/login" class="stack">
             <label>Email <input type="email" name="email" required autocomplete="email" value="${esc(cfg.adminEmail)}"></label>
             <button class="btn" type="submit">Email me a sign-in link</button>
           </form>`));
    }
    if (p === '/admin/login' && req.method === 'POST') {
      const email = new URLSearchParams(await readBody(req, 10_000)).get('email');
      const raw = A.issueLoginToken(db, email, cfg.adminEmail);
      if (raw) {
        const link = `${cfg.publicUrl}/admin/auth?token=${encodeURIComponent(raw)}`;
        try { await sendEmail({ to: cfg.adminEmail, link, apiKey: cfg.resendKey, from: cfg.emailFrom }); }
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
      return redirect(res, '/admin/dashboard', { 'Set-Cookie': A.sessionCookie(A.createSession(db), false) });
    }
    if (p === '/admin/logout' && req.method === 'POST') {
      A.endSession(db, req);
      return redirect(res, '/admin/login', { 'Set-Cookie': A.clearCookie(cfg.secureCookies) });
    }

    if (p === '/admin' || p.startsWith('/admin/')) {
      const authed = A.sessionValid(db, req);
      if (p.startsWith('/admin/api/')) {
        if (!authed) return json(res, 401, { error: 'Signed out' });
        return handleApi(req, res, url, p.slice('/admin/api/'.length).split('/').map(decodeURIComponent));
      }
      if (!authed) return redirect(res, '/admin/login');
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
}
