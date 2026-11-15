// Painkiller Labs admin. Plain JavaScript, no build step.
// Routes: /admin/dashboard, /admin/reports, /admin/bank, /admin/clients, /admin/clients/:id, /admin/settings, /admin/invoices, /admin/invoices/new, /admin/invoices/:id, /admin/invoices/:id/edit

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let config = { stripe: false, today: new Date().toISOString().slice(0, 10) };

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];

function money(cents, currency = 'CAD') {
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

// "1,234.5" -> 123450. Returns null if it isn't a valid amount.
function parseMoney(v) {
  const s = String(v ?? '').replace(/[\s,$]/g, '');
  if (s === '') return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
const centsToInput = (c) => (c / 100).toFixed(2);
const DAY_MS = 86_400_000;
const addDaysTo = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysFrom = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const readOnly = () => config.me?.role !== 'admin';

function niceDate(d) {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const niceDateTime = (iso) => new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto' });

const badge = (status) => `<span class="badge ${esc(status.split(' ')[0])}">${esc(status)}</span>`;
const SCHEDULE_LABEL = { one_time: 'One-time', split: 'Split (deposit, then balance)', monthly: 'Monthly', annual: 'Annual' };
const dueText = (d) => (d ? niceDate(d) : 'On completion');
const VIA_LABEL = { stripe: 'Stripe', email: 'Email', other: 'Other' };

function toast(msg, bad = false) {
  toastEl.textContent = msg;
  toastEl.className = bad ? 'toast bad' : 'toast';
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { toastEl.hidden = true; }, bad ? 6000 : 3000);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/admin/api/${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Ledger': '1' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) { location.href = '/admin/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Run an async action from a button, disabling it meanwhile and toasting errors.
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (err) { toast(err.message, true); return undefined; } finally { if (btn) btn.disabled = false; }
}

// Mirrors lib/ledger.mjs so the form can preview the schedule.
function addInterval(date, schedule, n) {
  if (n === 0 || schedule === 'one_time' || schedule === 'split') return date;
  const [y, m, d] = date.split('-').map(Number);
  const months = schedule === 'monthly' ? n : n * 12;
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}
function splitLabel(i, n) {
  if (i === 0) return 'Deposit';
  return i === n - 1 ? 'Final payment' : `Payment ${i + 1}`;
}

function buildSchedule(total, schedule, count, firstDue) {
  const min = schedule === 'split' ? 2 : 1;
  const n = schedule === 'one_time' ? 1 : Math.max(min, Math.min(120, Number(count) || min));
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => ({
    amount_cents: base + (i === 0 ? rest : 0),
    due_date: schedule === 'split' && i > 0 ? '' : addInterval(firstDue, schedule, i),
    label: schedule === 'split' ? splitLabel(i, n) : '',
  }));
}

// ---------- routing ----------

function go(path, replace = false) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  route();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
window.addEventListener('popstate', route);

async function route() {
  const p = location.pathname.replace(/\/+$/, '');
  $$('.admin-nav a', document).forEach((a) => {
    if (p.startsWith(a.getAttribute('href'))) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  try {
    let m;
    if (p === '/admin/dashboard' || p === '/admin') return await dashboardPage();
    if (p === '/admin/reports') return await reportsPage();
    if (p === '/admin/bank') return await bankPage();
    if (readOnly() && (p.endsWith('/new') || p.endsWith('/edit') || p === '/admin/settings')) {
      app.innerHTML = '<div class="empty">You have read-only access, so you can’t open this page. Ask an admin if you need to make changes. <a href="/admin/dashboard" data-nav>Go to the dashboard</a></div>';
      return;
    }
    if (p === '/admin/clients') return await clientsPage();
    if ((m = p.match(/^\/admin\/clients\/(\d+)$/))) return await clientPage(m[1]);
    if (p === '/admin/settings') return await settingsPage();
    if (p === '/admin/invoices') return await listPage();
    if (p === '/admin/invoices/new') return await formPage(null);
    if ((m = p.match(/^\/admin\/invoices\/([A-Za-z0-9]{4})\/edit$/))) return await formPage(m[1].toUpperCase());
    if ((m = p.match(/^\/admin\/invoices\/([A-Za-z0-9]{4})(?:-\d{2})?$/))) return await detailPage(m[1].toUpperCase());
    app.innerHTML = `<div class="empty">Page not found. <a href="/admin/dashboard" data-nav>Go to the dashboard</a></div>`;
  } catch (err) {
    app.innerHTML = `<div class="notice bad">${esc(err.message)}</div><p><a href="/admin/invoices" data-nav>Back to invoices</a></p>`;
  }
}

// ---------- invoices list ----------

async function listPage() {
  const params = new URLSearchParams(location.search);
  const q = params.get('q') || '';
  const status = params.get('status') || '';
  const client = params.get('client') || '';
  const filterQs = new URLSearchParams(Object.entries({ q, status, client }).filter(([, v]) => v)).toString();

  const [list, unmatched] = await Promise.all([
    api(`invoices${filterQs ? `?${filterQs}` : ''}`),
    api(`payments/unmatched${params.get('ignored') === '1' ? '?ignored=1' : ''}`),
  ]);
  document.title = 'Invoices | Painkiller Labs admin';

  const rows = list.invoices.map((inv) => `
    <tr class="click" data-id="${esc(inv.id)}">
      <td data-label="Invoice"><a class="id" href="/admin/invoices/${esc(inv.id)}" data-nav>${esc(inv.id)}</a></td>
      <td data-label="Client">${esc(inv.client_name)}</td>
      <td data-label="Total" class="num">${money(inv.total_cents, inv.currency)}</td>
      <td data-label="Paid" class="num">${money(inv.paid_cents, inv.currency)}</td>
      <td data-label="Outstanding" class="num">${money(inv.outstanding_cents, inv.currency)}</td>
      <td data-label="Status">${badge(inv.status)}</td>
      <td data-label="Sent">${inv.sent_date ? esc(niceDate(inv.sent_date)) : '<span class="muted">Not sent</span>'}</td>
    </tr>`).join('');

  const filtered = q || status || client;
  app.innerHTML = `
    <div class="head">
      <h1>Invoices</h1>
      <div class="actions">
        <a class="btn btn-quiet" href="/admin/api/invoices.csv${filterQs ? `?${filterQs}` : ''}" download>Export CSV</a>
        <a class="btn" href="/admin/invoices/new" data-nav>New invoice</a>
      </div>
    </div>
    <form class="filters" id="filters" role="search">
      <label class="q">Search <input type="search" name="q" value="${esc(q)}" placeholder="Invoice ID or client"></label>
      <label>Status <select name="status"><option value="">All</option>${['Draft', 'Sent', 'Partly paid', 'Paid', 'Overdue', 'Void']
        .map((s) => `<option${s === status ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
      <label>Client <select name="client"><option value="">All</option>${list.clients
        .map((c) => `<option${c === client ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <button class="btn btn-quiet" type="button" id="clear" data-ro${filtered ? '' : ' hidden'}>Clear</button>
    </form>
    ${list.invoices.length ? `
      <table class="tbl">
        <thead><tr><th>Invoice</th><th>Client</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Outstanding</th><th>Status</th><th>Sent</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `<div class="empty">${filtered ? 'No invoices match.' : 'No invoices yet. <a href="/admin/invoices/new" data-nav>Create the first one</a>.'}</div>`}
    <section class="section" id="unmatched"></section>`;

  const form = $('#filters');
  const apply = () => {
    const fd = new FormData(form);
    const next = new URLSearchParams([...fd].filter(([, v]) => v));
    if (params.get('ignored') === '1') next.set('ignored', '1');
    history.replaceState(null, '', `/admin/invoices${next.toString() ? `?${next}` : ''}`);
    listPage();
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  form.querySelectorAll('select').forEach((s) => s.addEventListener('change', apply));
  let t;
  form.q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(apply, 350); });
  if (q) { form.q.focus(); form.q.setSelectionRange(q.length, q.length); }
  $('#clear').addEventListener('click', () => go('/admin/invoices', true));
  $$('tr.click').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    go(`/admin/invoices/${tr.dataset.id}`);
  }));

  renderUnmatched(unmatched, params.get('ignored') === '1');
  if (location.hash === '#unmatched') $('#unmatched').scrollIntoView();
}

function renderUnmatched({ payments, open_lines }, showIgnored) {
  const box = $('#unmatched');
  const option = (l) => `<option value="${l.id}">${esc(l.ref)} · ${esc(l.client_name)} · ${money(l.amount_cents - l.paid_cents, l.currency)} due ${esc(l.due_date ? niceDate(l.due_date) : 'on completion')}</option>`;
  const rows = payments.map((p) => {
    const lines = open_lines.filter((l) => l.currency === p.currency);
    const hint = [p.invoice_ref_entered && `Entered: ${p.invoice_ref_entered}`, p.description].filter(Boolean).join(' · ');
    return `
      <tr data-pid="${p.id}">
        <td data-label="Received">${esc(niceDate(p.received_at))}</td>
        <td data-label="From"><div>${esc(p.payer_name || p.payer_email || '—')}${p.payer_name && p.payer_email ? `<div class="muted small">${esc(p.payer_email)}</div>` : ''}</div></td>
        <td data-label="Amount" class="num">${money(p.amount_cents, p.currency)}</td>
        <td data-label="Details" class="full">${hint ? esc(hint) : '<span class="muted">No invoice number</span>'}<div class="mono muted">${esc(p.stripe_object_id || '')}</div></td>
        <td data-label="Assign" class="full">${p.ignored_at
          ? `<span class="muted small">Ignored${p.note ? `: ${esc(p.note)}` : ''}</span> <button class="btn btn-quiet btn-sm" data-act="restore">Restore</button>`
          : `<div class="row">
              <select data-line aria-label="Payment line for this payment"><option value="">${lines.length ? 'Choose a payment line…' : `No open ${esc(p.currency)} invoices`}</option>${lines.map(option).join('')}</select>
              <button class="btn btn-sm" data-act="assign">Assign</button>
              <button class="btn btn-quiet btn-sm" data-act="ignore">Ignore</button>
            </div>`}</td>
      </tr>`;
  }).join('');

  box.innerHTML = `
    <div class="head">
      <div><h2>Unmatched payments</h2><p class="muted small">Stripe payments that couldn't be matched to an invoice automatically. Assign each one to a payment line, or ignore it if it isn't for an invoice.</p></div>
      <label class="check small"><input type="checkbox" id="show-ignored"${showIgnored ? ' checked' : ''}> Show ignored</label>
    </div>
    ${payments.length ? `
      <table class="tbl">
        <thead><tr><th>Received</th><th>From</th><th class="num">Amount</th><th>Details</th><th>Assign to</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty">Nothing to match. Every payment is assigned.</div>'}`;

  $('#show-ignored').addEventListener('change', (e) => {
    const next = new URLSearchParams(location.search);
    if (e.target.checked) next.set('ignored', '1'); else next.delete('ignored');
    history.replaceState(null, '', `/admin/invoices${next.toString() ? `?${next}` : ''}`);
    listPage();
  });
  $$('tr[data-pid]', box).forEach((tr) => tr.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const pid = tr.dataset.pid;
    const act = btn.dataset.act;
    if (act === 'assign') {
      const lineId = $('select[data-line]', tr).value;
      if (!lineId) return toast('Choose a payment line first.', true);
      const out = await busy(btn, () => api(`payments/${pid}/assign`, { method: 'POST', body: { line_id: Number(lineId) } }));
      if (out) { toast(`Assigned to ${out.line}`); listPage(); }
    } else if (act === 'ignore') {
      const note = prompt('Why ignore this payment? (optional)', 'Not for an invoice');
      if (note === null) return;
      if (await busy(btn, () => api(`payments/${pid}/ignore`, { method: 'POST', body: { note } }))) { toast('Payment ignored'); listPage(); }
    } else if (act === 'restore') {
      if (await busy(btn, () => api(`payments/${pid}/restore`, { method: 'POST', body: {} }))) { toast('Payment restored'); listPage(); }
    }
  }));
}

// ---------- new / edit invoice ----------

async function formPage(id) {
  const inv = id ? await api(`invoices/${id}`) : null;
  const params = new URLSearchParams(location.search);
  // "Duplicate" starts a new invoice from an old one; "New invoice" on a client page starts from the client.
  const dup = !inv && params.get('from') ? await api(`invoices/${encodeURIComponent(params.get('from'))}`) : null;
  const fromClient = !inv && !dup && params.get('client') ? await api(`clients/${encodeURIComponent(params.get('client'))}`) : null;
  const pre = inv || dup || (fromClient ? { client_name: fromClient.name, client_email: fromClient.email, client_address: fromClient.address } : null);
  // A duplicate keeps the gap between issue date and each due date.
  const shift = dup ? daysFrom(dup.issue_date, config.today) : 0;
  const { clients: clientNames } = await api('clients');
  const newId = inv ? null : (await api('next-id')).id;
  const invNo = inv?.id || newId;
  if (inv?.voided_at) throw new Error('A void invoice can’t be edited.');
  const full = !inv || (!inv.sent_date && !inv.paid_cents && !inv.stripe_link_id);
  document.title = `${inv ? `Edit ${inv.id}` : 'New invoice'} | Painkiller Labs admin`;

  const state = {
    items: pre?.line_items?.length ? pre.line_items.map((i) => ({ ...i })) : [],
    // Editing keeps the saved payments (custom amounts, labels, blank dates) until a schedule field changes.
    linesEdited: !!(inv || dup),
    lines: inv || dup ? (inv || dup).lines.map((l) => ({
      amount_cents: l.amount_cents, label: l.label || '',
      due_date: (dup ? l.due_date && addDaysTo(l.due_date, shift) : l.due_date) || '',
    })) : [],
  };
  const lockedNote = inv && !full
    ? `<div class="notice warn">This invoice has been ${inv.sent_date ? 'sent' : ''}${inv.sent_date && (inv.paid_cents || inv.stripe_link_id) ? ' or ' : ''}${inv.paid_cents ? 'paid' : inv.stripe_link_id ? 'given a Stripe link' : ''}, so only the client, description and notes can change. To change amounts, void it and create a new one.</div>`
    : '';

  app.innerHTML = `
    <a class="back" href="${inv ? `/admin/invoices/${inv.id}` : '/admin/invoices'}" data-nav>← ${inv ? inv.id : 'Invoices'}</a>
    <div class="head"><div><h1>${inv ? 'Edit invoice' : 'New invoice'}</h1><p class="muted">Invoice number <span class="mono">${esc(invNo)}</span></p></div></div>
    ${lockedNote}
    ${dup ? `<div class="notice">Copied from invoice <a class="mono" href="/admin/invoices/${esc(dup.id)}" data-nav>${esc(dup.id)}</a>. Due dates have moved forward by the same number of days. Check the dates and amounts before you create it.</div>` : ''}
    <form id="inv" class="panel stack" novalidate>
      <div class="grid2">
        <label>Client name <input name="client_name" required value="${esc(pre?.client_name)}" autocomplete="off" list="client-list">
          <span class="muted small" id="client-hint"></span></label>
        <label>Client email <input name="client_email" type="email" value="${esc(pre?.client_email)}" autocomplete="off"></label>
      </div>
      <datalist id="client-list">${clientNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <label>Billing address <span class="muted small">(optional, shown on the invoice)</span><textarea name="client_address" rows="2">${esc(pre?.client_address)}</textarea></label>
      <label>Description of the work <textarea name="description" rows="3">${esc(pre?.description)}</textarea></label>
      <fieldset class="plain"${full ? '' : ' disabled hidden'}>
        <div class="subpanel stack">
          <div class="head"><h2>Amount</h2><button class="btn btn-quiet btn-sm" type="button" id="add-item">Add line item</button></div>
          <div id="items"></div>
          <div class="grid3">
            <label id="subtotal-wrap">Subtotal (before tax) <input name="subtotal" inputmode="decimal" value="${pre?.subtotal_cents ? centsToInput(pre.subtotal_cents) : ''}" placeholder="0.00"></label>
            <label>Currency <input name="currency" value="${esc(pre?.currency || 'CAD')}" maxlength="3"></label>
            <label>Issue date <input name="issue_date" type="date" value="${esc(inv?.issue_date || config.today)}"></label>
          </div>
          <label class="check"><input type="checkbox" name="hst_enabled"${!pre || pre.hst_enabled !== 0 ? ' checked' : ''}> Charge HST at 13%</label>
          <div class="totals" id="totals"></div>
        </div>
        <div class="subpanel stack">
          <h2>Payment schedule</h2>
          <div class="grid3">
            <label>Schedule <select name="schedule">${Object.entries(SCHEDULE_LABEL).map(([k, v]) => `<option value="${k}"${(pre?.schedule || 'one_time') === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
            <label id="count-wrap">Number of payments <input name="count" type="number" min="1" max="120" value="${pre?.lines && pre.schedule !== 'one_time' ? pre.lines.length : 12}"></label>
            <label><span id="first-due-label">First payment due</span> <input name="first_due" type="date" value="${esc(state.lines[0]?.due_date || config.today)}"></label>
          </div>
          <div id="lines"></div>
        </div>
      </fieldset>
      <label>Notes <span class="muted small">(private, not shown to the client)</span><textarea name="notes" rows="2">${esc(pre?.notes)}</textarea></label>
      ${!inv ? `<label class="check" id="sub-wrap"><input type="checkbox" name="create_stripe_link"${config.stripe ? '' : ' disabled'}> Also set up automatic card payments (a Stripe subscription that charges each payment on schedule)${config.stripe ? '' : ' <span class="muted small">(Stripe isn’t connected)</span>'}</label>` : ''}
      <p class="muted small">The client pays from their invoice page, with a Pay button for each payment. You can email it once the invoice is created.</p>
      <div id="form-error"></div>
      <div class="actions"><button class="btn" type="submit">${inv ? 'Save changes' : 'Create invoice'}</button>
        <a class="btn btn-quiet" href="${inv ? `/admin/invoices/${inv.id}` : '/admin/invoices'}" data-nav>Cancel</a></div>
    </form>`;

  const f = $('#inv');

  // Picking a saved client fills in their email and address if those are empty.
  async function clientLookup() {
    const name = f.client_name.value.trim();
    const hint = $('#client-hint');
    if (!name) { hint.textContent = ''; return; }
    const { client } = await api(`clients/lookup?name=${encodeURIComponent(name)}`).catch(() => ({ client: null }));
    if (f.client_name.value.trim() !== name) return;
    if (client) {
      if (!f.client_email.value && client.email) f.client_email.value = client.email;
      if (!f.client_address.value && client.address) f.client_address.value = client.address;
      hint.textContent = client.name === name ? 'Saved client' : `Saved client: ${client.name}`;
    } else {
      hint.textContent = 'New client. They’ll be saved when you create the invoice.';
    }
  }
  f.client_name.addEventListener('change', clientLookup);
  if (pre?.client_name) clientLookup();

  function totals() {
    const items = state.items.filter((i) => i.description || i.amount_cents);
    const subtotal = items.length ? items.reduce((a, i) => a + (i.amount_cents || 0), 0) : parseMoney(f.subtotal.value);
    const hst = f.hst_enabled.checked && subtotal ? Math.round(subtotal * 0.13) : 0;
    return { items, subtotal, hst, total: subtotal == null ? null : subtotal + hst };
  }

  function renderItems() {
    $('#items').innerHTML = state.items.length
      ? `<p class="muted small">Line items add up to the subtotal.</p>` + state.items.map((it, i) => `
        <div class="items-row" data-i="${i}">
          <input aria-label="Line item ${i + 1} description" data-k="description" value="${esc(it.description)}" placeholder="What it's for">
          <input aria-label="Line item ${i + 1} amount" data-k="amount" inputmode="decimal" value="${it.amount_cents ? centsToInput(it.amount_cents) : ''}" placeholder="0.00">
          <button type="button" class="x" aria-label="Remove line item ${i + 1}">×</button>
        </div>`).join('')
      : '';
    $('#subtotal-wrap').hidden = state.items.length > 0;
  }

  function renderTotals() {
    const t = totals();
    const cur = (f.currency.value || 'CAD').toUpperCase();
    const ok = /^[A-Z]{3}$/.test(cur) ? cur : 'CAD';
    $('#totals').innerHTML = t.total == null ? '<div class="muted">Enter an amount like 1500 or 1500.00</div>' : `
      <div><span>Subtotal</span><span>${money(t.subtotal, ok)}</span></div>
      <div><span>HST 13%</span><span>${money(t.hst, ok)}</span></div>
      <div class="grand"><span>Total</span><span>${money(t.total, ok)}</span></div>`;
  }

  function renderLines() {
    const t = totals();
    const schedule = f.schedule.value;
    const split = schedule === 'split';
    $('#count-wrap').hidden = schedule === 'one_time';
    $('#first-due-label').textContent = split ? 'Deposit due' : schedule === 'one_time' ? 'Payment due' : 'First payment due';
    if ($('#sub-wrap')) $('#sub-wrap').hidden = !['monthly', 'annual'].includes(schedule);
    const cur = /^[A-Z]{3}$/.test(f.currency.value.toUpperCase()) ? f.currency.value.toUpperCase() : 'CAD';
    if (!state.linesEdited) state.lines = buildSchedule(t.total || 0, schedule, f.count.value, f.first_due.value || config.today);
    const sum = state.lines.reduce((a, l) => a + (l.amount_cents ?? 0), 0);
    const ref = invNo;
    $('#lines').innerHTML = `
      <table class="tbl">
        <thead><tr><th>Payment number</th>${split ? '<th>Label</th>' : ''}<th>Due date</th><th class="num">Amount</th></tr></thead>
        <tbody>${state.lines.map((l, i) => `
          <tr data-i="${i}">
            <td data-label="Payment number" class="mono">${esc(ref)}-${String(i + 1).padStart(2, '0')}</td>
            ${split ? `<td data-label="Label"><input data-k="label" value="${esc(l.label)}" maxlength="60" placeholder="e.g. Deposit" aria-label="Payment ${i + 1} label"></td>` : ''}
            <td data-label="Due date"><input type="date" data-k="due_date" value="${esc(l.due_date)}" aria-label="Payment ${i + 1} due date">${split && !l.due_date ? '<div class="muted small">On completion</div>' : ''}</td>
            <td data-label="Amount" class="num"><input data-k="amount" inputmode="decimal" value="${l.amount_cents == null ? '' : centsToInput(l.amount_cents)}" aria-label="Payment ${i + 1} amount"></td>
          </tr>`).join('')}</tbody>
      </table>
      ${state.linesEdited ? `<p class="small ${sum === t.total ? 'muted' : ''}">${sum === t.total ? 'Payments add up to the total.' : `<strong>Payments add up to ${money(sum, cur)}, but the total is ${money(t.total || 0, cur)}.</strong>`} <button type="button" class="link-btn small" id="reset-lines">Split evenly again</button></p>`
        : schedule === 'one_time' ? `<p class="muted small">The client pays this as payment number ${esc(ref)}-01.</p>`
        : `<p class="muted small">Split evenly; any odd cents go on the first payment. Each payment number is the invoice number plus -01, -02 and so on. You can change amounts and dates.${split ? ' Leave a date blank for “due on completion”; you can set it later from the invoice page.' : ''}</p>`}`;
  }

  const refresh = () => { renderTotals(); renderLines(); };

  if (full) {
    renderItems(); refresh();
    $('#add-item').addEventListener('click', () => {
      if (!state.items.length && parseMoney(f.subtotal.value)) state.items.push({ description: '', amount_cents: parseMoney(f.subtotal.value) });
      state.items.push({ description: '', amount_cents: 0 });
      renderItems(); refresh();
      $$('#items input[data-k="description"]').at(-1).focus();
    });
    $('#items').addEventListener('input', (e) => {
      const row = e.target.closest('[data-i]');
      const it = state.items[row.dataset.i];
      if (e.target.dataset.k === 'description') it.description = e.target.value;
      else it.amount_cents = parseMoney(e.target.value) ?? 0;
      refresh();
    });
    $('#items').addEventListener('click', (e) => {
      if (!e.target.closest('.x')) return;
      state.items.splice(e.target.closest('[data-i]').dataset.i, 1);
      renderItems(); refresh();
    });
    for (const name of ['subtotal', 'currency', 'hst_enabled', 'schedule', 'count', 'first_due']) {
      f[name].addEventListener(name === 'hst_enabled' || name === 'schedule' ? 'change' : 'input', () => {
        if (['schedule', 'count', 'first_due'].includes(name)) state.linesEdited = false;
        refresh();
      });
    }
    $('#lines').addEventListener('change', (e) => {
      const row = e.target.closest('tr[data-i]');
      if (!row) return;
      const l = state.lines[row.dataset.i];
      if (e.target.dataset.k === 'due_date') l.due_date = e.target.value;
      else if (e.target.dataset.k === 'label') l.label = e.target.value;
      else l.amount_cents = parseMoney(e.target.value);
      state.linesEdited = true;
      renderLines();
    });
    $('#lines').addEventListener('click', (e) => {
      if (e.target.id === 'reset-lines') { state.linesEdited = false; renderLines(); }
    });
  }

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = (m) => { $('#form-error').innerHTML = `<div class="notice bad">${esc(m)}</div>`; };
    $('#form-error').innerHTML = '';
    if (!f.client_name.value.trim()) return err('Client name is required.');
    const body = {
      client_name: f.client_name.value, client_email: f.client_email.value, client_address: f.client_address.value,
      description: f.description.value, notes: f.notes.value,
    };
    if (full) {
      const t = totals();
      if (t.total == null || state.items.some((i) => i.amount_cents == null)) return err('Check the amounts: use numbers like 1500 or 1500.00.');
      if (!t.total) return err('Enter an amount.');
      if (state.lines.some((l) => !l.amount_cents)) return err('Every payment needs an amount.');
      if (f.schedule.value !== 'split' && state.lines.some((l) => !l.due_date)) return err('Every payment needs a due date.');
      Object.assign(body, {
        line_items: t.items, subtotal_cents: t.subtotal, hst_enabled: f.hst_enabled.checked,
        currency: f.currency.value.toUpperCase(), issue_date: f.issue_date.value, schedule: f.schedule.value,
        lines: state.lines.map((l) => ({ ...l, due_date: l.due_date || null })),
      });
      if (!inv) body.id = newId;
      if (!inv) body.create_stripe_link = ['monthly', 'annual'].includes(f.schedule.value) && !!f.create_stripe_link?.checked;
    }
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      if (inv) {
        const out = await api(`invoices/${inv.id}/edit`, { method: 'POST', body });
        toast(out.changed.length ? 'Saved' : 'No changes');
        go(`/admin/invoices/${inv.id}`, true);
      } else {
        const out = await api('invoices', { method: 'POST', body });
        toast(out.id === newId ? `Invoice ${out.id} created` : `Invoice ${out.id} created (${newId} was taken, so it got a new number)`);
        if (out.link_error) setTimeout(() => toast(`Invoice created, but the Stripe link failed: ${out.link_error}`, true), 400);
        go(`/admin/invoices/${out.id}`, true);
      }
    } catch (ex) {
      err(ex.message);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- invoice detail ----------

const ACTION_LABEL = {
  create: 'Created', edit: 'Edited', send: 'Marked as sent', void: 'Voided', stripe_link: 'Stripe payment link created',
  stripe_link_failed: 'Stripe payment link failed', subscription_end: 'Stripe subscription set to end',
  subscription_end_failed: 'Could not end the Stripe subscription', receive: 'Payment received from Stripe',
  match: 'Payment matched', unmatch: 'Payment unassigned', ignore: 'Payment ignored', restore: 'Payment restored',
  record_manual: 'Manual payment recorded', due_date: 'Due date changed', refund: 'Refunded in Stripe',
  dispute: 'Card dispute', checkout_failed: 'Client checkout failed',
  reminder: 'Reminder emailed', reminder_failed: 'Reminder failed to send',
  reminders_on: 'Automatic reminders turned on', reminders_off: 'Automatic reminders turned off',
};
const REMINDER_KIND = { before: '3 days before due', late1: '1 day overdue', late7: '7 days overdue', late21: '21 days overdue', manual: 'Sent by hand' };
const DISPUTE_LABEL = { warning_needs_response: 'inquiry, needs a response', warning_under_review: 'inquiry under review', warning_closed: 'inquiry closed',
  needs_response: 'needs a response', under_review: 'under review', won: 'won, money kept', lost: 'lost, money returned', prevented: 'prevented' };

function describe(h, currency) {
  const d = h.detail || {};
  const bits = [];
  if (d.line) bits.push(d.line);
  if (d.amount_cents != null) bits.push(money(d.amount_cents, d.currency || currency));
  if (d.method) bits.push(d.method);
  if (d.sent_via) bits.push(`${VIA_LABEL[d.sent_via] || d.sent_via}${d.sent_to ? ` to ${d.sent_to}` : ''}, ${niceDate(d.sent_date)}`);
  if (h.action === 'due_date') bits.push(`${dueText(d.from)} → ${dueText(d.to)}`);
  if (d.status) bits.push(DISPUTE_LABEL[d.status] || d.status);
  if (d.reason) bits.push(d.reason);
  if (d.note) bits.push(d.note);
  if (d.kind) bits.push(REMINDER_KIND[d.kind] || d.kind);
  if (d.sent_to && !d.sent_via) bits.push(`to ${d.sent_to}`);
  if (d.error) bits.push(d.error);
  if (h.action === 'edit') bits.push(`Changed: ${Object.keys(d).join(', ').replaceAll('_cents', '').replaceAll('_', ' ')}`);
  return bits.join(' · ');
}

async function detailPage(id) {
  const inv = await api(`invoices/${id}`);
  document.title = `${inv.id} | Painkiller Labs admin`;
  const cur = inv.currency;
  const isVoid = !!inv.voided_at;
  const nextDue = inv.lines.find((l) => l.outstanding_cents > 0);
  const openLines = inv.lines.filter((l) => l.outstanding_cents > 0);
  const clientLink = `${config.public_url || location.origin}/invoice/${inv.public_token}`;

  const lineRows = inv.lines.map((l) => {
    const pays = l.payments.filter((p) => !p.ignored_at);
    return `
      <tr>
        <td data-label="Payment number"><span><span class="mono">${esc(l.ref)}</span>${l.label ? `<div class="muted small">${esc(l.label)}</div>` : ''}</span></td>
        <td data-label="Due"><span>${esc(dueText(l.due_date))}${!isVoid && l.outstanding_cents && l.due_date && l.due_date < config.today ? ' <span class="badge Overdue">Overdue</span>' : ''}${!isVoid && l.outstanding_cents ? ` <button class="link-btn small" data-due="${l.suffix}">${l.due_date ? 'Change' : 'Set date'}</button>` : ''}</span></td>
        <td data-label="Amount" class="num">${money(l.amount_cents, cur)}</td>
        <td data-label="Paid" class="num">${l.paid_cents ? money(l.paid_cents, cur) : '<span class="muted">—</span>'}</td>
        <td data-label="Paid on">${l.paid_at ? esc(niceDate(l.paid_at)) : '<span class="muted">—</span>'}</td>
        <td data-label="Payment ID" class="full">${pays.length ? pays.map((p) => `
          <div>${p.source === 'stripe'
            ? `<span class="mono">${esc(p.stripe_object_id)}</span>`
            : `<span>${esc(p.method)}${p.note ? ` · ${esc(p.note)}` : ''}</span>`}
            ${p.refunded_cents ? `<span class="badge Overdue">${p.refunded_cents >= p.amount_cents ? 'Refunded' : `Refunded ${money(p.refunded_cents, cur)}`}</span>` : ''}
            ${p.dispute_status ? `<span class="badge ${p.dispute_cents ? 'Overdue' : 'Paid'}">Dispute: ${esc(DISPUTE_LABEL[p.dispute_status] || p.dispute_status)}</span>` : ''}
            ${pays.length > 1 ? `<span class="muted small">${money(p.amount_cents, cur)}</span>` : ''}
            ${p.source === 'stripe' && !isVoid ? `<button class="link-btn small" data-unassign="${p.id}">Unassign</button>` : ''}
            ${p.source === 'manual' && !isVoid ? `<button class="link-btn small" data-ignore="${p.id}">Remove</button>` : ''}
          </div>`).join('') : '<span class="muted">—</span>'}</td>
      </tr>`;
  }).join('');

  const items = inv.line_items.length ? `
    <table class="tbl section">
      <thead><tr><th>Line item</th><th class="num">Amount</th></tr></thead>
      <tbody>${inv.line_items.map((i) => `<tr><td data-label="Item">${esc(i.description)}</td><td data-label="Amount" class="num">${money(i.amount_cents, cur)}</td></tr>`).join('')}</tbody>
    </table>` : '';

  app.innerHTML = `
    <a class="back" href="/admin/invoices" data-nav>← Invoices</a>
    <div class="head">
      <div><h1>Invoice <span class="mono-h">${esc(inv.id)}</span> ${badge(inv.status)}</h1><p class="muted">${inv.client_id ? `<a href="/admin/clients/${inv.client_id}" data-nav>${esc(inv.client_name)}</a>` : esc(inv.client_name)}${inv.client_email ? ` · ${esc(inv.client_email)}` : ''}</p></div>
    </div>
    ${isVoid ? `<div class="notice bad">Voided ${esc(niceDateTime(inv.voided_at))}${inv.void_reason ? `: ${esc(inv.void_reason)}` : ''}. The record is kept.</div>` : ''}
    <dl class="summary">
      <div><dt>Total</dt><dd>${money(inv.total_cents, cur)}</dd></div>
      <div><dt>Paid</dt><dd>${money(inv.paid_cents, cur)}</dd></div>
      <div><dt>Outstanding</dt><dd>${money(inv.outstanding_cents, cur)}</dd></div>
      <div><dt>Next due</dt><dd>${!isVoid && nextDue ? `${esc(niceDate(nextDue.due_date))}` : '—'}</dd></div>
    </dl>
    ${isVoid ? '' : `
    <div class="actions">
      <button class="btn" data-panel="send">${inv.sent_date ? 'Update sent details' : 'Mark as sent'}</button>
      <button class="btn btn-quiet" data-panel="pay"${openLines.length ? '' : ' disabled'}>Record a manual payment</button>
      ${!inv.stripe_link_url && config.stripe && ['monthly', 'annual'].includes(inv.schedule) ? '<button class="btn btn-quiet" id="make-link">Set up automatic payments</button>' : ''}
      <a class="btn btn-quiet" href="/admin/invoices/${esc(inv.id)}/edit" data-nav>Edit</a>
      <a class="btn btn-quiet" href="/admin/invoices/new?from=${esc(inv.id)}" data-nav>Duplicate</a>
      <button class="btn btn-danger" data-panel="void">Void</button>
    </div>
    <div id="panel"></div>`}
    ${isVoid ? `<div class="actions"><a class="btn btn-quiet" href="/admin/invoices/new?from=${esc(inv.id)}" data-nav>Duplicate as a new invoice</a></div>` : ''}
    ${isVoid ? '' : `
      <div class="panel">
        <h2>Client invoice</h2>
        <p class="muted small">The client's copy of invoice ${esc(inv.id)}. They can view it, print it or save it as a PDF, and pay each payment by card. Payments made there are matched automatically.</p>
        ${config.hst_number ? '' : '<div class="notice warn small">Your HST number isn’t on invoices yet. Set HST_NUMBER on the ledger service in Railway; invoices that charge HST must show it.</div>'}
        <div class="linkbox"><input readonly value="${esc(clientLink)}" aria-label="Client invoice link"><button class="btn btn-quiet btn-sm" id="copy-client" data-ro>Copy</button><a class="btn btn-quiet btn-sm" href="${esc(clientLink)}" target="_blank" rel="noopener">Open</a><button class="btn btn-sm" data-panel="email">Email to client</button></div>
      </div>`}
    ${isVoid ? '' : remindersPanel(inv, openLines)}
    ${inv.stripe_link_url ? `
      <div class="panel">
        <h2>Stripe payment link</h2>
        <p class="muted small">${inv.schedule === 'one_time' || inv.schedule === 'split' ? 'One payment' : `A ${inv.schedule === 'monthly' ? 'monthly' : 'yearly'} subscription for ${inv.lines.length} payments; it stops after the last one`}. Payments through this link are matched automatically.</p>
        <div class="linkbox"><input readonly value="${esc(inv.stripe_link_url)}" aria-label="Stripe payment link"><button class="btn btn-quiet btn-sm" id="copy-link" data-ro>Copy</button><a class="btn btn-quiet btn-sm" href="${esc(inv.stripe_link_url)}" target="_blank" rel="noopener">Open</a></div>
      </div>` : ''}
    <section class="section">
      <h2>Payments</h2>
      <table class="tbl section">
        <thead><tr><th>Payment number</th><th>Due</th><th class="num">Amount</th><th class="num">Paid</th><th>Paid on</th><th>Payment ID</th></tr></thead>
        <tbody>${lineRows}</tbody>
      </table>
    </section>
    <div class="panel">
      <h2>Details</h2>
      <dl class="kv">
        <dt>Issue date</dt><dd>${esc(niceDate(inv.issue_date))}</dd>
        <dt>Schedule</dt><dd>${esc(SCHEDULE_LABEL[inv.schedule] || inv.schedule)}${inv.schedule !== 'one_time' ? `, ${inv.lines.length} payments` : ''}</dd>
        <dt>Sent</dt><dd>${inv.sent_date ? `${esc(niceDate(inv.sent_date))} by ${esc(VIA_LABEL[inv.sent_via] || inv.sent_via)}${inv.sent_to ? ` to ${esc(inv.sent_to)}` : ''}` : '<span class="muted">Not sent</span>'}</dd>
        <dt>Subtotal</dt><dd>${money(inv.subtotal_cents, cur)}</dd>
        <dt>HST</dt><dd>${inv.hst_enabled ? `${money(inv.hst_cents, cur)} (13%)` : 'Not charged'}</dd>
        <dt>Total</dt><dd>${money(inv.total_cents, cur)} ${esc(cur)}</dd>
        <dt>Description</dt><dd class="pre">${inv.description ? esc(inv.description) : '<span class="muted">—</span>'}</dd>
        <dt>Notes</dt><dd class="pre">${inv.notes ? esc(inv.notes) : '<span class="muted">—</span>'}</dd>
      </dl>
      ${items}
    </div>
    <div class="panel">
      <h2>History</h2>
      <ul class="history">${inv.history.map((h) => `
        <li><div>${esc(ACTION_LABEL[h.action] || h.action)}${describe(h, cur) ? ` <span class="muted">· ${esc(describe(h, cur))}</span>` : ''}</div>
          <div class="when">${esc(niceDateTime(h.at))}${h.actor ? ` · ${esc(h.actor)}` : ''}</div></li>`).join('')}</ul>
    </div>`;

  const reload = () => detailPage(id);
  const panel = $('#panel');

  const panels = {
    send: () => `
      <form class="subpanel stack" data-form="send">
        <h2>${inv.sent_date ? 'Update sent details' : 'Mark as sent'}</h2>
        <div class="grid3">
          <label>Date sent <input type="date" name="sent_date" value="${esc(inv.sent_date || config.today)}"></label>
          <label>Sent to <input type="email" name="sent_to" value="${esc(inv.sent_to || inv.client_email)}"></label>
          <label>How <select name="sent_via">${Object.entries(VIA_LABEL).map(([k, v]) => `<option value="${k}"${(inv.sent_via || (inv.stripe_link_url ? 'stripe' : 'email')) === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        </div>
        <div class="actions"><button class="btn" type="submit">Save</button><button class="btn btn-quiet" type="button" data-close>Cancel</button></div>
      </form>`,
    pay: () => `
      <form class="subpanel stack" data-form="pay">
        <h2>Record a manual payment</h2>
        <p class="muted small">For e-transfers, cheques and cash. Stripe payments are recorded automatically.</p>
        <div class="grid2">
          <label>Payment line <select name="line_id">${openLines.map((l) => `<option value="${l.id}" data-out="${l.outstanding_cents}">${esc(l.ref)}${l.label ? ` ${esc(l.label)}` : ''} · ${money(l.outstanding_cents, cur)} due ${esc(l.due_date ? niceDate(l.due_date) : 'on completion')}</option>`).join('')}</select></label>
          <label>Amount <input name="amount" inputmode="decimal" value="${openLines[0] ? centsToInput(openLines[0].outstanding_cents) : ''}"></label>
          <label>Date received <input type="date" name="received_at" value="${esc(config.today)}"></label>
          <label>Method <select name="method"><option value="e-transfer">E-transfer</option><option value="cheque">Cheque</option><option value="cash">Cash</option><option value="other">Other</option></select></label>
        </div>
        <label>Note <input name="note" placeholder="Reference number, cheque number…"></label>
        <div class="actions"><button class="btn" type="submit">Record payment</button><button class="btn btn-quiet" type="button" data-close>Cancel</button></div>
      </form>`,
    email: () => `
      <form class="subpanel stack" data-form="email">
        <h2>Email invoice ${esc(inv.id)}</h2>
        <p class="muted small">Sends the client a link to their invoice, with the total and what's due first. Replies come to ${esc(config.admin_email || 'you')}. The invoice is marked as sent.${inv.sent_date ? ` It was last sent ${esc(niceDate(inv.sent_date))}.` : ''}</p>
        ${config.email ? '' : '<div class="notice bad small">Email isn’t set up on the server (RESEND_API_KEY), so this will fail. Copy the link instead.</div>'}
        <label>Send to <input type="email" name="to" required value="${esc(inv.client_email)}"></label>
        <div class="actions"><button class="btn" type="submit">Send email</button><button class="btn btn-quiet" type="button" data-close>Cancel</button></div>
      </form>`,
    due: (suffix) => {
      const l = inv.lines.find((x) => x.suffix === Number(suffix));
      return `
      <form class="subpanel stack" data-form="due" data-suffix="${l.suffix}">
        <h2>When is ${esc(l.ref)} due?</h2>
        <p class="muted small">${esc(l.label || `Payment ${l.suffix}`)} · ${money(l.outstanding_cents, cur)} to pay. The client's invoice shows the new date straight away.${inv.schedule === 'split' ? ' Leave it blank for “due on completion”.' : ''}</p>
        <label>Due date <input type="date" name="due_date" value="${esc(l.due_date || config.today)}"${inv.schedule === 'split' ? '' : ' required'}></label>
        <div class="actions"><button class="btn" type="submit">Save date</button><button class="btn btn-quiet" type="button" data-close>Cancel</button></div>
      </form>`;
    },
    remind: () => `
      <form class="subpanel stack" data-form="remind">
        <h2>Send a payment reminder</h2>
        <p class="muted small">Emails the client a short reminder with the amount, the due date and a link to pay. If the payment is late, it says so. Replies come to ${esc(config.admin_email || 'you')}.</p>
        ${config.email ? '' : '<div class="notice bad small">Email isn’t set up on the server (RESEND_API_KEY), so this will fail.</div>'}
        <div class="grid2">
          <label>Payment <select name="suffix">${openLines.map((l) => `<option value="${l.suffix}">${esc(l.ref)}${l.label ? ` ${esc(l.label)}` : ''} · ${money(l.outstanding_cents, cur)} due ${esc(dueText(l.due_date))}</option>`).join('')}</select></label>
          <label>Send to <input type="email" name="to" required value="${esc(inv.client_email)}"></label>
        </div>
        <div class="actions"><button class="btn" type="submit">Send reminder</button><button class="btn btn-quiet" type="button" data-close>Cancel</button></div>
      </form>`,
    void: () => `
      <form class="subpanel stack" data-form="void">
        <h2>Void invoice ${esc(inv.id)}</h2>
        <p class="muted small">The invoice stays in the ledger, marked Void, and can no longer be edited or paid.${inv.stripe_link_url ? ' Deactivate its payment link in the Stripe dashboard too.' : ''}</p>
        <label>Reason <input name="reason" required placeholder="e.g. Replaced by a new invoice"></label>
        <div class="actions"><button class="btn btn-danger" type="submit">Void invoice</button><button class="btn btn-quiet" type="button" data-close>Cancel</button></div>
      </form>`,
  };

  const openPanel = (html) => {
    panel.innerHTML = html;
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    panel.querySelector('input, select')?.focus();
  };
  $$('button[data-panel]').forEach((b) => b.addEventListener('click', () => openPanel(panels[b.dataset.panel]())));
  $$('button[data-due]').forEach((b) => b.addEventListener('click', () => openPanel(panels.due(b.dataset.due))));
  $('#copy-client')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(clientLink); toast('Invoice link copied'); } catch { $('#copy-client').previousElementSibling.select(); }
  });

  panel?.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) panel.innerHTML = ''; });
  panel?.addEventListener('change', (e) => {
    if (e.target.name === 'line_id') {
      const out = e.target.selectedOptions[0].dataset.out;
      e.target.form.amount.value = centsToInput(Number(out));
    }
  });
  panel?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    const kind = f.dataset.form;
    let ok;
    if (kind === 'send') {
      ok = await busy(btn, () => api(`invoices/${inv.id}/send`, { method: 'POST', body: { sent_date: f.sent_date.value, sent_to: f.sent_to.value, sent_via: f.sent_via.value } }));
      if (ok) toast('Marked as sent');
    } else if (kind === 'pay') {
      const amount = parseMoney(f.amount.value);
      if (!amount) return toast('Enter the amount received.', true);
      ok = await busy(btn, () => api(`invoices/${inv.id}/payments`, { method: 'POST', body: {
        line_id: Number(f.line_id.value), amount_cents: amount, received_at: f.received_at.value, method: f.method.value, note: f.note.value,
      } }));
      if (ok) toast('Payment recorded');
    } else if (kind === 'email') {
      const out = await busy(btn, () => api(`invoices/${inv.id}/email`, { method: 'POST', body: { to: f.to.value } }));
      ok = out;
      if (out) toast(`Invoice emailed to ${out.sent_to}`);
    } else if (kind === 'due') {
      ok = await busy(btn, () => api(`invoices/${inv.id}/lines/${f.dataset.suffix}/due`, { method: 'POST', body: { due_date: f.due_date.value || null } }));
      if (ok) toast('Due date saved');
    } else if (kind === 'remind') {
      const out = await busy(btn, () => api(`invoices/${inv.id}/remind`, { method: 'POST', body: { suffix: Number(f.suffix.value), to: f.to.value } }));
      ok = out;
      if (out) toast(`Reminder for ${out.ref} sent to ${out.sent_to}`);
    } else if (kind === 'void') {
      if (!f.reason.value.trim()) return toast('Give a reason for voiding.', true);
      ok = await busy(btn, () => api(`invoices/${inv.id}/void`, { method: 'POST', body: { reason: f.reason.value } }));
      if (ok) toast(`Invoice ${inv.id} voided`);
    }
    if (ok) reload();
  });

  $('#toggle-reminders')?.addEventListener('click', async (e) => {
    const on = !!inv.reminders_off;
    if (await busy(e.target, () => api(`invoices/${inv.id}/reminders`, { method: 'POST', body: { on } }))) { toast(on ? 'Reminders on for this invoice' : 'Reminders off for this invoice'); reload(); }
  });
  $('#make-link')?.addEventListener('click', async (e) => {
    if (await busy(e.target, () => api(`invoices/${inv.id}/stripe-link`, { method: 'POST', body: {} }))) { toast('Stripe link created'); reload(); }
  });
  $('#copy-link')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inv.stripe_link_url); toast('Link copied'); } catch { $('.linkbox input').select(); }
  });
  $$('[data-unassign]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Unassign this Stripe payment? It goes back to the unmatched list.')) return;
    if (await busy(b, () => api(`payments/${b.dataset.unassign}/unassign`, { method: 'POST', body: {} }))) { toast('Payment unassigned'); reload(); }
  }));
  $$('[data-ignore]').forEach((b) => b.addEventListener('click', async () => {
    const note = prompt('Why remove this payment? It stays in the history.', 'Recorded by mistake');
    if (note === null) return;
    if (await busy(b, () => api(`payments/${b.dataset.ignore}/ignore`, { method: 'POST', body: { note } }))) { toast('Payment removed'); reload(); }
  }));
}

