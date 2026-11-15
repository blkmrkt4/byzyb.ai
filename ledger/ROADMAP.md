# Ledger roadmap

The plan for turning the ledger into a complete small-business invoicing system.
Agreed 2026-11-14. Tick items off here as they ship.

## Phase 1: send invoices and collect money properly

- [x] **1. Client invoice page.** A private link per invoice (`/invoice/<token>`) that the client
      can open, print or save as PDF. Shows Painkiller Labs Inc.'s business details and HST
      number, invoice number, bill-to, line items, subtotal, HST, total, paid, balance, and the
      payment schedule with a Pay button for each open payment. Admin can copy the link, open it,
      or email it to the client (Resend), which also marks the invoice as sent.
- [x] **2. Split payments of any amount.** Each payment has its own Stripe checkout for whatever
      is still owed on it, so uneven splits work (no subscription needed). New "Split" schedule:
      deposit plus balance by default, with labels ("Deposit", "Final payment"), custom amounts,
      and payments that can be left undated ("due on completion") until admin sets a date.
      The client sees "Payment 1 of 3 · Deposit". Fewer payments land in Unmatched because
      every checkout carries the invoice and payment number.
- [x] **Refund and dispute fix.** Handle Stripe `charge.refunded`, `charge.dispute.created` and
      `charge.dispute.closed`. A refunded or disputed payment stops counting as paid (a won
      dispute counts again), and the invoice and payment rows show what happened.

## Phase 2: see who has paid at a glance

- [x] **3. Dashboard (opens first).** Owed to you now, overdue and by whom, due in the next 30
      days, received this month. Aged receivables (current, 1–30, 31–60, 60+ days late) and a
      balance per client.
- [x] **4. Printable reports.** Receivables report; payments received for a date range with HST
      collected (for HST filing); client statement; a payments CSV alongside the invoices CSV.

## Phase 3: match to the bank

- [x] **5. Bank reconciliation.** Pull Stripe payouts and balance transactions so each bank
      deposit breaks down into the payments in it minus Stripe fees. Show money collected but
      not yet deposited, and total fees for the books. Manual e-transfers and cheques appear in
      the same view. Later: import a bank statement CSV and tick deposits off automatically.

Shipped 2026-11-14: Bank page at /admin/bank. Syncs Stripe payouts and balance
transactions (needs Balance, Payouts and Charges: Read on the restricted key), shows each
deposit's payments and fees, money Stripe is still holding, Stripe fees for the period, and
manual e-transfers/cheques/cash. Bank statement CSV import (RBC, TD and generic formats)
auto-matches deposits to payouts and manual payments; the rest are matched by hand or marked
"not a client payment". CSV export per payout item for the accountant.

## Phase 4: smaller fixes

- [x] **Saved clients.** A clients table with email and billing address, chosen from a list, so
      one client can't split into two names with separate balances.
- [x] **Payment reminders.** Automatic emails a few days before a payment is due and when it
      goes overdue.
- [x] **Duplicate invoice.** Start a new invoice from an old one for repeat work.

## Access control

- [x] **Access list with roles.** Only listed people get sign-in links. Admins manage the list
      at /admin/settings; read-only people can see everything except the list and change nothing.

## Shipped notes

- Phase 1 shipped 2026-11-14. Pay buttons use Stripe Checkout when the key allows it and fall
  back to a payment link per payment otherwise. Refunds and disputes need the Stripe webhook
  to send `charge.refunded` and `charge.dispute.*` events. The HST number comes from the
  `HST_NUMBER` variable on the Railway service.
- Phase 2 shipped 2026-11-14. Dashboard at /admin/dashboard (signing in lands there) with a
  "Finish setting up" checklist for the Stripe webhook events, the Checkout key permission
  and the HST number. Reports at /admin/reports: receivables, payments and HST (with HST
  charged on invoices issued in the period), client statements, CSV exports, print layouts.
- Phase 3 shipped 2026-11-14 (see the Bank notes above).
- Phase 4 and access control shipped 2026-11-15. Saved clients at /admin/clients (rename,
  merge, billing address on invoices). Payment reminders: off until an admin turns them on in
  Settings; 3 days before due, then 1, 7 and 21 days late, 9 am to 6 pm Toronto; per-invoice
  opt-out and "Send a reminder now". Duplicate invoice from any invoice page. The first admins
  come from the ADMIN_EMAILS variable, used only when the access list is empty.
