'use strict';

const express = require('express');
const dbm = require('../db');
const auth = require('../auth');
const { validate, validators: v, str } = require('../validators');

const router = express.Router();

router.use(auth.requireAuth);

function listCustomers(userId) {
  const db = dbm.get();
  return db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id) AS invoice_count
         FROM customers c WHERE c.user_id = ? ORDER BY c.name COLLATE NOCASE`
    )
    .all(userId);
}

function validateCustomer(body) {
  return validate(
    {
      name: v.required('Customer name'),
      email: v.email('Customer email'),
      phone: v.text('Phone', 40),
      address: v.text('Address', 400),
      notes: v.text('Notes', 500),
    },
    body
  );
}

router.get('/', (req, res) => {
  res.render('customers', { title: 'Customers', customers: listCustomers(req.user.id) });
});

router.get('/new', (req, res) => {
  res.render('customer_form', {
    title: 'New customer',
    customer: {},
    errors: {},
    next: str(req.query.next),
  });
});

router.post('/new', (req, res) => {
  const { data, errors } = validateCustomer(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('customer_form', {
      title: 'New customer',
      customer: req.body,
      errors,
      next: str(req.body.next),
    });
  }
  const result = dbm
    .get()
    .prepare('INSERT INTO customers (user_id, name, email, phone, address, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, data.name, data.email, data.phone, data.address, data.notes);
  res.flash('Customer added.');
  const next = str(req.body.next);
  res.redirect(next && next.startsWith('/') && !next.startsWith('//') ? next : '/customers');
});

router.get('/:id/edit', (req, res) => {
  const customer = dbm
    .get()
    .prepare('SELECT * FROM customers WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!customer) return res.status(404).render('error', { title: 'Not found', message: 'Customer not found.' });
  res.render('customer_form', { title: 'Edit customer', customer, errors: {}, next: '' });
});

router.post('/:id/edit', (req, res) => {
  const db = dbm.get();
  const customer = db
    .prepare('SELECT * FROM customers WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!customer) return res.status(404).render('error', { title: 'Not found', message: 'Customer not found.' });
  const { data, errors } = validateCustomer(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('customer_form', {
      title: 'Edit customer',
      customer: { ...customer, ...req.body },
      errors,
      next: '',
    });
  }
  db.prepare('UPDATE customers SET name=?, email=?, phone=?, address=?, notes=? WHERE id=?')
    .run(data.name, data.email, data.phone, data.address, data.notes, customer.id);
  res.flash('Customer updated.');
  res.redirect('/customers');
});

router.post('/:id/delete', (req, res) => {
  const db = dbm.get();
  const customer = db
    .prepare('SELECT * FROM customers WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!customer) return res.status(404).render('error', { title: 'Not found', message: 'Customer not found.' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ?').get(customer.id).n;
  if (count > 0) {
    res.flash(`Cannot delete ${customer.name}: ${count} invoice(s) reference this customer.`, 'error');
  } else {
    db.prepare('DELETE FROM customers WHERE id = ?').run(customer.id);
    res.flash('Customer deleted.');
  }
  res.redirect('/customers');
});

module.exports = router;
