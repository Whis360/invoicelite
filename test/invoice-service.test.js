'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dbm = require('../src/db');
const service = require('../src/invoice-service');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoicelite-test-'));
  return dbm.init(path.join(dir, 'test.db'));
}

function seedBusiness(db) {
  const user = db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
    .run('owner@example.com', 'x', 'Owner');
  const userId = Number(user.lastInsertRowid);
  db.prepare(
    `INSERT INTO businesses (user_id, name, default_currency, invoice_prefix)
     VALUES (?, 'Acme Ltd', 'USD', 'INV')`
  ).run(userId);
  const customer = db.prepare(
    'INSERT INTO customers (user_id, name) VALUES (?, ?)'
  ).run(userId, 'Test Customer');
  return { userId, customerId: Number(customer.lastInsertRowid) };
}

const validInput = (customerId) => ({
  customerId,
  issueDate: '2026-01-10',
  dueDate: '2026-01-24',
  currency: 'USD',
  items: [{ description: 'Consulting', quantity: 2, unitPriceMinor: 15000 }],
  discount: { type: 'none', valueMinor: 0, percent: 0 },
  taxRate: 0,
  notes: '',
});

test('invoice numbers increment sequentially per business (INV-0001, INV-0002…)', () => {
  const db = freshDb();
  const { userId, customerId } = seedBusiness(db);
  const a = service.createInvoice(userId, validInput(customerId));
  const b = service.createInvoice(userId, validInput(customerId));
  assert.strictEqual(a.number, 'INV-0001');
  assert.strictEqual(b.number, 'INV-0002');
});

test('numbers stay unique and never collide or go backwards', () => {
  const db = freshDb();
  const { userId, customerId } = seedBusiness(db);
  const numbers = new Set();
  for (let i = 0; i < 25; i++) {
    const inv = service.createInvoice(userId, validInput(customerId));
    assert.ok(!numbers.has(inv.number), `duplicate number ${inv.number}`);
    numbers.add(inv.number);
  }
  const seq = db.prepare('SELECT invoice_seq FROM businesses WHERE user_id = ?').get(userId).invoice_seq;
  assert.strictEqual(seq, 25);
});

test('totals are persisted in minor units and survive a round-trip', () => {
  const db = freshDb();
  const { userId, customerId } = seedBusiness(db);
  const input = validInput(customerId);
  input.items = [{ description: 'Design', quantity: 3, unitPriceMinor: 9999 }];
  input.discount = { type: 'percent', percent: 12.5 };
  input.taxRate = 7.5;
  const inv = service.createInvoice(userId, input);
  // subtotal 29997, discount 3749.625 -> 3750, taxable 26247, tax 1968.525 -> 1969, total 28216
  assert.strictEqual(inv.subtotal_minor, 29997);
  assert.strictEqual(inv.discount_minor, 3750);
  assert.strictEqual(inv.tax_minor, 1969);
  assert.strictEqual(inv.total_minor, 28216);
});

test('status transitions follow the allowed map and set paid_at', () => {
  const db = freshDb();
  const { userId, customerId } = seedBusiness(db);
  const inv = service.createInvoice(userId, validInput(customerId));

  assert.strictEqual(service.setStatus(userId, inv.id, 'sent').status, 'sent');
  const paid = service.setStatus(userId, inv.id, 'paid');
  assert.strictEqual(paid.status, 'paid');
  assert.ok(paid.paid_at, 'paid_at should be set');

  assert.throws(() => service.setStatus(userId, inv.id, 'paid'), /Cannot change/);
  assert.strictEqual(service.setStatus(userId, inv.id, 'sent').status, 'sent');
  assert.strictEqual(service.setStatus(userId, inv.id, 'draft').status, 'draft');
  assert.throws(() => service.setStatus(userId, inv.id, 'draft'), /Cannot change/);
});

test('effectiveStatus marks past-due sent invoices as overdue', () => {
  const db = freshDb();
  const { userId, customerId } = seedBusiness(db);
  const input = validInput(customerId);
  input.issueDate = '2026-01-01';
  input.dueDate = '2026-01-15';
  const inv = service.createInvoice(userId, input);
  service.setStatus(userId, inv.id, 'sent');

  assert.strictEqual(service.effectiveStatus({ status: 'sent', due_date: '2026-01-15' }, '2026-01-16'), 'overdue');
  assert.strictEqual(service.effectiveStatus({ status: 'sent', due_date: '2026-01-15' }, '2026-01-15'), 'sent');
  assert.strictEqual(service.effectiveStatus({ status: 'paid', due_date: '2025-01-01' }, '2026-01-16'), 'paid');
  assert.strictEqual(service.effectiveStatus({ status: 'draft', due_date: '2020-01-01' }, '2026-01-16'), 'draft');
});

test('paid invoices refuse edits; drafts and sent allow them', () => {
  const db = freshDb();
  const { userId, customerId } = seedBusiness(db);
  const inv = service.createInvoice(userId, validInput(customerId));
  const input = validInput(customerId);
  input.items = [{ description: 'Changed work', quantity: 1, unitPriceMinor: 100 }];

  service.updateInvoice(userId, inv.id, input);
  assert.strictEqual(service.getOwned(userId, inv.id).total_minor, 100);

  service.setStatus(userId, inv.id, 'sent');
  service.setStatus(userId, inv.id, 'paid');
  assert.throws(() => service.updateInvoice(userId, inv.id, input), /Paid invoices cannot be edited/);
});

test('share tokens work and resetting invalidates the old token', () => {
  const db = freshDb();
  const { userId, customerId } = seedBusiness(db);
  const inv = service.createInvoice(userId, validInput(customerId));
  const first = inv.share_token;
  assert.ok(first && first.length >= 20);
  assert.strictEqual(service.getShared(first).invoice.id, inv.id);

  const second = service.resetShareToken(userId, inv.id);
  assert.notStrictEqual(second, first);
  assert.strictEqual(service.getShared(first), null);
  assert.strictEqual(service.getShared(second).invoice.id, inv.id);
});

test('items are replaced (not duplicated) on update', () => {
  const db = freshDb();
  const { userId, customerId } = seedBusiness(db);
  const inv = service.createInvoice(userId, validInput(customerId));
  const input = validInput(customerId);
  input.items = [
    { description: 'A', quantity: 1, unitPriceMinor: 100 },
    { description: 'B', quantity: 2, unitPriceMinor: 200 },
  ];
  service.updateInvoice(userId, inv.id, input);
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position').all(inv.id);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[1].description, 'B');
});