// ---------- shared bits for dashboard and reports ----------

// { CAD: 1200, USD: 300 } -> "$12.00 + US$3.00". Empty or all-zero -> "$0.00".
function totalsText(t) {
  const parts = Object.entries(t || {}).filter(([, v]) => v);
  return parts.length ? parts.map(([c, v]) => money(v, c)).join(' + ') : money(0);
}
const totalCents = (t) => Object.values(t || {}).reduce((a, v) => a + v, 0);
const monthName = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', timeZone: 'UTC' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lateText = (d) => (d === 1 ? '1 day' : `${d} days`);
const AGE_LABEL = { current: 'Not late yet', d1_30: '1–30 days late', d31_60: '31–60 days late', d61_plus: 'More than 60 days late' };
const AGE_SHORT = { current: 'Not late', d1_30: '1–30 days', d31_60: '31–60 days', d61_plus: '61+ days' };
const AGE_KEYS = Object.keys(AGE_LABEL);

function printHead(title, sub) {
  return `<div class="print-head"><div><strong>Painkiller Labs Inc.</strong> · ${esc(title)}</div><div>${esc(sub)} · Printed ${esc(niceDate(config.today))}</div></div>`;
}

// ---------- dashboard ----------

const SETUP_TEXT = {
  webhook_events: {
    title: 'Send refunds and disputes to the ledger',
    body: 'In Stripe, open Developers → Webhooks → the painkiller-labs.com/api/stripe/webhook endpoint and add these events: charge.refunded, charge.dispute.created, charge.dispute.updated and charge.dispute.closed. Until then, a refunded payment still shows as paid.',
  },
  checkout: {
    title: 'Let the Pay buttons create Stripe checkouts',
    body: 'In Stripe, open Developers → API keys, edit the restricted key the ledger uses, and set Checkout Sessions, Prices and Payment Links to Write. This ticks itself off once the key can reach Checkout.',
  },
  bank_read: {
    title: 'Let the ledger read your Stripe deposits',
    body: 'On the same restricted key, set Balance, Payouts and Charges to Read. The Bank page then breaks each Stripe deposit into the payments and fees inside it. This ticks itself off once the key can read them.',
  },
  hst_number: {
    title: 'Add your HST number',
    body: 'Once you have it, send it to Claude or set HST_NUMBER on the ledger service in Railway. Invoices that charge HST must show it.',
  },
};

