'use strict';

/**
 * Database layer. Uses the built-in node:sqlite module (no native deps).
 * All monetary amounts are stored as INTEGER minor units (e.g. cents)
 * consistent with each invoice's currency — never floats.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  flash      TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS businesses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  email            TEXT,
  phone            TEXT,
  address          TEXT,
  tax_id           TEXT,
  logo_path        TEXT,
  default_currency TEXT NOT NULL DEFAULT 'USD',
  invoice_prefix   TEXT NOT NULL DEFAULT 'INV',
  invoice_seq      INTEGER NOT NULL DEFAULT 0,
  default_tax_rate REAL NOT NULL DEFAULT 0,
  payment_details  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT,
  phone      TEXT,
  address    TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_user ON customers(user_id);

CREATE TABLE IF NOT EXISTS invoices (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id         INTEGER NOT NULL REFERENCES customers(id),
  number              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','sent','paid')),
  issue_date          TEXT NOT NULL,
  due_date            TEXT NOT NULL,
  currency            TEXT NOT NULL,
  discount_type       TEXT NOT NULL DEFAULT 'none'
                      CHECK (discount_type IN ('none','fixed','percent')),
  discount_value_minor INTEGER NOT NULL DEFAULT 0,
  discount_percent    REAL NOT NULL DEFAULT 0,
  tax_rate            REAL NOT NULL DEFAULT 0,
  subtotal_minor      INTEGER NOT NULL,
  discount_minor      INTEGER NOT NULL,
  tax_minor           INTEGER NOT NULL,
  total_minor         INTEGER NOT NULL,
  notes               TEXT,
  share_token         TEXT UNIQUE,
  paid_at             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_share ON invoices(share_token);

CREATE TABLE IF NOT EXISTS invoice_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id       INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL DEFAULT 0,
  description      TEXT NOT NULL,
  quantity         REAL NOT NULL,
  unit_price_minor INTEGER NOT NULL,
  amount_minor     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_invoice ON invoice_items(invoice_id);
`;

let db = null;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

function get() {
  if (!db) throw new Error('Database not initialised — call db.init() first');
  return db;
}

/** Run fn inside a transaction; rolls back if fn throws. */
function transaction(fn) {
  get().exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    get().exec('COMMIT');
    return result;
  } catch (err) {
    get().exec('ROLLBACK');
    throw err;
  }
}

module.exports = { init, get, transaction };
