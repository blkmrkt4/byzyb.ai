// Painkiller Labs admin. Plain JavaScript, no build step.
// Routes: /admin/invoices, /admin/invoices/new, /admin/invoices/:id, /admin/invoices/:id/edit

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
    if (p === '/admin/invoices') return await listPage();
    if (p === '/admin/invoices/new') return await formPage(null);
    if ((m = p.match(/^\/admin\/invoices\/([A-Za-z0-9]{4})\/edit$/))) return await formPage(m[1].toUpperCase());
    if ((m = p.match(/^\/admin\/invoices\/([A-Za-z0-9]{4})(?:-\d{2})?$/))) return await detailPage(m[1].toUpperCase());
    app.innerHTML = `<div class="empty">Page not found. <a href="/admin/invoices" data-nav>Go to invoices</a></div>`;
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
      <button class="btn btn-quiet" type="button" id="clear"${filtered ? '' : ' hidden'}>Clear</button>
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
  const newId = inv ? null : (await api('next-id')).id;
  const invNo = inv?.id || newId;
  if (inv?.voided_at) throw new Error('A void invoice can’t be edited.');
  const full = !inv || (!inv.sent_date && !inv.paid_cents && !inv.stripe_link_id);
  document.title = `${inv ? `Edit ${inv.id}` : 'New invoice'} | Painkiller Labs admin`;

  const state = {
    items: inv?.line_items?.length ? inv.line_items.map((i) => ({ ...i })) : [],
    // Editing keeps the saved payments (custom amounts, labels, blank dates) until a schedule field changes.
    linesEdited: !!inv,
    lines: inv ? inv.lines.map((l) => ({ amount_cents: l.amount_cents, due_date: l.due_date || '', label: l.label || '' })) : [],
  };
  const lockedNote = inv && !full
    ? `<div class="notice warn">This invoice has been ${inv.sent_date ? 'sent' : ''}${inv.sent_date && (inv.paid_cents || inv.stripe_link_id) ? ' or ' : ''}${inv.paid_cents ? 'paid' : inv.stripe_link_id ? 'given a Stripe link' : ''}, so only the client, description and notes can change. To change amounts, void it and create a new one.</div>`
    : '';

  app.innerHTML = `
    <a class="back" href="${inv ? `/admin/invoices/${inv.id}` : '/admin/invoices'}" data-nav>← ${inv ? inv.id : 'Invoices'}</a>
    <div class="head"><div><h1>${inv ? 'Edit invoice' : 'New invoice'}</h1><p class="muted">Invoice number <span class="mono">${esc(invNo)}</span></p></div></div>
    ${lockedNote}
    <form id="inv" class="panel stack" novalidate>
      <div class="grid2">
        <label>Client name <input name="client_name" required value="${esc(inv?.client_name)}" autocomplete="off"></label>
        <label>Client email <input name="client_email" type="email" value="${esc(inv?.client_email)}" autocomplete="off"></label>
      </div>
      <label>Description of the work <textarea name="description" rows="3">${esc(inv?.description)}</textarea></label>
      <fieldset class="plain"${full ? '' : ' disabled hidden'}>
        <div class="subpanel stack">
          <div class="head"><h2>Amount</h2><button class="btn btn-quiet btn-sm" type="button" id="add-item">Add line item</button></div>
          <div id="items"></div>
          <div class="grid3">
            <label id="subtotal-wrap">Subtotal (before tax) <input name="subtotal" inputmode="decimal" value="${inv ? centsToInput(inv.subtotal_cents) : ''}" placeholder="0.00"></label>
            <label>Currency <input name="currency" value="${esc(inv?.currency || 'CAD')}" maxlength="3"></label>
            <label>Issue date <input name="issue_date" type="date" value="${esc(inv?.issue_date || config.today)}"></label>
          </div>
          <label class="check"><input type="checkbox" name="hst_enabled"${!inv || inv.hst_enabled ? ' checked' : ''}> Charge HST at 13%</label>
          <div class="totals" id="totals"></div>
        </div>
        <div class="subpanel stack">
          <h2>Payment schedule</h2>
          <div class="grid3">
            <label>Schedule <select name="schedule">${Object.entries(SCHEDULE_LABEL).map(([k, v]) => `<option value="${k}"${(inv?.schedule || 'one_time') === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
            <label id="count-wrap">Number of payments <input name="count" type="number" min="1" max="120" value="${inv && inv.schedule !== 'one_time' ? inv.lines.length : 12}"></label>
            <label><span id="first-due-label">First payment due</span> <input name="first_due" type="date" value="${esc(inv?.lines?.[0]?.due_date || config.today)}"></label>
          </div>
          <div id="lines"></div>
        </div>
      </fieldset>
      <label>Notes <span class="muted small">(private, not shown to the client)</span><textarea name="notes" rows="2">${esc(inv?.notes)}</textarea></label>
      ${!inv ? `<label class="check" id="sub-wrap"><input type="checkbox" name="create_stripe_link"${config.stripe ? '' : ' disabled'}> Also set up automatic card payments (a Stripe subscription that charges each payment on schedule)${config.stripe ? '' : ' <span class="muted small">(Stripe isn’t connected)</span>'}</label>` : ''}
      <p class="muted small">The client pays from their invoice page, with a Pay button for each payment. You can email it once the invoice is created.</p>
      <div id="form-error"></div>
      <div class="actions"><button class="btn" type="submit">${inv ? 'Save changes' : 'Create invoice'}</button>
        <a class="btn btn-quiet" href="${inv ? `/admin/invoices/${inv.id}` : '/admin/invoices'}" data-nav>Cancel</a></div>
    </form>`;

  const f = $('#inv');

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
      client_name: f.client_name.value, client_email: f.client_email.value,
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
};
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
      <div><h1>Invoice <span class="mono-h">${esc(inv.id)}</span> ${badge(inv.status)}</h1><p class="muted">${esc(inv.client_name)}${inv.client_email ? ` · ${esc(inv.client_email)}` : ''}</p></div>
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
      <button class="btn btn-danger" data-panel="void">Void</button>
    </div>
    <div id="panel"></div>`}
    ${isVoid ? '' : `
      <div class="panel">
        <h2>Client invoice</h2>
        <p class="muted small">The client's copy of invoice ${esc(inv.id)}. They can view it, print it or save it as a PDF, and pay each payment by card. Payments made there are matched automatically.</p>
        ${config.hst_number ? '' : '<div class="notice warn small">Your HST number isn’t on invoices yet. Set HST_NUMBER on the ledger service in Railway; invoices that charge HST must show it.</div>'}
        <div class="linkbox"><input readonly value="${esc(clientLink)}" aria-label="Client invoice link"><button class="btn btn-quiet btn-sm" id="copy-client">Copy</button><a class="btn btn-quiet btn-sm" href="${esc(clientLink)}" target="_blank" rel="noopener">Open</a><button class="btn btn-sm" data-panel="email">Email to client</button></div>
      </div>`}
    ${inv.stripe_link_url ? `
      <div class="panel">
        <h2>Stripe payment link</h2>
        <p class="muted small">${inv.schedule === 'one_time' || inv.schedule === 'split' ? 'One payment' : `A ${inv.schedule === 'monthly' ? 'monthly' : 'yearly'} subscription for ${inv.lines.length} payments; it stops after the last one`}. Payments through this link are matched automatically.</p>
        <div class="linkbox"><input readonly value="${esc(inv.stripe_link_url)}" aria-label="Stripe payment link"><button class="btn btn-quiet btn-sm" id="copy-link">Copy</button><a class="btn btn-quiet btn-sm" href="${esc(inv.stripe_link_url)}" target="_blank" rel="noopener">Open</a></div>
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
          <div class="when">${esc(niceDateTime(h.at))}</div></li>`).join('')}</ul>
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
    } else if (kind === 'void') {
      if (!f.reason.value.trim()) return toast('Give a reason for voiding.', true);
      ok = await busy(btn, () => api(`invoices/${inv.id}/void`, { method: 'POST', body: { reason: f.reason.value } }));
      if (ok) toast(`Invoice ${inv.id} voided`);
    }
    if (ok) reload();
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

// ---------- start ----------

api('config').then((c) => { config = c; }).catch(() => {}).finally(route);