function setupPanel(setup) {
  const todo = setup.filter((s) => !s.done);
  if (!todo.length) return '';
  return `
    <section class="panel setup noprint">
      <h2>Finish setting up <span class="muted small">${plural(todo.length, 'thing')} left</span></h2>
      <ol class="setup-list">${todo.map((s) => `
        <li><div><strong>${esc(SETUP_TEXT[s.key].title)}</strong><p class="muted small">${esc(SETUP_TEXT[s.key].body)}</p></div>
          ${s.manual ? `<button class="btn btn-quiet btn-sm" data-setup="${s.key}">Mark done</button>` : ''}</li>`).join('')}</ol>
    </section>`;
}

function tile(label, value, sub, href) {
  const inner = `<div class="tile-label">${esc(label)}</div><div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}`;
  return href ? `<a class="tile" href="${href}" data-nav>${inner}</a>` : `<div class="tile">${inner}</div>`;
}

function meterList(aging) {
  const total = AGE_KEYS.reduce((a, k) => a + totalCents(aging[k]), 0);
  return `<ul class="meters">${AGE_KEYS.map((k) => {
    const v = totalCents(aging[k]);
    const pct = total ? Math.round((v / total) * 1000) / 10 : 0;
    return `<li class="meter m-${k}" title="${esc(AGE_LABEL[k])}: ${esc(totalsText(aging[k]))}${total ? ` (${pct}%)` : ''}">
      <span class="meter-name">${esc(AGE_LABEL[k])}</span>
      <span class="meter-track" aria-hidden="true"><span class="meter-fill" data-pct="${pct}"></span></span>
      <span class="meter-value">${esc(totalsText(aging[k]))}</span></li>`;
  }).join('')}</ul>`;
}

