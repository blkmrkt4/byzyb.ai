// The client's view of an invoice at /invoice/<token>: printable, with a Pay
// button for each payment that still owes money.
import { addInterval } from './ledger.mjs';

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
  if (notice === 'chosen') notices.push(`<div class="notice ok">Thank you for choosing ${esc((inv.description || 'your plan').split('\n')[0])}. Your invoice is below.${inv.stripe_link_url ? ' Set up card payments once and each payment is charged automatically.' : ''}</div>`);
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
    <p>${esc(inv.client_name)}${inv.client_address ? `<br>${esc(inv.client_address).replace(/\n/g, '<br>')}` : ''}${inv.client_email ? `<br>${esc(inv.client_email)}` : ''}</p>
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

  ${autopay(inv, { isVoid, count })}
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

// A monthly or yearly invoice with a Stripe subscription: one button sets up
// every payment, instead of paying them one at a time.
function autopay(inv, { isVoid, count }) {
  if (isVoid || !inv.stripe_link_url || inv.paid_cents || !['monthly', 'annual'].includes(inv.schedule)) return '';
  const per = inv.lines.at(-1);
  const first = inv.lines[0];
  const unit = inv.schedule === 'monthly' ? 'month' : 'year';
  if (first.amount_cents !== per.amount_cents) {
    return `
  <section class="autopay noprint">
    <div><b>Pay automatically each ${unit}</b>
      <p class="sub">Set up your card once: the first payment of ${money(first.amount_cents, inv.currency)} is charged now, then ${money(per.amount_cents, inv.currency)} each ${unit} for the ${count - 1} payments after it, then it stops. Checkout is handled securely by Stripe.</p></div>
    <a class="pay" href="${esc(inv.stripe_link_url)}">Set up ${unit === 'month' ? 'monthly' : 'yearly'} payments</a>
  </section>`;
  }
  return `
  <section class="autopay noprint">
    <div><b>Pay automatically each ${unit}</b>
      <p class="sub">Set up your card once and each of the ${count} payments of ${money(per.amount_cents, inv.currency)} is charged on its due date, then it stops. Checkout is handled securely by Stripe.</p></div>
    <a class="pay" href="${esc(inv.stripe_link_url)}">Set up ${unit === 'month' ? 'monthly' : 'yearly'} payments</a>
  </section>`;
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

// Client emails are your editable message, then a button to their page that
// can't be edited away, then a short line of fine print.
function composeEmail({ subject, message, link, button, fine }) {
  const msg = String(message || '').replace(/\r\n/g, '\n').trim();
  const text = [msg, '', `${button}: ${link}`, '', fine].join('\n');
  // Blank lines make paragraphs; a paragraph whose lines all start with "- " is a list.
  const paras = msg.split(/\n{2,}/).map((p) => {
    const lines = p.split('\n');
    if (lines.every((l) => /^\s*[-•]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${esc(l.replace(/^\s*[-•]\s+/, ''))}</li>`).join('')}</ul>`;
    return `<p>${lines.map(esc).join('<br>')}</p>`;
  }).join('\n');
  const html = `<div style="font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#25292E;max-width:560px">
${paras}
<p><a href="${esc(link)}" style="display:inline-block;background:#25292E;color:#fff;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600">${esc(button)}</a></p>
<p style="color:#616972;font-size:13px">${esc(fine)}</p>
</div>`;
  return { subject: String(subject || '').trim(), text, html };
}

// The standard wording, for you to edit before it goes.
export function invoiceEmailDraft(inv, { business }) {
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
  const what = `Here's invoice ${inv.id}${inv.description ? ` for ${inv.description.split('\n')[0]}` : ''}. The total is ${money(inv.total_cents, cur)} ${cur}${inv.hst_enabled ? ' including HST' : ''}.`;
  return {
    subject: `Invoice ${inv.id} from ${business.shortName}: ${money(inv.total_cents, cur)}`,
    message: [`Hi ${inv.client_name},`, '', [what, when].filter(Boolean).join(' '), '', 'Thanks,', business.shortName].join('\n'),
  };
}

export function invoiceEmail(inv, { business, link, subject, message }) {
  const d = invoiceEmailDraft(inv, { business });
  return composeEmail({
    subject: subject || d.subject, message: message || d.message, link,
    button: `View and pay invoice ${inv.id}`,
    fine: 'You can pay by card on that page, or print it or save it as a PDF for your records. Questions? Reply to this email.',
  });
}

// A reminder about one payment. kind: before (due soon), late1/late7/late21
// (overdue), or manual (sent by hand: worded by whether it's late yet).
export function reminderEmail(inv, line, { business, link, today }) {
  const cur = inv.currency;
  const count = inv.lines.length;
  const amount = money(line.outstanding_cents, cur);
  const what = count > 1 ? `${paymentName(line, count)} on invoice ${inv.id} (${line.ref})` : `invoice ${inv.id}`;
  const late = line.due_date && line.due_date < today;
  const days = line.due_date ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${line.due_date}T00:00:00Z`)) / 86_400_000) : null;
  let subject, lead;
  if (late) {
    subject = `Overdue: invoice ${line.ref}, ${amount}`;
    lead = `Our records show ${amount} for ${what} was due ${longDate(line.due_date)}${days > 1 ? `, ${days} days ago` : ''}, and it hasn't been paid yet.`;
  } else if (line.due_date) {
    subject = `Reminder: invoice ${line.ref} is due ${longDate(line.due_date)}`;
    lead = `A friendly reminder that ${amount} for ${what} is due ${line.due_date === today ? 'today' : longDate(line.due_date)}.`;
  } else {
    subject = `Reminder: invoice ${line.ref}, ${amount}`;
    lead = `A friendly reminder that ${amount} for ${what} is ready to pay.`;
  }
  const greeting = `Hi ${inv.client_name},`;
  const already = 'If you’ve already paid, thank you, and please ignore this email.';
  const text = [greeting, '', lead, '', `View and pay: ${link}`, '', already, 'Questions? Reply to this email.', '', business.shortName].join('\n');
  const html = `<div style="font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#25292E;max-width:560px">
<p>${esc(greeting)}</p>
<p>${esc(lead)}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#25292E;color:#fff;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600">View and pay ${esc(line.ref)}</a></p>
<p style="color:#616972;font-size:13px">${esc(already)} Questions? Reply to this email.</p>
<p>${esc(business.shortName)}</p>
</div>`;
  return { subject, text, html };
}

// ---------- plan choice ----------

// Paying a monthly plan upfront: the whole term for the price of (term − free) months.
// Returns null when the plan choice doesn't offer it for this option.
export function prepayFor(offer, opt) {
  const free = offer.prepay_free_months || 0;
  if (!free || opt.interval !== 'month' || offer.payments <= free) return null;
  const months = offer.payments;
  return { months, free, amount_cents: opt.amount_cents * (months - free), regular_cents: opt.amount_cents * months, saving_cents: opt.amount_cents * free };
}

// The service period a recurring option covers when the service already started:
// { start, end } as dates, end being the day before the term runs out.
export function servicePeriod(offer, opt) {
  if (!offer.service_start || !opt.interval) return null;
  const after = addInterval(offer.service_start, opt.interval === 'year' ? 'annual' : 'monthly', offer.payments);
  const end = new Date(Date.parse(`${after}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return { start: offer.service_start, end };
}
export const periodText = (p) => `${longDate(p.start)} to ${longDate(p.end)}`;
const dayBefore = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const shortDate = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

// When the service started before the client chooses, the months (or years)
// whose payment date has already come are billed together in the first payment.
// Returns { count, through, label } or null when nothing is behind.
export function catchUp(offer, opt, today) {
  if (!offer.service_start || !opt.interval) return null;
  const sched = opt.interval === 'year' ? 'annual' : 'monthly';
  let n = 0;
  while (n < offer.payments && addInterval(offer.service_start, sched, n) <= today) n++;
  if (n < 2) return null;
  const through = dayBefore(addInterval(offer.service_start, sched, n));
  const unit = `${opt.interval}${n === 1 ? '' : 's'}`;
  return { count: n, through, label: `${n} ${unit}: ${shortDate(offer.service_start)} to ${shortDate(through)}` };
}

const termWord = (months) => (months === 12 ? 'the year' : `all ${months} months`);
const freeWord = (n) => `${n === 1 ? '1 month' : `${n} months`} free`;

const HST_RATE = 0.13;
const per = (interval) => (interval === 'year' ? 'year' : 'month');

function planPrice(o, hst) {
  const unit = per(o.interval);
  const withTax = o.amount_cents + Math.round(o.amount_cents * HST_RATE);
  if (!o.interval) return { main: money(o.amount_cents, o.currency), unit: 'one-time', tax: hst ? `+ HST: ${money(withTax, o.currency)} in total` : '' };
  return {
    main: `${money(o.amount_cents, o.currency)}`,
    unit: `a ${unit}`,
    tax: hst ? `+ HST: ${money(withTax, o.currency)} a ${unit} in total` : '',
  };
}

// The page the client sees before choosing. Choosing posts back here and
// turns into their invoice at the same address.
export function renderPlanPage(offer, { business, token, today }) {
  const withdrawn = !!offer.cancelled_at;
  const fromLines = [business.name, ...String(business.address || '').split('\n'), business.email].filter(Boolean);
  const billing = (o) => {
    const period = servicePeriod(offer, o);
    if (period && offer.service_start > today) {
      return `Covers ${offer.payments} ${per(o.interval)}${offer.payments === 1 ? '' : 's'} of service, ${periodText(period)}. ${prepayFor(offer, o) ? 'Paying monthly, the first payment is due' : 'The first payment is due'} ${longDate(offer.service_start)}.`;
    }
    if (period) {
      const behind = catchUp(offer, o, today);
      const covers = `Covers ${offer.payments} ${per(o.interval)}${offer.payments === 1 ? '' : 's'} of service, ${periodText(period)}.`;
      if (!behind) return `${covers} ${prepayFor(offer, o) ? 'Payments start when you choose.' : 'The first payment is due when you choose.'}`;
      const paid = behind.count >= offer.payments ? 'all of it is due when you choose'
        : `paying monthly, your first payment covers those (${money(o.amount_cents * behind.count, o.currency)}), then ${money(o.amount_cents, o.currency)} a ${per(o.interval)}`;
      return `${covers} With ${behind.count} ${per(o.interval)}s already passed, ${paid}.`;
    }
    return billingFrom(o);
  };
  const billingFrom = (o) => (!o.interval ? 'One payment, due the day you choose.'
    : prepayFor(offer, o) ? `${offer.payments} months of service, starting the day you choose.`
    : `Billed ${o.interval === 'year' ? 'yearly' : 'monthly'} for ${offer.payments} ${per(o.interval)}${offer.payments === 1 ? '' : 's'}, starting the day you choose.`);
  const cards = offer.options.map((o) => {
    const price = planPrice(o, offer.hst_enabled);
    const details = String(o.details || '').split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
    return `
      <article class="plan">
        <h3>${esc(o.name)}</h3>
        <p class="price"><span class="amt">${esc(price.main)}</span> <span class="per">${esc(price.unit)}</span></p>
        ${price.tax ? `<p class="sub">${esc(price.tax)}</p>` : ''}
        <p class="sub">${esc(billing(o))}</p>
        ${details.length ? `<ul>${details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
        ${withdrawn ? '' : (() => {
          const up = prepayFor(offer, o);
          if (!up) return `<form method="post" action="/invoice/${esc(token)}/choose/${esc(o.key)}"><button class="pay" type="submit">Choose ${esc(o.name)}</button></form>`;
          return `<div class="choices">
            <form method="post" action="/invoice/${esc(token)}/choose/${esc(o.key)}"><button class="pay" type="submit">Pay monthly: ${esc(money(o.amount_cents, o.currency))} a month</button></form>
            <form method="post" action="/invoice/${esc(token)}/choose/${esc(o.key)}/year"><button class="pay yearly" type="submit">Pay for ${esc(termWord(up.months))}: ${esc(money(up.amount_cents, o.currency))}<span class="save">Get ${esc(freeWord(up.free))} · save ${esc(money(up.saving_cents, o.currency))}${offer.hst_enabled ? ' (+ HST)' : ''}</span></button></form>
          </div>`;
        })()}
      </article>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Choose your plan | ${esc(business.name)}</title>
<link rel="stylesheet" href="/invoice/assets/invoice.css">
</head>
<body>
<main class="sheet">
  ${withdrawn ? `<div class="notice bad">These options are no longer available. Email <a href="mailto:${esc(business.email)}">${esc(business.email)}</a> if you have questions.</div>` : ''}
  <header class="top">
    <div>
      <div class="brand">${esc(business.shortName)}</div>
      <address>${fromLines.map(esc).join('<br>')}${business.hstNumber ? `<br>HST no. ${esc(business.hstNumber)}` : ''}</address>
    </div>
    <div class="meta">
      <h1>Choose your plan</h1>
      <dl>
        <dt>Invoice number</dt><dd class="ref">${esc(offer.id)}</dd>
        <dt>For</dt><dd>${esc(offer.client_name)}</dd>
      </dl>
    </div>
  </header>
  ${offer.message ? `<section class="desc"><p>${esc(offer.message).replace(/\n/g, '<br>')}</p></section>` : ''}
  <section class="plans" aria-label="Plans">${cards}</section>
  <p class="sub terms">Choosing a plan creates invoice ${esc(offer.id)} for it, here at this same link, where you can pay by card.</p>
  <footer>Questions before you choose? Email <a href="mailto:${esc(business.email)}?subject=Invoice%20${esc(offer.id)}">${esc(business.email)}</a>.</footer>
</main>
</body>
</html>`;
}

export function planEmailDraft(offer, { business }) {
  const lines = offer.options.map((o) => {
    const p = planPrice(o, offer.hst_enabled);
    const up = prepayFor(offer, o);
    return `- ${o.name}: ${p.main} ${p.unit}${offer.hst_enabled ? ' + HST' : ''}${up ? `, or ${money(up.amount_cents, o.currency)} for ${termWord(up.months)} paid upfront (${freeWord(up.free)})` : ''}`;
  });
  const intro = offer.message || 'Here are the plan options. Have a look and choose the one that suits you.';
  return {
    subject: `Choose your plan: ${business.shortName} invoice ${offer.id}`,
    message: [`Hi ${offer.client_name},`, '', intro, '', ...lines, '', 'Thanks,', business.shortName].join('\n'),
  };
}

export function planEmail(offer, { business, link, subject, message }) {
  const d = planEmailDraft(offer, { business });
  return composeEmail({
    subject: subject || d.subject, message: message || d.message, link,
    button: 'See the plans and choose',
    fine: `Once you choose, invoice ${offer.id} is ready on the same page and you can pay by card. Questions? Reply to this email.`,
  });
}

// To you, when a client picks.
export function planChosenEmail(offer, option, { business, adminLink, prepay }) {
  const p = planPrice(option, offer.hst_enabled);
  const tax = offer.hst_enabled ? ' + HST' : '';
  const what = prepay
    ? `${offer.client_name} chose ${option.name} and is paying for ${termWord(prepay.months)} upfront: ${money(prepay.amount_cents, option.currency)}${tax} (${freeWord(prepay.free)}).`
    : `${offer.client_name} chose ${option.name} (${p.main} ${p.unit}${tax}).`;
  const subject = `${offer.client_name} chose ${option.name}${prepay ? ', paid upfront' : ''}`;
  const count = option.interval && !prepay ? `${offer.payments} payments` : 'one payment';
  const text = [what, '', `Invoice ${offer.id} has been created for ${count}.`, `See it: ${adminLink}`].join('\n');
  const html = `<div style="font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#25292E;max-width:560px">
<p>${esc(what)}</p><p>Invoice ${esc(offer.id)} has been created for ${esc(count)}.</p>
<p><a href="${esc(adminLink)}">See invoice ${esc(offer.id)}</a></p><p style="color:#616972;font-size:13px">${esc(business.shortName)} ledger</p></div>`;
  return { subject, text, html };
}
