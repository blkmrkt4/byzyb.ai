import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomToken } from './ids.mjs';

// Records are never hard-deleted: invoices are voided, payments are ignored or
// unassigned. The only DELETEs in this codebase are for expired login tokens
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

CREATE INDEX IF NOT EXISTS idx_lines_invoice   ON payment_lines(invoice_id);
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

  // Cached fallback payment link per payment (see createLinePaymentLink). After the rebuild above.
  for (const [col, def] of [['pay_link_url', 'TEXT'], ['pay_link_amount', 'INTEGER']]) {
    if (!hasColumn(db, 'payment_lines', col)) db.exec(`ALTER TABLE payment_lines ADD COLUMN ${col} ${def}`);
  }
}

// Run fn inside a transaction. node:sqlite is synchronous, so fn must be too.
export function tx(db, fn) {
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