function itemRows(items, cols) {
  return items.map((l) => `
    <tr class="click" data-href="/admin/invoices/${esc(l.invoice_id)}">
      <td data-label="Payment"><span><a class="id" href="/admin/invoices/${esc(l.invoice_id)}" data-nav>${esc(l.ref)}</a>${l.label ? `<div class="muted small">${esc(l.label)}</div>` : ''}</span></td>
      <td data-label="Client">${esc(l.client_name)}</td>
      ${cols.includes('late') ? `<td data-label="Late"><span class="badge Overdue">${lateText(l.days_late)}</span></td>` : ''}
      ${cols.includes('due') ? `<td data-label="Due">${esc(l.due_date ? niceDate(l.due_date) : 'On completion')}</td>` : ''}
      <td data-label="Amount" class="num">${money(l.outstanding_cents, l.currency)}</td>
    </tr>`).join('');
}

function clickableRows(root) {
  $$('tr.click[data-href]', root).forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('a,button')) return;
    go(tr.dataset.href);
  }));
}

async function dashboardPage() {
  const d = await api('dashboard');
  document.title = 'Dashboard | Painkiller Labs admin';
  const overdueClients = new Set(d.overdue_items.map((l) => l.client_name)).size;
  const openInvoices = d.clients.reduce((a, c) => a + c.invoices, 0);
  const thisMonth = totalCents(d.received_this_month);
  const lastMonth = totalCents(d.received_last_month);
  const delta = thisMonth - lastMonth;
  const deltaText = lastMonth || thisMonth
    ? `<span class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : '−'}${money(Math.abs(delta))}</span> vs ${esc(monthName(d.last_month))}`
    : `Nothing yet in ${esc(monthName(d.last_month))} either`;

  app.innerHTML = `
    <div class="head">
      <h1>Dashboard</h1>
      <div class="actions"><a class="btn btn-quiet" href="/admin/reports" data-nav data-ro>Reports</a><a class="btn" href="/admin/invoices/new" data-nav>New invoice</a></div>
    </div>
    ${setupPanel(d.setup)}
    <section class="hero-row${d.setup.some((s) => !s.done) ? ' section' : ''}">
      <div class="hero">
        <div class="tile-label">Owed to you</div>
        <div class="hero-num">${esc(totalsText(d.owed))}</div>
        <div class="tile-sub">${openInvoices ? `${plural(openInvoices, 'open invoice')}${totalCents(d.unsent) ? ` · ${esc(totalsText(d.unsent))} not sent yet` : ''}${totalCents(d.on_completion) ? ` · ${esc(totalsText(d.on_completion))} due on completion` : ''}` : 'Nobody owes you anything right now.'}</div>
      </div>
      <div class="kpis">
        ${tile('Overdue', esc(totalsText(d.overdue)), d.overdue_items.length ? `${plural(d.overdue_items.length, 'payment')} from ${plural(overdueClients, 'client')}` : 'Nothing overdue', null)}
        ${tile('Due in the next 30 days', esc(totalsText(d.due_30)), d.upcoming_items.length ? plural(d.upcoming_items.length, 'payment') : 'Nothing due soon', null)}
        ${tile(`Received in ${monthName(d.month)}`, esc(totalsText(d.received_this_month)), deltaText, `/admin/reports?r=payments&period=this-month`)}
        ${tile('Unmatched payments', String(d.unmatched.count), d.unmatched.count ? `${esc(totalsText(d.unmatched.total))} to assign` : 'Every payment is assigned', d.unmatched.count ? '/admin/invoices#unmatched' : null)}
      </div>
    </section>

    <div class="dash-grid section">
      <section class="panel">
        <div class="head tight"><h2>How late is the money?</h2><a class="small" href="/admin/reports?r=receivables" data-nav>Receivables report</a></div>
        ${meterList(d.aging)}
        <p class="muted small">Unpaid amounts on sent invoices by how far past their due date they are. Drafts and payments due on completion count as not late.</p>
      </section>
      <section class="panel">
        <h2>Overdue</h2>
        ${d.overdue_items.length ? `<table class="tbl compact"><thead><tr><th>Payment</th><th>Client</th><th>Late</th><th class="num">Amount</th></tr></thead>
          <tbody>${itemRows(d.overdue_items.slice(0, 8), ['late'])}</tbody></table>
          ${d.overdue_items.length > 8 ? `<p class="small"><a href="/admin/invoices?status=Overdue" data-nav>All ${d.overdue_items.length} overdue payments</a></p>` : ''}`
          : '<div class="empty">Nothing overdue. Everyone is paid up to date.</div>'}
      </section>
    </div>

    <section class="panel section">
      <div class="head tight"><h2>Balance by client</h2><span class="muted small">Click a client for their statement</span></div>
      ${d.clients.length ? `<table class="tbl compact">
        <thead><tr><th>Client</th><th class="num">Open invoices</th><th class="num">Owed</th><th class="num">Overdue</th><th>Oldest late payment</th></tr></thead>
        <tbody>${d.clients.map((c) => `
          <tr class="click" data-href="/admin/reports?r=statement&client=${encodeURIComponent(c.client_name)}">
            <td data-label="Client"><a href="/admin/reports?r=statement&client=${encodeURIComponent(c.client_name)}" data-nav>${esc(c.client_name)}</a></td>
            <td data-label="Open invoices" class="num">${c.invoices}</td>
            <td data-label="Owed" class="num">${esc(totalsText(c.outstanding))}</td>
            <td data-label="Overdue" class="num">${totalCents(c.overdue) ? esc(totalsText(c.overdue)) : '<span class="muted">—</span>'}</td>
            <td data-label="Oldest late">${c.oldest_days_late ? `<span class="badge Overdue">${lateText(c.oldest_days_late)}</span>` : '<span class="muted">Not late</span>'}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">No client owes anything.</div>'}
    </section>

    <div class="dash-grid section">
      <section class="panel">
        <h2>Due in the next 30 days</h2>
        ${d.upcoming_items.length ? `<table class="tbl compact"><thead><tr><th>Payment</th><th>Client</th><th>Due</th><th class="num">Amount</th></tr></thead>
          <tbody>${itemRows(d.upcoming_items, ['due'])}</tbody></table>` : '<div class="empty">Nothing due in the next 30 days.</div>'}
      </section>
      <section class="panel">
        <div class="head tight"><h2>Recent payments</h2><a class="small" href="/admin/reports?r=payments&period=this-month" data-nav>Payments report</a></div>
        ${d.recent_payments.length ? `<table class="tbl compact"><thead><tr><th>Date</th><th>From</th><th>Payment</th><th class="num">Amount</th></tr></thead>
          <tbody>${d.recent_payments.map((p) => `
            <tr${p.ref ? ` class="click" data-href="/admin/invoices/${esc(p.ref.slice(0, 4))}"` : ''}>
              <td data-label="Date">${esc(niceDate(p.date))}</td>
              <td data-label="From">${esc(p.client_name || p.payer || '—')}</td>
              <td data-label="Payment">${p.ref ? `<span class="mono">${esc(p.ref)}</span>` : '<span class="badge Partly">Unmatched</span>'}</td>
              <td data-label="Amount" class="num">${money(p.net_cents, p.currency)}${p.net_cents !== p.amount_cents ? `<div class="muted small">of ${money(p.amount_cents, p.currency)}</div>` : ''}</td>
            </tr>`).join('')}</tbody></table>` : '<div class="empty">No payments yet.</div>'}
      </section>
    </div>

    ${d.unsent_items.length ? `
      <section class="panel section">
        <div class="head tight"><h2>Not sent yet</h2><span class="muted small">Invoices still in draft. Email them from the invoice page.</span></div>
        <table class="tbl compact"><thead><tr><th>Payment</th><th>Client</th><th>Due</th><th class="num">Amount</th></tr></thead>
        <tbody>${itemRows(d.unsent_items, ['due'])}</tbody></table>
      </section>` : ''}`;

  clickableRows(app);
  // Widths are set here because the page's CSP doesn't allow inline style attributes.
  $$('.meter-fill').forEach((el) => { el.style.width = `${el.dataset.pct}%`; });
  $$('[data-setup]').forEach((b) => b.addEventListener('click', async () => {
    if (await busy(b, () => api(`setup/${b.dataset.setup}`, { method: 'POST', body: { done: true } }))) { toast('Marked done'); dashboardPage(); }
  }));
}

// ---------- reports ----------

function periodRange(period, today) {
  const [y, m] = today.split('-').map(Number);
  const iso = (yy, mm, dd) => new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10);
  const monthEnd = (yy, mm) => iso(yy, mm + 1, 0);
  const q = Math.floor((m - 1) / 3);
  switch (period) {
    case 'this-month': return [iso(y, m, 1), monthEnd(y, m)];
    case 'last-month': return [iso(y, m - 1, 1), monthEnd(y, m - 1)];
    case 'this-quarter': return [iso(y, q * 3 + 1, 1), monthEnd(y, q * 3 + 3)];
    case 'last-quarter': return [iso(y, q * 3 - 2, 1), monthEnd(y, q * 3)];
    case 'this-year': return [iso(y, 1, 1), iso(y, 12, 31)];
    case 'last-year': return [iso(y - 1, 1, 1), iso(y - 1, 12, 31)];
    default: return null;
  }
}
const PERIODS = { 'this-month': 'This month', 'last-month': 'Last month', 'this-quarter': 'This quarter', 'last-quarter': 'Last quarter', 'this-year': 'This year', 'last-year': 'Last year' };
const REPORTS = { receivables: 'Receivables', payments: 'Payments and HST', statement: 'Client statement' };

async function reportsPage() {
  const params = new URLSearchParams(location.search);
  const r = REPORTS[params.get('r')] ? params.get('r') : 'receivables';
  document.title = `${REPORTS[r]} | Painkiller Labs admin`;
  const tabs = `<nav class="tabs noprint" aria-label="Reports">${Object.entries(REPORTS).map(([k, v]) => `<a href="/admin/reports?r=${k}" data-nav${k === r ? ' aria-current="page"' : ''}>${v}</a>`).join('')}</nav>`;
  const head = (extra = '') => `<div class="head"><h1>Reports</h1><div class="actions noprint">${extra}<button class="btn btn-quiet" type="button" id="print" data-ro>Print or save as PDF</button></div></div>${tabs}`;
  const bindPrint = () => $('#print')?.addEventListener('click', () => window.print());

  if (r === 'receivables') {
    const d = await api('reports/receivables');
    const cells = (t) => AGE_KEYS.map((k) => `<td class="num" data-label="${AGE_SHORT[k]}">${totalCents(t[k]) ? esc(totalsText(t[k])) : '<span class="muted">—</span>'}</td>`).join('');
    app.innerHTML = `${head('<a class="btn btn-quiet" href="/admin/api/reports/receivables.csv" download>Export CSV</a>')}
      ${printHead('Receivables', `As of ${niceDate(d.as_of)}`)}
      <p class="muted section">Everything clients owe as of ${esc(niceDate(d.as_of))}, by how late it is. Drafts and payments due on completion count as not late.</p>
      <dl class="summary five">${[...AGE_KEYS, 'total'].map((k) => `<div><dt>${k === 'total' ? 'Total owed' : AGE_SHORT[k]}</dt><dd>${esc(totalsText(d.totals[k]))}</dd></div>`).join('')}</dl>
      ${d.clients.length ? `<table class="tbl report">
        <thead><tr><th>Client / payment</th><th>Due</th>${AGE_KEYS.map((k) => `<th class="num">${AGE_SHORT[k]}</th>`).join('')}<th class="num">Total</th></tr></thead>
        <tbody>${d.clients.map((c) => `
          <tr class="group"><td data-label="Client" colspan="2"><a href="/admin/reports?r=statement&client=${encodeURIComponent(c.client_name)}" data-nav>${esc(c.client_name)}</a></td>${cells(c)}<td class="num" data-label="Total">${esc(totalsText(c.total))}</td></tr>
          ${c.items.map((l) => `
            <tr class="click" data-href="/admin/invoices/${esc(l.invoice_id)}">
              <td data-label="Payment"><span class="mono">${esc(l.ref)}</span>${l.label ? ` <span class="muted small">${esc(l.label)}</span>` : ''}${l.sent ? '' : ' <span class="badge Draft">Not sent</span>'}</td>
              <td data-label="Due">${esc(l.due_date ? niceDate(l.due_date) : 'On completion')}${l.days_late ? ` <span class="muted small">(${lateText(l.days_late)} late)</span>` : ''}</td>
              ${AGE_KEYS.map((k) => `<td class="num" data-label="${AGE_SHORT[k]}">${l.bucket === k ? money(l.outstanding_cents, l.currency) : ''}</td>`).join('')}
              <td class="num" data-label="Total">${money(l.outstanding_cents, l.currency)}</td>
            </tr>`).join('')}`).join('')}</tbody>
        <tfoot><tr><td colspan="2">Total</td>${cells(d.totals)}<td class="num">${esc(totalsText(d.totals.total))}</td></tr></tfoot>
      </table>` : '<div class="empty">Nobody owes you anything.</div>'}`;
    clickableRows(app);
    return bindPrint();
  }

  if (r === 'payments') {
    const period = params.get('period') || (params.get('from') ? '' : 'this-month');
    const range = periodRange(period, config.today) || [params.get('from'), params.get('to')];
    const [from, to] = range;
    const d = await api(`reports/payments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const t = d.totals;
    const inv = Object.entries(d.invoiced);
    app.innerHTML = `${head(`<a class="btn btn-quiet" href="/admin/api/reports/payments.csv?from=${esc(from)}&to=${esc(to)}" download>Export CSV</a>`)}
      ${printHead('Payments and HST', `${niceDate(from)} to ${niceDate(to)}`)}
      <form class="filters report-filters noprint section" id="range">
        <label>From <input type="date" name="from" value="${esc(from)}" required></label>
        <label>To <input type="date" name="to" value="${esc(to)}" required></label>
        <button class="btn btn-quiet" type="submit" data-ro>Show</button>
        <div class="chips">${Object.entries(PERIODS).map(([k, v]) => `<a class="chip" href="/admin/reports?r=payments&period=${k}" data-nav${k === period ? ' aria-current="true"' : ''}>${v}</a>`).join('')}</div>
      </form>
      <div class="dash-grid section">
        <section class="panel">
          <h2>Money received</h2>
          <dl class="kv wide">
            <dt>Payments received</dt><dd class="num">${esc(totalsText(t.received))}</dd>
            <dt>Refunds</dt><dd class="num">${totalCents(t.refunded) ? esc(totalsText(t.refunded)) : money(0)}</dd>
            <dt><strong>Net received</strong></dt><dd class="num"><strong>${esc(totalsText(t.net))}</strong></dd>
            <dt>HST in those payments</dt><dd class="num">${esc(totalsText(t.hst))}</dd>
            <dt>Before tax</dt><dd class="num">${esc(totalsText(t.before_tax))}</dd>
          </dl>
          ${totalCents(t.unmatched) ? `<div class="notice warn small">${esc(totalsText(t.unmatched))} isn't matched to an invoice, so it has no HST worked out. <a href="/admin/invoices#unmatched" data-nav>Match it</a>.</div>` : ''}
          ${totalCents(t.disputed) ? `<div class="notice bad small">${esc(totalsText(t.disputed))} is held in card disputes and isn't counted as paid on the invoices.</div>` : ''}
        </section>
        <section class="panel">
          <h2>Invoiced in this period</h2>
          ${inv.length ? `<dl class="kv wide">${inv.map(([c, v]) => `
            <dt>Invoices issued</dt><dd class="num">${v.count}</dd>
            <dt>Before tax</dt><dd class="num">${money(v.subtotal, c)}</dd>
            <dt><strong>HST charged</strong></dt><dd class="num"><strong>${money(v.hst, c)}</strong></dd>
            <dt>Total invoiced</dt><dd class="num">${money(v.total, c)}</dd>`).join('')}</dl>` : '<p class="muted">No invoices issued in this period.</p>'}
          <p class="muted small">HST is normally reported for the period you invoice in, so "HST charged" is usually the figure for your return. If your accountant files on a cash basis, use "HST in those payments" instead.</p>
        </section>
      </div>
      <section class="section">
        <h2>Every payment and refund</h2>
        ${d.rows.length ? `<table class="tbl report section">
          <thead><tr><th>Date</th><th>Payment</th><th>Client / payer</th><th>Method</th><th class="num">Amount</th><th class="num">HST</th></tr></thead>
          <tbody>${d.rows.map((x) => `
            <tr${x.ref ? ` class="click" data-href="/admin/invoices/${esc(x.ref.slice(0, 4))}"` : ''}>
              <td data-label="Date">${esc(niceDate(x.date))}</td>
              <td data-label="Payment">${x.ref ? `<span class="mono">${esc(x.ref)}</span>` : '<span class="badge Partly">Unmatched</span>'}${x.kind === 'refund' ? ' <span class="badge Overdue">Refund</span>' : ''}${x.dispute_status ? ' <span class="badge Overdue">Disputed</span>' : ''}</td>
              <td data-label="Client">${esc(x.client_name || x.payer || '—')}</td>
              <td data-label="Method">${esc(x.method || '')}</td>
              <td data-label="Amount" class="num">${money(x.amount_cents, x.currency)}</td>
              <td data-label="HST" class="num">${x.matched ? money(x.hst_cents, x.currency) : '<span class="muted">—</span>'}</td>
            </tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="4">Net</td><td class="num">${esc(totalsText(t.net))}</td><td class="num">${esc(totalsText(t.hst))}</td></tr></tfoot>
        </table>` : '<div class="empty section">No payments in this period.</div>'}
      </section>`;
    $('#range').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      if (!f.from.value || !f.to.value) return toast('Choose both dates.', true);
      go(`/admin/reports?r=payments&from=${f.from.value}&to=${f.to.value}`, true);
    });
    clickableRows(app);
    return bindPrint();
  }

  // Client statement
  const { clients } = await api('clients');
  const client = params.get('client') || '';
  const picker = `<form class="filters report-filters noprint section" id="pick">
      <label>Client <select name="client"><option value="">Choose a client…</option>${clients.map((c) => `<option${c === client ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    </form>`;
  if (!client) {
    app.innerHTML = `${head()}${picker}<div class="empty section">${clients.length ? 'Choose a client to see every invoice, payment and refund, with a running balance.' : 'No clients yet.'}</div>`;
  } else {
    const s = await api(`reports/statement?client=${encodeURIComponent(client)}`);
    app.innerHTML = `${head()}${printHead(`Statement for ${s.client_name}`, `As of ${niceDate(s.as_of)}`)}${picker}
      <div class="statement-head section">
        <div><h2>${esc(s.client_name)}</h2>${s.client_email ? `<p class="muted">${esc(s.client_email)}</p>` : ''}</div>
        <dl class="summary one"><div><dt>Balance owing</dt><dd>${esc(totalsText(s.balance))}</dd></div></dl>
      </div>
      <table class="tbl report section">
        <thead><tr><th>Date</th><th>Description</th><th class="num">Charges</th><th class="num">Payments</th><th class="num">Balance</th></tr></thead>
        <tbody>${s.entries.map((e) => `
          <tr${e.ref ? ` class="click" data-href="/admin/invoices/${esc(e.ref.slice(0, 4))}"` : ''}>
            <td data-label="Date">${esc(niceDate(e.date))}</td>
            <td data-label="Description">${esc(e.text)}</td>
            <td data-label="Charges" class="num">${e.charge_cents ? money(e.charge_cents, e.currency) : ''}</td>
            <td data-label="Payments" class="num">${e.credit_cents ? money(e.credit_cents, e.currency) : ''}</td>
            <td data-label="Balance" class="num">${money(e.balance_cents, e.currency)}</td>
          </tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="4">Balance owing</td><td class="num">${esc(totalsText(s.balance))}</td></tr></tfoot>
      </table>
      ${s.open_items.length ? `
        <section class="section">
          <h2>Still to pay</h2>
          <table class="tbl report section">
            <thead><tr><th>Payment</th><th>Due</th><th class="num">Amount</th></tr></thead>
            <tbody>${s.open_items.map((l) => `
              <tr class="click" data-href="/admin/invoices/${esc(l.invoice_id)}">
                <td data-label="Payment"><span class="mono">${esc(l.ref)}</span>${l.label ? ` <span class="muted small">${esc(l.label)}</span>` : ''}</td>
                <td data-label="Due">${esc(l.due_date ? niceDate(l.due_date) : 'On completion')}${l.days_late ? ` <span class="badge Overdue">${lateText(l.days_late)} late</span>` : ''}</td>
                <td data-label="Amount" class="num">${money(l.outstanding_cents, l.currency)}</td>
              </tr>`).join('')}</tbody>
          </table>
        </section>` : '<p class="muted section">Nothing left to pay.</p>'}`;
  }
  $('#pick select').addEventListener('change', (e) => go(`/admin/reports?r=statement${e.target.value ? `&client=${encodeURIComponent(e.target.value)}` : ''}`, true));
  clickableRows(app);
  bindPrint();
}

// ---------- bank ----------

const PAYOUT_STATUS = { paid: ['Paid', 'Deposited'], in_transit: ['Sent', 'On the way'], pending: ['Draft', 'Pending'], failed: ['Overdue', 'Failed'], canceled: ['Void', 'Cancelled'] };
const payoutBadge = (s) => { const [cls, text] = PAYOUT_STATUS[s] || ['Draft', s]; return `<span class="badge ${cls}">${esc(text)}</span>`; };
const inBank = (b, waiting) => (b
  ? `<span class="badge Paid" title="${esc(b.description)}">In bank ${esc(niceDate(b.date))}</span>`
  : `<span class="badge ${waiting ? 'Draft' : 'Partly'}">${waiting ? 'Not landed yet' : 'Not matched'}</span>`);
const payRef = (t) => (t.ref
  ? `<a class="mono" href="/admin/invoices/${esc(t.invoice_id)}" data-nav>${esc(t.ref)}</a>`
  : t.payment_id ? '<span class="badge Partly">Unmatched</span>' : '<span class="muted small">Not in the ledger</span>');
function ago(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return niceDate(iso.slice(0, 10));
}

async function bankPage() {
  const params = new URLSearchParams(location.search);
  const period = params.get('period') || (params.get('from') ? '' : 'this-month');
  const [from, to] = periodRange(period, config.today) || [params.get('from'), params.get('to')];
  const d = await api(`bank?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  document.title = 'Bank | Painkiller Labs admin';
  const t = d.totals;
  const stripeHeld = d.balance ? addTotals(d.balance.available, d.balance.pending) : t.pending;
  const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const notices = [];
  if (!d.stripe) notices.push('<div class="notice warn">Stripe isn’t connected, so only e-transfers, cheques and cash show here.</div>');
  else if (d.sync_error) notices.push(`<div class="notice warn"><strong>Couldn’t read Stripe.</strong> ${esc(d.sync_error)}</div>`);
  else if (!d.charges_readable) notices.push('<div class="notice small">The Stripe key can’t read charges, so card payments are matched to invoices by amount and date. Set Charges to Read on the key for exact matching.</div>');

  app.innerHTML = `
    <div class="head">
      <h1>Bank</h1>
      <div class="actions noprint">
        ${d.stripe ? '<button class="btn btn-quiet" type="button" id="sync">Sync with Stripe</button>' : ''}
        <a class="btn btn-quiet" href="/admin/api/bank.csv?${qs}" download>Export CSV</a>
        <button class="btn btn-quiet" type="button" id="print" data-ro>Print or save as PDF</button>
      </div>
    </div>
    ${printHead('Deposits and Stripe fees', `${niceDate(from)} to ${niceDate(to)}`)}
    <p class="muted noprint">Every deposit that should reach your bank: Stripe payouts broken down into the payments and fees inside them, plus e-transfers, cheques and cash.${d.synced_at ? ` Synced with Stripe ${esc(ago(d.synced_at))}.` : ''}</p>
    ${notices.join('')}
    <form class="filters report-filters noprint section" id="range">
      <label>From <input type="date" name="from" value="${esc(from)}" required></label>
      <label>To <input type="date" name="to" value="${esc(to)}" required></label>
      <button class="btn btn-quiet" type="submit" data-ro>Show</button>
      <div class="chips">${Object.entries(PERIODS).map(([k, v]) => `<a class="chip" href="/admin/bank?period=${k}" data-nav${k === period ? ' aria-current="true"' : ''}>${v}</a>`).join('')}</div>
    </form>

    <dl class="summary five">
      <div><dt>Stripe deposits</dt><dd>${esc(totalsText(t.deposited))}</dd></div>
      <div><dt>Stripe fees</dt><dd>${esc(totalsText(t.fees))}</dd></div>
      <div><dt>E-transfers and cheques</dt><dd>${esc(totalsText(t.manual))}</dd></div>
      <div><dt>Held by Stripe now</dt><dd>${esc(totalsText(stripeHeld))}</dd></div>
      <div><dt>Not matched to bank</dt><dd>${d.counts.bank_lines_total ? d.counts.not_in_bank : '<span class="muted small">Import a statement</span>'}</dd></div>
    </dl>

    <section class="section">
      <div class="head tight"><h2>Stripe deposits</h2><span class="muted small noprint">Click a deposit to see what’s in it</span></div>
      ${d.payouts.length ? `<div class="payouts">${d.payouts.map(payoutBlock).join('')}</div>`
        : `<div class="empty">${d.stripe && !d.sync_error ? 'No Stripe deposits in this period.' : 'No Stripe deposits to show.'}</div>`}
    </section>

    ${d.pending.length || d.on_the_way.length ? `
    <section class="section">
      <div class="head tight"><h2>Collected, not in your bank yet</h2>${d.balance ? `<span class="muted small">Stripe is holding ${esc(totalsText(stripeHeld))}</span>` : ''}</div>
      <p class="muted small">Card payments reach your bank in a Stripe payout, usually 2 business days after they’re made.</p>
      <table class="tbl report section">
        <thead><tr><th>Date</th><th>What</th><th>Payment</th><th>Client / payer</th><th class="num">Amount</th><th class="num">Fee</th><th class="num">You get</th></tr></thead>
        <tbody>
          ${d.on_the_way.map((p) => `<tr><td data-label="Date">${esc(niceDate(p.date))}</td><td data-label="What"><span>Payout ${payoutBadge(p.status)}</span></td><td data-label="Payment"><span class="muted small">Arriving ${esc(niceDate(p.date))}</span></td><td data-label="Client"></td><td class="num" data-label="Amount"></td><td class="num" data-label="Fee"></td><td class="num" data-label="You get">${money(p.amount_cents, p.currency)}</td></tr>`).join('')}
          ${d.pending.map((x) => txnRow(x)).join('')}
        </tbody>
      </table>
    </section>` : ''}

    <section class="section">
      <div class="head tight"><h2>E-transfers, cheques and cash</h2><span class="muted small">Payments you recorded by hand</span></div>
      ${d.manual.length ? `<table class="tbl report section">
        <thead><tr><th>Date</th><th>Payment</th><th>Client</th><th>Method</th><th class="num">Amount</th><th>Bank</th></tr></thead>
        <tbody>${d.manual.map((m) => `
          <tr><td data-label="Date">${esc(niceDate(m.date))}</td><td data-label="Payment">${payRef(m)}</td><td data-label="Client">${esc(m.client_name || '—')}</td>
            <td data-label="Method">${esc(m.method)}</td><td class="num" data-label="Amount">${money(m.amount_cents, m.currency)}</td>
            <td data-label="Bank">${d.counts.bank_lines_total ? inBank(m.bank) : '<span class="muted small">—</span>'}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="4">Total</td><td class="num">${esc(totalsText(t.manual))}</td><td></td></tr></tfoot>
      </table>` : '<div class="empty">No e-transfers, cheques or cash recorded in this period.</div>'}
    </section>

    <section class="section">
      <div class="head tight"><h2>Bank statement</h2></div>
      <form class="panel import noprint" id="import">
        <div>
          <strong>Import deposits from your bank</strong>
          <p class="muted small">In online banking, download your account activity as a CSV file and choose it here. Only deposits are read. Each one is matched to a Stripe payout or a recorded payment when the amount and date line up. Importing the same file twice is fine.</p>
        </div>
        <div class="import-row">
          <input type="file" name="file" accept=".csv,text/csv" required>
          <select name="currency" aria-label="Account currency"><option>CAD</option><option>USD</option></select>
          <button class="btn" type="submit">Import</button>
        </div>
      </form>
      ${d.bank_lines.length ? `<table class="tbl report section">
        <thead><tr><th>Date</th><th>Bank description</th><th class="num">Amount</th><th>Matched to</th></tr></thead>
        <tbody>${d.bank_lines.map(bankLineRow).join('')}</tbody>
      </table>` : `<div class="empty section">${d.counts.bank_lines_total ? 'No bank deposits in this period.' : 'No bank statement imported yet.'}</div>`}
    </section>`;

  // Open every deposit's breakdown on paper.
  const details = $$('details.payout');
  window.onbeforeprint = () => details.forEach((x) => { x.dataset.wasOpen = x.open ? '1' : ''; x.open = true; });
  window.onafterprint = () => details.forEach((x) => { x.open = x.dataset.wasOpen === '1'; });
  $('#print').addEventListener('click', () => window.print());
  $('#sync')?.addEventListener('click', (e) => busy(e.target, async () => {
    const r = await api('bank/sync', { method: 'POST' });
    toast(`Synced: ${plural(r.payouts, 'payout')}`);
    bankPage();
  }));
  $('#range').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    go(`/admin/bank?from=${f.from.value}&to=${f.to.value}`, true);
  });
  $('#import').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const file = f.file.files[0];
    if (!file) return toast('Choose a CSV file first.', true);
    if (file.size > 7_000_000) return toast('That file is too large. Download a shorter date range.', true);
    busy(f.querySelector('button'), async () => {
      const r = await api('bank/import', { method: 'POST', body: { csv: await file.text(), currency: f.currency.value } });
      const bits = [`${plural(r.imported, 'deposit')} imported`];
      if (r.matched) bits.push(`${r.matched} matched`);
      if (r.duplicates) bits.push(`${r.duplicates} already there`);
      toast(bits.join(', '));
      bankPage();
    });
  });
  $$('[data-match]').forEach((b) => b.addEventListener('click', () => {
    const sel = $(`select[data-for="${b.dataset.match}"]`);
    if (!sel.value) return toast('Choose what this deposit is.', true);
    const [type, id] = sel.value.split(':');
    busy(b, async () => {
      const r = await api(`bank/lines/${b.dataset.match}/match`, { method: 'POST', body: { type, id } });
      toast(r.amount_differs ? 'Matched. The amounts are different, so check it.' : 'Matched');
      bankPage();
    });
  }));
  for (const [attr, action, msg] of [['data-unmatch', 'unmatch', 'Match removed'], ['data-restore', 'restore', 'Restored']]) {
    $$(`[${attr}]`).forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      await api(`bank/lines/${b.getAttribute(attr)}/${action}`, { method: 'POST' });
      toast(msg);
      bankPage();
    })));
  }
  $$('[data-ignore]').forEach((b) => b.addEventListener('click', () => {
    const row = b.closest('td');
    if (row.querySelector('.ignore-form')) return;
    row.insertAdjacentHTML('beforeend', `<form class="ignore-form"><input name="note" placeholder="Why? e.g. owner loan, GST refund" maxlength="300"><button class="btn btn-quiet btn-sm">Not a client payment</button></form>`);
    const f = row.querySelector('.ignore-form');
    f.note.focus();
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(f.querySelector('button'), async () => {
        await api(`bank/lines/${b.dataset.ignore}/ignore`, { method: 'POST', body: { note: f.note.value } });
        toast('Marked as not a client payment');
        bankPage();
      });
    });
  }));
}

