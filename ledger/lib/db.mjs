import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomToken } from './ids.mjs';

// Records are never hard-deleted: invoices are voided, payments and bank lines
// are ignored or unassigned. The only DELETEs in this codebase are for expired login tokens
// and sessions.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  client_name     TEXT NOT NULL,
  client_email    TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  line_items      TEXT NOT NULL DEFAULT '[]',
  currency        TEXT NOT NULL DEFAULT 'CAD',
  subtotal_cents  INTEGER NOT NULL,
  hst_enabled     INTEGER NOT NULL DEFAULT 1,
  hst_cents       INTEGER NOT NULL,
  total_cents     INTEGER NOT NULL,
  schedule        TEXT NOT NULL DEFAULT 'one_time',
  issue_date      TEXT NOT NULL,
  sent_date       TEXT,
  sent_to         TEXT,
  sent_via        TEXT,
  voided_at       TEXT,
  void_reason     TEXT,
  notes           TEXT NOT NULL DEFAULT '',
  stripe_link_id  TEXT,
  stripe_link_url TEXT,
  public_token    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_lines (
  id           INTEGER PRIMARY KEY,
  invoice_id   TEXT NOT NULL REFERENCES invoices(id),
  suffix       INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  due_date     TEXT,
  label        TEXT NOT NULL DEFAULT '',
  pay_link_url    TEXT,
  pay_link_amount INTEGER,
  UNIQUE (invoice_id, suffix)
);

CREATE TABLE IF NOT EXISTS payments (
  id                  INTEGER PRIMARY KEY,
  source              TEXT NOT NULL,
  ref                 TEXT UNIQUE,
  stripe_type         TEXT,
  stripe_object_id    TEXT,
  stripe_event_id     TEXT,
  stripe_subscription TEXT,
  method              TEXT,
  amount_cents        INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  payer_name          TEXT,
  payer_email         TEXT,
  description         TEXT,
  invoice_ref_entered TEXT,
  metadata            TEXT NOT NULL DEFAULT '{}',
  payment_line_id     INTEGER REFERENCES payment_lines(id),
  matched_at          TEXT,
  match_method        TEXT,
  ignored_at          TEXT,
  note                TEXT,
  refunded_cents      INTEGER NOT NULL DEFAULT 0,
  dispute_cents       INTEGER NOT NULL DEFAULT 0,
  dispute_status      TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action    TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '{}'
);

-- Who may sign in. role is 'admin' (everything, including this list) or
-- 'viewer' (read only). Removing someone sets removed_at; the row is kept.
CREATE TABLE IF NOT EXISTS users (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'viewer',
  added_by   TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);

-- Payment reminder emails, one row per attempt. kind is before, late1, late7,
-- late21 (automatic) or manual.
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  line_id    INTEGER NOT NULL REFERENCES payment_lines(id),
  kind       TEXT NOT NULL,
  sent_to    TEXT NOT NULL,
  sent_at    TEXT NOT NULL,
  error      TEXT
);

