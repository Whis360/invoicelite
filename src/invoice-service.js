'use strict';

/**
 * Invoice business logic: numbering, persistence, status transitions.
 * Kept separate from routes so it can be unit-tested directly.
 */

const crypto = require('crypto');
const dbm = require('./db');
const money = require('./money');

const STATUSES = ['draft', 'sent', 'paid'];
// Allowed transitions: draft -> sent/paid, sent -> paid/draft, paid -> sent.
const TRANSITIONS = {
  draft: ['sent', 'paid'],
  sent: ['paid', 'draft'],
  paid: ['sent'],
};

/** Effective status: 'sent' invoices past their due date display as 'overdue'. */
function effectiveStatus(invoice, today = new Date().toISOString().slice(0, 10)) {
  if (invoice.status === 'sent' && invoice.due_date < today) return 'overdue';
  return invoice.status;
}

/** Next sequential number for a business, e.g. INV-0007 (inside a transaction). */
function nextNumber(db, userId) {
  const row = db
    .prepare('UPDATE businesses SET invoice_seq = invoice_seq + 1 WHERE user_id = ? RETURNING invoice_prefix, invoice_seq')
    .get(userId);
  return `${row.invoice_prefix}-${String(row.invoice_seq).padStart(4, '0')}`;
}

/**
 * Create an invoice from validated input. Caller must have validated:
 *  { customerId, issueDate, dueDate, currency, items[], discount, taxRate, notes }
 * Returns the created invoice row.
 */
function createInvoice(userId, input) {
  const db = dbm.get();
  const customer = db
    .prepare('SELECT id FROM customers WHERE id = ? AND user_id = ?')
    .get(input.customerId, userId);
  if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404 });

  const totals = money.calcTotals(input.items, input.discount, input.taxRate);

  return dbm.transaction(() => {
    const number = nextNumber(db, userId);
    const shareToken = crypto.randomBytes(16).toString('base64url');
    const res = db
      .prepare(
        `INSERT INTO invoices
           (user_id, customer_id, number, status, issue_date, due_date, currency,
            discount_type, discount_value_minor, discount_percent, tax_rate,
            subtotal_minor, discount_minor, tax_minor, total_minor, notes, share_token)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        input.customerId,
        number,
        input.issueDate,
        input.dueDate,
        input.currency,
        input.discount.type,
        input.discount.type === 'fixed' ? input.discount.valueMinor : 0,
        input.discount.type === 'percent' ? input.discount.percent : 0,
        input.taxRate,
        totals.subtotalMinor,
        totals.discountMinor,
        totals.taxMinor,
        totals.totalMinor,
        input.notes || null,
        shareToken
      );
    const invoiceId = Number(res.lastInsertRowid);
    insertItems(db, invoiceId, input.items);
    return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  });
}

/** Replace items + fields of an existing invoice (draft/sent only). */
function updateInvoice(userId, invoiceId, input) {
  const db = dbm.get();
  const invoice = db
    .prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?')
    .get(invoiceId, userId);
  if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });
  if (invoice.status === 'paid') {
    throw Object.assign(new Error('Paid invoices cannot be edited'), { status: 400 });
  }
  const customer = db
    .prepare('SELECT id FROM customers WHERE id = ? AND user_id = ?')
    .get(input.customerId, userId);
  if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404 });

  const totals = money.calcTotals(input.items, input.discount, input.taxRate);

  return dbm.transaction(() => {
    db.prepare(
      `UPDATE invoices SET
         customer_id = ?, issue_date = ?, due_date = ?, currency = ?,
         discount_type = ?, discount_value_minor = ?, discount_percent = ?,
         tax_rate = ?, subtotal_minor = ?, discount_minor = ?, tax_minor = ?,
         total_minor = ?, notes = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      input.customerId,
      input.issueDate,
      input.dueDate,
      input.currency,
      input.discount.type,
      input.discount.type === 'fixed' ? input.discount.valueMinor : 0,
      input.discount.type === 'percent' ? input.discount.percent : 0,
      input.taxRate,
      totals.subtotalMinor,
      totals.discountMinor,
      totals.taxMinor,
      totals.totalMinor,
      input.notes || null,
      invoiceId
    );
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
    insertItems(db, invoiceId, input.items);
    return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  });
}

function insertItems(db, invoiceId, items) {
  const stmt = db.prepare(
    `INSERT INTO invoice_items (invoice_id, position, description, quantity, unit_price_minor, amount_minor)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  items.forEach((it, i) => {
    stmt.run(
      invoiceId,
      i,
      it.description,
      it.quantity,
      it.unitPriceMinor,
      Math.round(it.quantity * it.unitPriceMinor)
    );
  });
}

/** Transition an invoice's status. Returns the updated row. */
function setStatus(userId, invoiceId, toStatus) {
  const db = dbm.get();
  const invoice = db
    .prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?')
    .get(invoiceId, userId);
  if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });

  const from = invoice.status;
  if (!STATUSES.includes(toStatus) || !(TRANSITIONS[from] || []).includes(toStatus)) {
    throw Object.assign(
      new Error(`Cannot change an invoice from "${from}" to "${toStatus}".`),
      { status: 400 }
    );
  }
  const paidAt = toStatus === 'paid' ? new Date().toISOString() : null;
  db.prepare(
    `UPDATE invoices SET status = ?, paid_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(toStatus, paidAt, invoiceId);
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
}

function getOwned(userId, invoiceId) {
  return (
    dbm
      .get()
      .prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?')
      .get(invoiceId, userId) || null
  );
}

/** Invoice + items + customer for an owned invoice. */
function getFull(userId, invoiceId) {
  const invoice = getOwned(userId, invoiceId);
  if (!invoice) return null;
  const db = dbm.get();
  const items = db
    .prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position, id')
    .all(invoiceId);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(invoice.customer_id);
  const business = db.prepare('SELECT * FROM businesses WHERE user_id = ?').get(userId);
  return { invoice, items, customer, business };
}

/** Invoice + items + customer + business for a public share token. */
function getShared(shareToken) {
  const db = dbm.get();
  const invoice = db.prepare('SELECT * FROM invoices WHERE share_token = ?').get(shareToken);
  if (!invoice) return null;
  const items = db
    .prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position, id')
    .all(invoice.id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(invoice.customer_id);
  const business = db.prepare('SELECT * FROM businesses WHERE user_id = ?').get(invoice.user_id);
  return { invoice, items, customer, business };
}

/** Regenerate the share token (invalidates the old public link). */
function resetShareToken(userId, invoiceId) {
  const db = dbm.get();
  const invoice = getOwned(userId, invoiceId);
  if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });
  const token = crypto.randomBytes(16).toString('base64url');
  db.prepare('UPDATE invoices SET share_token = ? WHERE id = ?').run(token, invoiceId);
  return token;
}

module.exports = {
  STATUSES,
  TRANSITIONS,
  effectiveStatus,
  nextNumber,
  createInvoice,
  updateInvoice,
  setStatus,
  getOwned,
  getFull,
  getShared,
  resetShareToken,
};