function addTotals(...ts) {
  const out = {};
  for (const t of ts) for (const [c, v] of Object.entries(t || {})) out[c] = (out[c] || 0) + v;
  return out;
}

function txnRow(x) {
  const fee = x.fee_cents ? `−${money(x.fee_cents, x.currency)}` : '';
  const isFee = ['stripe_fee', 'tax'].includes(x.type);
  return `
    <tr>
      <td data-label="Date">${esc(niceDate(x.date))}</td>
      <td data-label="What">${esc(x.label)}</td>
      <td data-label="Payment">${isFee ? '' : payRef(x)}</td>
      <td data-label="Client">${esc(x.client_name || x.payer || x.description || '—')}</td>
      <td class="num" data-label="Amount">${isFee ? '' : money(x.amount_cents, x.currency)}</td>
      <td class="num" data-label="Fee">${fee}</td>
      <td class="num" data-label="You get">${money(x.net_cents, x.currency)}</td>
    </tr>`;
}

function payoutBlock(p) {
  const payments = p.txns.filter((x) => ['charge', 'payment'].includes(x.type)).length;
  const sub = !p.automatic ? 'Manual payout. Stripe doesn’t list what’s in it.'
    : !p.itemised ? 'Breakdown not read yet'
      : `${plural(payments, 'payment')}${p.fee_cents ? ` · ${money(p.fee_cents, p.currency)} in fees` : ''}`;
  return `
    <details class="payout panel">
      <summary>
        <span class="payout-date">${esc(niceDate(p.date))}</span>
        <span class="payout-sub">${payoutBadge(p.status)} <span class="muted small">${esc(sub)}</span></span>
        <span class="payout-bank">${p.status === 'paid' || p.status === 'in_transit' ? inBank(p.bank, p.status !== 'paid') : ''}</span>
        <span class="payout-amt num">${money(p.amount_cents, p.currency)}</span>
      </summary>
      ${p.failure_message ? `<div class="notice bad small">${esc(p.failure_message)}</div>` : ''}
      ${p.balanced === false ? `<div class="notice warn small">The items below add up to ${money(p.net_cents, p.currency)}, not ${money(p.amount_cents, p.currency)}. Press Sync with Stripe to read this deposit again.</div>` : ''}
      ${p.txns.length ? `<table class="tbl report compact">
        <thead><tr><th>Date</th><th>What</th><th>Payment</th><th>Client / payer</th><th class="num">Amount</th><th class="num">Fee</th><th class="num">You get</th></tr></thead>
        <tbody>${p.txns.map(txnRow).join('')}</tbody>
        <tfoot><tr><td colspan="4">Deposited</td><td class="num">${money(p.gross_cents, p.currency)}</td><td class="num">${p.fee_cents ? `−${money(p.fee_cents, p.currency)}` : ''}</td><td class="num">${money(p.net_cents, p.currency)}</td></tr></tfoot>
      </table>` : ''}
      <p class="muted small mono">${esc(p.id)}</p>
    </details>`;
}