CREATE TABLE IF NOT EXISTS login_tokens (
  hash       TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  hash       TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Stripe payouts and what's in them, read from the Stripe API (see lib/bank.mjs).
CREATE TABLE IF NOT EXISTS stripe_payouts (
  id              TEXT PRIMARY KEY,
  amount_cents    INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL,
  arrival_date    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  method          TEXT,
  automatic       INTEGER NOT NULL DEFAULT 1,
  description     TEXT,
  failure_message TEXT,
  txns_loaded_at  TEXT,
  txns_status     TEXT,
  synced_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stripe_txns (
  id             TEXT PRIMARY KEY,
  payout_id      TEXT,
  type           TEXT NOT NULL,
  source_id      TEXT,
  payment_intent TEXT,
  payer          TEXT,
  amount_cents   INTEGER NOT NULL,
  fee_cents      INTEGER NOT NULL DEFAULT 0,
  net_cents      INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  available_on   TEXT,
  status         TEXT,
  description    TEXT,
  synced_at      TEXT NOT NULL
);

-- Deposits imported from a bank statement CSV. match_type is 'payout' (a
-- Stripe payout id) or 'payment' (a manual payment id).
CREATE TABLE IF NOT EXISTS bank_lines (
  id           INTEGER PRIMARY KEY,
  import_id    TEXT NOT NULL,
  fingerprint  TEXT NOT NULL UNIQUE,
  date         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'CAD',
  match_type   TEXT,
  match_id     TEXT,
  matched_at   TEXT,
  match_method TEXT,
  ignored_at   TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lines_invoice   ON payment_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_reminders_line  ON reminders(line_id);
CREATE INDEX IF NOT EXISTS idx_txns_payout     ON stripe_txns(payout_id);
CREATE INDEX IF NOT EXISTS idx_bank_match      ON bank_lines(match_type, match_id);
CREATE INDEX IF NOT EXISTS idx_payments_line   ON payments(payment_line_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity    ON audit_log(entity, entity_id);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all();
const hasColumn = (db, table, name) => columns(db, table).some((c) => c.name === name);

// Bring a database created by an older version up to date. Safe to run every start.
function migrate(db) {
  if (!hasColumn(db, 'invoices', 'public_token')) db.exec('ALTER TABLE invoices ADD COLUMN public_token TEXT');
  const untokened = db.prepare('SELECT id FROM invoices WHERE public_token IS NULL').all();
  const setToken = db.prepare('UPDATE invoices SET public_token = ? WHERE id = ?');
  for (const { id } of untokened) setToken.run(randomToken(), id);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_token ON invoices(public_token)');

  for (const [col, def] of [['refunded_cents', 'INTEGER NOT NULL DEFAULT 0'], ['dispute_cents', 'INTEGER NOT NULL DEFAULT 0'], ['dispute_status', 'TEXT']]) {
    if (!hasColumn(db, 'payments', col)) db.exec(`ALTER TABLE payments ADD COLUMN ${col} ${def}`);
  }

  // Split payments can be left undated ("due on completion"), so due_date became
  // nullable and each payment got a label. SQLite can't drop NOT NULL in place,
  // so the table is rebuilt, keeping every row and ID.
  const due = columns(db, 'payment_lines').find((c) => c.name === 'due_date');
  if (due.notnull || !hasColumn(db, 'payment_lines', 'label')) {
    db.exec('PRAGMA foreign_keys = OFF');
    tx(db, () => {
      db.exec(`
        CREATE TABLE payment_lines_new (
          id           INTEGER PRIMARY KEY,
          invoice_id   TEXT NOT NULL REFERENCES invoices(id),
          suffix       INTEGER NOT NULL,
          amount_cents INTEGER NOT NULL,
          due_date     TEXT,
          label        TEXT NOT NULL DEFAULT '',
          UNIQUE (invoice_id, suffix)
        );
        INSERT INTO payment_lines_new (id, invoice_id, suffix, amount_cents, due_date)
          SELECT id, invoice_id, suffix, amount_cents, due_date FROM payment_lines;
        DROP TABLE payment_lines;
        ALTER TABLE payment_lines_new RENAME TO payment_lines;
        CREATE INDEX IF NOT EXISTS idx_lines_invoice ON payment_lines(invoice_id);`);
    });
    db.exec('PRAGMA foreign_keys = ON');
  }

  // Sign-in is per person now; older tokens and sessions without an email stop working.
  if (!hasColumn(db, 'login_tokens', 'email')) db.exec("ALTER TABLE login_tokens ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  if (!hasColumn(db, 'sessions', 'email')) db.exec("ALTER TABLE sessions ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  if (!hasColumn(db, 'audit_log', 'actor')) db.exec('ALTER TABLE audit_log ADD COLUMN actor TEXT');

  // Saved clients. Invoices keep their own copy of the name and email (what was
  // sent), plus a link to the client record.
  for (const [col, def] of [['client_id', 'INTEGER REFERENCES clients(id)'], ['client_address', "TEXT NOT NULL DEFAULT ''"], ['reminders_off', 'INTEGER NOT NULL DEFAULT 0'], ['stripe_product', 'TEXT']]) {
    if (!hasColumn(db, 'invoices', col)) db.exec(`ALTER TABLE invoices ADD COLUMN ${col} ${def}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_name ON clients(name COLLATE NOCASE)');

  // A plan choice: the client is offered a few plans and picks one, which turns
  // it into an invoice with the same number and link.
  db.exec(`CREATE TABLE IF NOT EXISTS plan_offers (
    id             TEXT PRIMARY KEY,
    client_id      INTEGER REFERENCES clients(id),
    client_name    TEXT NOT NULL,
    client_email   TEXT NOT NULL DEFAULT '',
    client_address TEXT NOT NULL DEFAULT '',
    message        TEXT NOT NULL DEFAULT '',
    options        TEXT NOT NULL,
    hst_enabled    INTEGER NOT NULL DEFAULT 1,
    payments       INTEGER NOT NULL DEFAULT 12,
    public_token   TEXT NOT NULL UNIQUE,
    sent_date      TEXT,
    sent_to        TEXT,
    chosen_key     TEXT,
    chosen_at      TEXT,
    cancelled_at   TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  )`);
  // "Pay for the year, get N months free" on monthly plans, and whether the client took it.
  for (const [col, def] of [['prepay_free_months', 'INTEGER NOT NULL DEFAULT 0'], ['chosen_prepay', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!hasColumn(db, 'plan_offers', col)) db.exec(`ALTER TABLE plan_offers ADD COLUMN ${col} ${def}`);
  }
  const orphans = db.prepare('SELECT id, client_name, client_email FROM invoices WHERE client_id IS NULL ORDER BY created_at').all();
  if (orphans.length) {
    tx(db, () => {
      const now = new Date().toISOString();
      const find = db.prepare('SELECT * FROM clients WHERE name = ? COLLATE NOCASE');
      const make = db.prepare('INSERT INTO clients (name, email, created_at, updated_at) VALUES (?, ?, ?, ?)');
      const setEmail = db.prepare("UPDATE clients SET email = ? WHERE id = ? AND email = ''");
      const link = db.prepare('UPDATE invoices SET client_id = ?, client_name = ? WHERE id = ?');
      for (const inv of orphans) {
        const name = inv.client_name.trim();
        let c = find.get(name);
        if (!c) c = { id: Number(make.run(name, inv.client_email || '', now, now).lastInsertRowid), name };
        else if (inv.client_email) setEmail.run(inv.client_email, c.id);
        link.run(c.id, c.name, inv.id);
      }
    });
  }

  // Cached fallback payment link per payment (see createLinePaymentLink). After the rebuild above.
  for (const [col, def] of [['pay_link_url', 'TEXT'], ['pay_link_amount', 'INTEGER']]) {
    if (!hasColumn(db, 'payment_lines', col)) db.exec(`ALTER TABLE payment_lines ADD COLUMN ${col} ${def}`);
  }
}

// Run fn inside a transaction. node:sqlite is synchronous, so fn must be too.
// Inside another tx, fn just joins it (all or nothing with the outer one).
const open = new WeakSet();
export function tx(db, fn) {
  if (open.has(db)) return fn();
  open.add(db);
  try { return run(db, fn); } finally { open.delete(db); }
}
function run(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
