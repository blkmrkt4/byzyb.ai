// The client's view of an invoice at /invoice/<token>: printable, with a Pay
// button for each payment that still owes money.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function money(cents, currency = 'CAD') {
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function longDate(d) {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// "Payment 1 of 3 · Deposit", or just the label for a single payment.
export function paymentName(line, count) {
  const of = count > 1 ? `Payment ${line.suffix} of ${count}` : 'Payment';
  return line.label ? `${of} · ${line.label}` : of;
}

function lineStatus(l, today, isVoid) {
  if (l.outstanding_cents === 0) return { cls: 'paid', text: `Paid${l.paid_at ? ` ${longDate(l.paid_at)}` : ''}` };
  if (isVoid) return { cls: 'void', text: 'Cancelled' };
  if (l.paid_cents > 0) return { cls: 'part', text: `${money(l.outstanding_cents, l.currency)} left to pay` };
  if (!l.due_date) return { cls: 'later', text: 'Due on completion' };
  if (l.due_date < today) return { cls: 'late', text: 'Overdue' };
  return { cls: 'due', text: 'Due' };
}

export function renderInvoicePage(inv, { business, today, token, canPay, notice }) {
  const cur = inv.currency;
  const isVoid = !!inv.voided_at;
  const count = inv.lines.length;
  const open = inv.lines.filter((l) => l.outstanding_cents > 0);
  const nextDue = open.find((l) => l.due_date) || open[0];
  const headline = isVoid ? { cls: 'void', text: 'Cancelled' }
    : inv.outstanding_cents === 0 ? { cls: 'paid', text: 'Paid in full' }
    : { cls: 'due', text: `${money(inv.outstanding_cents, cur)} to pay` };

  const items = inv.line_items.length
    ? inv.line_items.map((i) => `<tr><td>${esc(i.description)}</td><td class="num">${money(i.amount_cents, cur)}</td></tr>`).join('')
    : `<tr><td>${inv.description ? esc(inv.description.split('\n')[0]) : 'Services'}</td><td class="num">${money(inv.subtotal_cents, cur)}</td></tr>`;

  const schedule = inv.lines.map((l) => {
    const st = lineStatus({ ...l, currency: cur }, today, isVoid);
    const pay = canPay && !isVoid && l.outstanding_cents > 0
      ? `<form method="post" action="/invoice/${esc(token)}/pay/${String(l.suffix).padStart(2, '0')}" class="noprint">
           <button class="pay" type="submit">Pay ${money(l.outstanding_cents, cur)}</button></form>`
      : '';
    return `
      <tr>
        <td><div class="ref">${esc(l.ref)}</div><div class="sub">${esc(paymentName(l, count))}</div></td>
        <td>${l.due_date ? esc(longDate(l.due_date)) : '<span class="sub">On completion</span>'}</td>
        <td class="num">${money(l.amount_cents, cur)}</td>
        <td><span class="st ${st.cls}">${esc(st.text)}</span></td>
        <td class="act">${pay}</td>
      </tr>`;
  }).join('');

  const fromLines = [business.name, ...String(business.address || '').split('\n'), business.email].filter(Boolean);
  const notices = [];
  if (notice === 'paid') notices.push('<div class="notice ok">Thank you. Your payment went through, and a receipt is on its way by email. It can take a minute to show here.</div>');
  if (notice === 'nopay') notices.push('<div class="notice warn">Online payment isn’t available right now. Please try again later, or reply to the invoice email.</div>');
  if (isVoid) notices.push('<div class="notice bad">This invoice was cancelled and doesn’t need to be paid.</div>');

  const howToPay = isVoid || inv.outstanding_cents === 0 || !(canPay || business.etransferEmail) ? '' : `
    <section class="how">
      <h2>How to pay</h2>
      <ul>
        ${canPay ? `<li><b>By card:</b> press Pay next to a payment above. Checkout is handled securely by Stripe, and you get a receipt by email.</li>` : ''}
        ${business.etransferEmail ? `<li><b>By Interac e-Transfer:</b> send it to ${esc(business.etransferEmail)} and put the payment number (for example ${esc(nextDue.ref)}) in the message.</li>` : ''}
        <li class="printonly">Pay online at ${esc(business.publicUrl)}/invoice/${esc(token)}</li>
      </ul>
    </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Invoice ${esc(inv.id)} | ${esc(business.name)}</title>
<link rel="stylesheet" href="/invoice/assets/invoice.css">
</head>
<body>
<div class="toolbar noprint">
  <span>Invoice ${esc(inv.id)} from ${esc(business.shortName)}</span>
  <button type="button" id="print">Print or save as PDF</button>
</div>
<main class="sheet">
  ${notices.join('')}
  <header class="top">
    <div>
      <div class="brand">${esc(business.shortName)}</div>
      <address>${fromLines.map(esc).join('<br>')}${business.hstNumber ? `<br>HST no. ${esc(business.hstNumber)}` : ''}</address>
    </div>
    <div class="meta">
      <h1>Invoice</h1>
      <dl>
        <dt>Invoice number</dt><dd class="ref">${esc(inv.id)}</dd>
        <dt>Issue date</dt><dd>${esc(longDate(inv.issue_date))}</dd>
        ${!isVoid && nextDue?.due_date && inv.outstanding_cents ? `<dt>Next payment due</dt><dd>${esc(longDate(nextDue.due_date))}</dd>` : ''}
      </dl>
      <div class="headline ${headline.cls}">${esc(headline.text)}</div>
    </div>
  </header>

  <section class="billto">
    <h2>Bill to</h2>
    <p>${esc(inv.client_name)}${inv.client_email ? `<br>${esc(inv.client_email)}` : ''}</p>
  </section>

  ${inv.description ? `<section class="desc"><h2>For</h2><p>${esc(inv.description).replace(/\n/g, '<br>')}</p></section>` : ''}

  <table class="items">
    <thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
    <tbody>${items}</tbody>
  </table>
  <dl class="totals">
    <dt>Subtotal</dt><dd>${money(inv.subtotal_cents, cur)}</dd>
    <dt>${inv.hst_enabled ? 'HST 13%' : 'HST'}</dt><dd>${inv.hst_enabled ? money(inv.hst_cents, cur) : 'Not charged'}</dd>
    <dt class="grand">Total (${esc(cur)})</dt><dd class="grand">${money(inv.total_cents, cur)}</dd>
    ${inv.paid_cents ? `<dt>Paid</dt><dd>−${money(inv.paid_cents, cur)}</dd>` : ''}
    ${!isVoid ? `<dt class="grand">Balance due</dt><dd class="grand">${money(inv.outstanding_cents, cur)}</dd>` : ''}
  </dl>

  <section class="schedule">
    <h2>${count > 1 ? `Payment schedule · ${count} payments` : 'Payment'}</h2>
    <table>
      <thead><tr><th>Payment number</th><th>Due</th><th class="num">Amount</th><th>Status</th><th class="act"><span class="vh">Pay</span></th></tr></thead>
      <tbody>${schedule}</tbody>
    </table>
  </section>
  ${howToPay}
  <footer>Questions about this invoice? Email <a href="mailto:${esc(business.email)}?subject=Invoice%20${esc(inv.id)}">${esc(business.email)}</a>.</footer>
</main>
<script src="/invoice/assets/invoice.js"></script>
</body>
</html>`;
}

export function renderNotFound(business) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Invoice not found | ${esc(business.name)}</title>
<link rel="stylesheet" href="/invoice/assets/invoice.css"></head>
<body><main class="sheet"><h1>Invoice not found</h1>
<p>This invoice link doesn’t work. Check that you copied the whole link, or email <a href="mailto:${esc(business.email)}">${esc(business.email)}</a> and we’ll send it again.</p></main></body></html>`;
}

// ---------- email ----------

export function invoiceEmail(inv, { business, link }) {
  const cur = inv.currency;
  const open = inv.lines.filter((l) => l.outstanding_cents > 0);
  const first = open[0];
  const count = inv.lines.length;
  let when = '';
  if (first) {
    const due = first.due_date ? `due ${longDate(first.due_date)}` : 'due on completion';
    when = count > 1
      ? `It's paid in ${count} payments. ${paymentName(first, count)} (${first.ref}), ${money(first.outstanding_cents, cur)}, is ${due}.`
      : `${money(first.outstanding_cents, cur)} is ${due}.`;
  }
  const subject = `Invoice ${inv.id} from ${business.shortName}: ${money(inv.total_cents, cur)}`;
  const greeting = `Hi ${inv.client_name},`;
  const what = `Here's invoice ${inv.id}${inv.description ? ` for ${inv.description.split('\n')[0]}` : ''}. The total is ${money(inv.total_cents, cur)} ${cur}${inv.hst_enabled ? ' including HST' : ''}.`;
  const text = [greeting, '', what, when, '', `View and pay the invoice: ${link}`, '',
    'You can pay by card on that page, or print it or save it as a PDF for your records.', '',
    `Questions? Reply to this email.`, '', business.shortName].filter((l) => l !== null).join('\n');
  const html = `<div style="font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#25292E;max-width:560px">
<p>${esc(greeting)}</p>
<p>${esc(what)}</p>
${when ? `<p>${esc(when)}</p>` : ''}
<p><a href="${esc(link)}" style="display:inline-block;background:#25292E;color:#fff;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600">View and pay invoice ${esc(inv.id)}</a></p>
<p style="color:#616972;font-size:13px">You can pay by card on that page, or print it or save it as a PDF for your records. Questions? Reply to this email.</p>
<p>${esc(business.shortName)}</p>
</div>`;
  return { subject, text, html };
}