function bankLineRow(l) {
  let cell;
  if (l.match_type) {
    cell = `<span class="badge Paid">${l.match_method === 'auto' ? 'Matched' : 'Matched by you'}</span> <span class="small">${esc(l.matched_to)}</span>
      <button class="link-btn small noprint" data-unmatch="${l.id}">Undo</button>`;
  } else if (l.ignored_at) {
    cell = `<span class="badge Draft">Not a client payment</span>${l.note ? ` <span class="muted small">${esc(l.note)}</span>` : ''}
      <button class="link-btn small noprint" data-restore="${l.id}">Restore</button>`;
  } else {
    const opts = l.options.map((o) => `<option value="${o.type}:${esc(o.id)}">${o.exact ? '' : '≠ '}${esc(niceDate(o.date))} · ${money(o.amount_cents, o.currency)} · ${esc(o.label)}</option>`).join('');
    cell = `<span class="badge Partly">Not matched</span>
      <div class="match-row noprint">
        ${l.options.length ? `<select data-for="${l.id}" aria-label="Match this deposit"><option value="">What is this deposit?</option>${opts}</select>
        <button class="btn btn-quiet btn-sm" data-match="${l.id}">Match</button>` : '<span class="muted small">Nothing in the ledger is close to this amount and date.</span>'}
        <button class="link-btn small" data-ignore="${l.id}">Not a client payment</button>
      </div>`;
  }
  return `
    <tr>
      <td data-label="Date">${esc(niceDate(l.date))}</td>
      <td data-label="Description">${esc(l.description || '—')}</td>
      <td class="num" data-label="Amount">${money(l.amount_cents, l.currency)}</td>
      <td data-label="Matched to"><div class="cell-stack">${cell}</div></td>
    </tr>`;
}

