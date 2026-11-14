// Painkiller Labs invoice ledger. Plain node:http, node:sqlite and fetch; no dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.mjs';
import * as L from './lib/ledger.mjs';
import * as A from './lib/auth.mjs';
import { sendLoginEmail } from './lib/email.mjs';
import {
  verifyStripeSignature, makeStripe, paymentFromEvent, createPaymentLink, cancelSubscriptionAtPeriodEnd, HANDLED_EVENTS,
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
    // Local development only: /admin/dev-login signs in without email. Refused
    // unless PUBLIC_URL is localhost and the request comes from this machine.
    devLogin: env.LEDGER_DEV_LOGIN === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicUrl),
  };
}

const STATIC = {
  'admin.css': 'text/css; charset=utf-8',
  'admin.js': 'text/javascript; charset=utf-8',
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

export function createApp(cfg, db, { stripe = makeStripe(cfg.stripeKey), sendEmail = sendLoginEmail, log = console } = {}) {
  const shell = fs.readFileSync(path.join(here, 'public', 'admin.html'), 'utf8');

  async function handleWebhook(req, res) {
    const raw = await readBody(req, 2_000_000);
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], cfg.webhookSecret)) {
      return json(res, 400, { error: 'Invalid signature' });
    }
    const event = JSON.parse(raw);
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

    if (method === 'GET' && a === 'config') return json(res, 200, { stripe: !!stripe, admin_email: cfg.adminEmail, today: L.todayToronto() });
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
      return redirect(res, '/admin/invoices', { 'Set-Cookie': A.sessionCookie(session, cfg.secureCookies) });
    }
    if (p === '/admin/dev-login' && cfg.devLogin && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      return redirect(res, '/admin/invoices', { 'Set-Cookie': A.sessionCookie(A.createSession(db), false) });
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
      if (p === '/admin') return redirect(res, '/admin/invoices');
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