// ---------- reminders panel (invoice page) ----------

function remindersPanel(inv, openLines) {
  const global = !!config.reminders;
  let status;
  if (!global) status = 'Automatic reminders are switched off for all invoices. An admin can turn them on in Settings.';
  else if (inv.reminders_off) status = 'Automatic reminders are off for this invoice.';
  else status = 'Automatic reminders are on: 3 days before each payment is due, then 1, 7 and 21 days after if it’s still unpaid.';
  if (global && !inv.reminders_off && !inv.sent_date) status += ' They start once the invoice is marked as sent.';
  return `
    <div class="panel">
      <h2>Payment reminders</h2>
      <p class="muted small">${esc(status)}</p>
      <div class="actions">
        <button class="btn btn-quiet btn-sm" data-panel="remind"${openLines.length ? '' : ' disabled'}>Send a reminder now</button>
        ${global ? `<button class="btn btn-quiet btn-sm" id="toggle-reminders">${inv.reminders_off ? 'Turn on for this invoice' : 'Turn off for this invoice'}</button>` : ''}
      </div>
      ${inv.reminders.length ? `<table class="tbl compact section">
        <thead><tr><th>Sent</th><th>Payment</th><th>Why</th><th>To</th></tr></thead>
        <tbody>${inv.reminders.map((r) => `
          <tr><td data-label="Sent">${esc(niceDateTime(r.sent_at))}</td><td data-label="Payment" class="mono">${esc(r.ref)}</td>
            <td data-label="Why">${esc(REMINDER_KIND[r.kind] || r.kind)}${r.error ? ` <span class="badge Overdue" title="${esc(r.error)}">Failed</span>` : ''}</td>
            <td data-label="To">${esc(r.sent_to)}</td></tr>`).join('')}</tbody></table>` : ''}
    </div>`;
}

// ---------- clients ----------

async function clientsPage() {
  const { clients } = await api('clients/all');
  document.title = 'Clients | Painkiller Labs admin';
  app.innerHTML = `
    <div class="head"><h1>Clients</h1><div class="actions"><a class="btn" href="/admin/invoices/new" data-nav>New invoice</a></div></div>
    <p class="muted">Clients are saved when you create an invoice for them. Pick them from the list on the invoice form so one client doesn’t end up under two names.</p>
    ${clients.length ? `
      <div class="filters section"><label class="q">Search <input type="search" id="find" placeholder="Name or email" autocomplete="off"></label></div>
      <table class="tbl section" id="clients">
        <thead><tr><th>Client</th><th>Email</th><th class="num">Invoices</th><th class="num">Owed</th><th>Last invoice</th></tr></thead>
        <tbody>${clients.map((c) => `
          <tr class="click" data-href="/admin/clients/${c.id}" data-find="${esc(`${c.name} ${c.email}`.toLowerCase())}">
            <td data-label="Client"><a href="/admin/clients/${c.id}" data-nav>${esc(c.name)}</a></td>
            <td data-label="Email">${c.email ? esc(c.email) : '<span class="muted">—</span>'}</td>
            <td data-label="Invoices" class="num">${c.invoices}${c.open ? ` <span class="muted small">(${c.open} open)</span>` : ''}</td>
            <td data-label="Owed" class="num">${totalCents(c.owed) ? `${esc(totalsText(c.owed))}${c.overdue ? ' <span class="badge Overdue">Overdue</span>' : ''}` : '<span class="muted">—</span>'}</td>
            <td data-label="Last invoice">${c.last_invoice ? esc(niceDate(c.last_invoice)) : '<span class="muted">—</span>'}</td>
          </tr>`).join('')}</tbody>
      </table>` : '<div class="empty section">No clients yet. They’re added when you create an invoice.</div>'}`;
  clickableRows(app);
  $('#find')?.addEventListener('input', (e) => {
    const n = e.target.value.trim().toLowerCase();
    $$('#clients tbody tr').forEach((tr) => { tr.hidden = !!n && !tr.dataset.find.includes(n); });
  });
}

async function clientPage(id) {
  const [c, { clients }] = await Promise.all([api(`clients/${id}`), api('clients/all')]);
  document.title = `${c.name} | Painkiller Labs admin`;
  if (c.archived_at) {
    app.innerHTML = `<a class="back" href="/admin/clients" data-nav>← Clients</a><div class="notice">${esc(c.name)}. This client was merged into another one, and their invoices moved with them.</div>`;
    return;
  }
  const others = clients.filter((x) => x.id !== c.id);
  const ro = readOnly();
  app.innerHTML = `
    <a class="back" href="/admin/clients" data-nav>← Clients</a>
    <div class="head">
      <div><h1>${esc(c.name)}</h1>${c.email ? `<p class="muted">${esc(c.email)}</p>` : ''}</div>
      <div class="actions">
        <a class="btn btn-quiet" href="/admin/reports?r=statement&client=${encodeURIComponent(c.name)}" data-nav data-ro>Statement</a>
        <a class="btn" href="/admin/invoices/new?client=${c.id}" data-nav>New invoice for ${esc(c.name)}</a>
      </div>
    </div>
    <section class="section">
      <h2>Invoices</h2>
      ${c.invoices.length ? `<table class="tbl section">
        <thead><tr><th>Invoice</th><th>Issued</th><th>Status</th><th class="num">Total</th><th class="num">Owed</th></tr></thead>
        <tbody>${c.invoices.map((i) => `
          <tr class="click" data-href="/admin/invoices/${esc(i.id)}">
            <td data-label="Invoice"><a class="mono" href="/admin/invoices/${esc(i.id)}" data-nav>${esc(i.id)}</a>${i.description ? `<div class="muted small">${esc(i.description.split('\n')[0].slice(0, 80))}</div>` : ''}</td>
            <td data-label="Issued">${esc(niceDate(i.issue_date))}</td>
            <td data-label="Status">${badge(i.status)}</td>
            <td data-label="Total" class="num">${money(i.total_cents, i.currency)}</td>
            <td data-label="Owed" class="num">${i.outstanding_cents && !i.voided_at ? money(i.outstanding_cents, i.currency) : '<span class="muted">—</span>'}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty section">No invoices.</div>'}
    </section>
    <form class="panel stack" id="client-form">
      <h2>Details</h2>
      <fieldset class="plain stack"${ro ? ' disabled' : ''}>
        <div class="grid2">
          <label>Name <input name="name" required value="${esc(c.name)}"></label>
          <label>Email <input name="email" type="email" value="${esc(c.email)}"></label>
        </div>
        <label>Billing address <textarea name="address" rows="3">${esc(c.address)}</textarea></label>
        <label>Notes <span class="muted small">(private)</span><textarea name="notes" rows="2">${esc(c.notes)}</textarea></label>
      </fieldset>
      <p class="muted small">Renaming a client renames them on all their invoices. A new email or address is used on new invoices and reminders; invoices already sent keep what they were sent with.</p>
      <div class="actions"><button class="btn" type="submit">Save client</button></div>
    </form>
    ${others.length && !ro ? `
    <form class="panel stack" id="merge-form">
      <h2>Same client under another name?</h2>
      <p class="muted small">Merging moves all of ${esc(c.name)}’s invoices to the client you choose, and removes ${esc(c.name)} from the list. Their history is kept.</p>
      <div class="merge-row">
        <select name="into" aria-label="Merge into"><option value="">Merge ${esc(c.name)} into…</option>${others.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select>
        <button class="btn btn-quiet" type="submit">Merge</button>
      </div>
    </form>` : ''}
    ${c.history.length ? `<div class="panel"><h2>History</h2><ul class="history">${c.history.map((h) => `
      <li><div>${esc(CLIENT_ACTION[h.action] || h.action)}${h.action === 'client_edit' ? ` <span class="muted">· Changed: ${esc(Object.keys(h.detail).join(', '))}</span>` : ''}${h.detail.from && h.action === 'client_merge' ? ` <span class="muted">· ${esc(h.detail.from)}</span>` : ''}</div>
        <div class="when">${esc(niceDateTime(h.at))}${h.actor ? ` · ${esc(h.actor)}` : ''}</div></li>`).join('')}</ul></div>` : ''}`;
  clickableRows(app);
  $('#client-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const out = await busy(f.querySelector('button[type=submit]'), () => api(`clients/${c.id}`, { method: 'POST', body: {
      name: f.name.value, email: f.email.value, address: f.address.value, notes: f.notes.value,
    } }));
    if (out) { toast(out.changed.length ? 'Client saved' : 'No changes'); clientPage(id); }
  });
  $('#merge-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.into.value) return toast('Choose the client to merge into.', true);
    const into = others.find((o) => String(o.id) === f.into.value);
    if (!confirm(`Move all of ${c.name}'s invoices to ${into.name}? This can't be undone from here.`)) return;
    const out = await busy(f.querySelector('button'), () => api(`clients/${c.id}/merge`, { method: 'POST', body: { into: into.id } }));
    if (out) { toast(`Merged: ${plural(out.moved, 'invoice')} moved to ${into.name}`); go(`/admin/clients/${into.id}`, true); }
  });
}
const CLIENT_ACTION = { client_create: 'Client saved', client_edit: 'Details changed', client_merge: 'Another client merged in', client_merged_into: 'Merged into another client' };

// ---------- settings: people and reminders ----------

const ROLE_TEXT = {
  admin: ['Admin', 'Can do everything, including adding and removing people.'],
  viewer: ['Read only', 'Can see invoices, clients, reports and the bank page, but can’t change anything.'],
};

async function settingsPage() {
  const [{ users, me }, st] = await Promise.all([api('users'), api('settings')]);
  document.title = 'Settings | Painkiller Labs admin';
  const roleSelect = (u) => `<select data-role="${esc(u.email)}" aria-label="Access for ${esc(u.email)}">${Object.entries(ROLE_TEXT).map(([k, [label]]) => `<option value="${k}"${u.role === k ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
  app.innerHTML = `
    <div class="head"><h1>Settings</h1></div>

    <section class="section">
      <div class="head tight"><h2>Who can sign in</h2></div>
      <p class="muted">Only these people can get a sign-in link. ${Object.values(ROLE_TEXT).map(([l, d]) => `<strong>${l}:</strong> ${esc(d)}`).join(' ')}</p>
      <table class="tbl section">
        <thead><tr><th>Person</th><th>Access</th><th>Last signed in</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr>
            <td data-label="Person"><span>${esc(u.email)}${u.name ? `<div class="muted small">${esc(u.name)}</div>` : ''}</span></td>
            <td data-label="Access">${u.email === me ? `${ROLE_TEXT[u.role][0]} <span class="muted small">(you)</span>` : roleSelect(u)}</td>
            <td data-label="Last signed in">${u.last_sign_in ? esc(niceDateTime(u.last_sign_in)) : '<span class="muted">Not yet</span>'}</td>
            <td data-label="">${u.email === me ? '' : `<button class="link-btn small" data-remove="${esc(u.email)}">Remove</button>`}</td>
          </tr>`).join('')}</tbody>
      </table>
      <form class="panel stack section" id="add-user">
        <h2>Add someone</h2>
        <div class="grid3">
          <label>Email <input type="email" name="email" required autocomplete="off"></label>
          <label>Name <span class="muted small">(optional)</span><input name="name" autocomplete="off"></label>
          <label>Access <select name="role"><option value="viewer">Read only</option><option value="admin">Admin</option></select></label>
        </div>
        <p class="muted small">They sign in at ${esc((config.public_url || location.origin) + '/admin')} with this email address. No email is sent when you add them, so let them know.</p>
        <div class="actions"><button class="btn" type="submit">Add</button></div>
      </form>
    </section>

    <section class="section">
      <div class="head tight"><h2>Payment reminders</h2></div>
      <div class="panel stack">
        <div class="toggle-row">
          <div><strong>Automatic reminder emails are ${st.reminders ? 'on' : 'off'}</strong>
            <p class="muted small">When on, clients get an email at each of these points while a payment is unpaid: ${st.stages.map((s) => esc(s.label.toLowerCase())).join(', ')}. After that, no more emails. Only invoices that have been sent, to clients with an email address, get them. They go out between 9 am and 6 pm Toronto time. You can turn them off for any single invoice from its page.</p></div>
          <button class="btn${st.reminders ? ' btn-quiet' : ''}" id="toggle-auto">${st.reminders ? 'Turn off' : 'Turn on'}</button>
        </div>
        ${st.email ? '' : '<div class="notice bad small">Email isn’t set up on the server (RESEND_API_KEY), so reminders can’t be sent.</div>'}
        <div>
          <h3 class="small-h">${st.reminders ? 'Going out today' : 'Would go out today if you turn them on'}</h3>
          ${st.due_today.length ? `<table class="tbl compact">
            <thead><tr><th>Payment</th><th>Client</th><th>Why</th><th>To</th><th class="num">Amount</th></tr></thead>
            <tbody>${st.due_today.map((r) => `
              <tr class="click" data-href="/admin/invoices/${esc(r.invoice_id)}">
                <td data-label="Payment" class="mono">${esc(r.ref)}</td><td data-label="Client">${esc(r.client_name)}</td>
                <td data-label="Why">${esc(REMINDER_KIND[r.kind])}</td><td data-label="To">${esc(r.to)}</td>
                <td data-label="Amount" class="num">${money(r.amount_cents, r.currency)}</td></tr>`).join('')}</tbody></table>`
            : '<p class="muted small">None today.</p>'}
        </div>
      </div>
    </section>`;

  clickableRows(app);
  $$('[data-role]').forEach((sel) => sel.addEventListener('change', async () => {
    const out = await busy(sel, () => api(`users/${encodeURIComponent(sel.dataset.role)}`, { method: 'POST', body: { role: sel.value } }));
    if (out) toast(`${sel.dataset.role} is now ${ROLE_TEXT[sel.value][0].toLowerCase()}`);
    settingsPage();
  }));
  $$('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Remove ${b.dataset.remove}? They're signed out straight away and can't sign in again unless someone adds them back.`)) return;
    if (await busy(b, () => api(`users/${encodeURIComponent(b.dataset.remove)}/remove`, { method: 'POST' }))) { toast('Removed'); settingsPage(); }
  }));
  $('#add-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const out = await busy(f.querySelector('button'), () => api('users', { method: 'POST', body: { email: f.email.value, name: f.name.value, role: f.role.value } }));
    if (out) { toast(`${out.user.email} added`); settingsPage(); }
  });
  $('#toggle-auto').addEventListener('click', async (e) => {
    const on = !st.reminders;
    if (on && st.due_today.length && !confirm(`Turn on reminders? ${plural(st.due_today.length, 'email')} will go out today.`)) return;
    if (await busy(e.target, () => api('settings/reminders', { method: 'POST', body: { enabled: on } }))) {
      config.reminders = on;
      toast(on ? 'Reminders on' : 'Reminders off');
      settingsPage();
    }
  });
}

// ---------- start ----------

function applyRole() {
  document.body.classList.toggle('read-only', readOnly());
  $$('[data-admin-only]', document).forEach((el) => { el.hidden = readOnly(); });
  const me = document.getElementById('me');
  if (me && config.me) me.textContent = `${config.me.email}${readOnly() ? ' · read only' : ''}`;
}

api('config').then((c) => { config = c; applyRole(); }).catch(() => {}).finally(route);
