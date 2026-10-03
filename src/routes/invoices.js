'use strict';

const express = require('express');
const dbm = require('../db');
const config = require('../config');
const auth = require('../auth');
const money = require('../money');
const service = require('../invoice-service');
const { str } = require('../validators');

const router = express.Router();

router.use(auth.requireAuth);

const TODAY = () => new Date().toISOString().slice(0, 10);
const DAYS_AHEAD = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function listCustomers(userId) {
  return dbm.get().prepare('SELECT id, name FROM customers WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId);
}

function currencyMap() {
  return Object.fromEntries(money.CURRENCY_CODES.map((c) => [c, money.currencyDigits(c)]));
}

/**
 * Parse the dynamic item rows from the form.
 * Returns { items, errors } — items hold { description, quantity, unitPriceMinor }.
 */
function parseItems(body, digits) {
  const descriptions = [].concat(body['description[]'] || []);
  const quantities = [].concat(body['quantity[]'] || []);
  const prices = [].concat(body['unit_price[]'] || []);
  const items = [];
  const errors = {};

  for (let i = 0; i < descriptions.length; i++) {
    const description = str(descriptions[i]);
    const rawQty = str(quantities[i] || '');
    const rawPrice = str(prices[i] || '');
    if (!description && !rawQty && !rawPrice) continue; // skip fully empty rows

    if (!description) {
      errors[`item_${i}`] = `Row ${i + 1}: description is required.`;
      continue;
    }
    const quantity = money.parseQuantity(rawQty);
    if (quantity === null) {
      errors[`item_${i}`] = `Row ${i + 1}: quantity must be a positive number.`;
      continue;
    }
    const unitPriceMinor = money.parseDecimalToMinor(rawPrice, digits);
    if (unitPriceMinor === null) {
      errors[`item_${i}`] = `Row ${i + 1}: unit price must be a valid non-negative amount.`;
      continue;
    }
    if (description.length > 200) {
      errors[`item_${i}`] = `Row ${i + 1}: description must be at most 200 characters.`;
      continue;
    }
    items.push({ description, quantity, unitPriceMinor });
  }
  if (items.length === 0 && Object.keys(errors).length === 0) {
    errors.items = 'Add at least one product or service line.';
  }
  return { items, errors };
}

function parseInvoiceBody(body, digits) {
  const errors = {};
  const data = {
    customerId: parseInt(body.customer_id, 10),
    issueDate: str(body.issue_date),
    dueDate: str(body.due_date),
    currency: str(body.currency).toUpperCase(),
    notes: str(body.notes).slice(0, 1000),
  };
  if (!Number.isInteger(data.customerId)) errors.customer_id = 'Choose a customer.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.issueDate)) errors.issue_date = 'Issue date is required.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.dueDate)) errors.due_date = 'Due date is required.';
  if (!errors.issue_date && !errors.dueDate && data.issueDate > data.dueDate) {
    errors.due_date = 'Due date cannot be before the issue date.';
  }
  if (!money.isValidCurrency(data.currency)) errors.currency = 'Choose a valid currency.';

  let discount = { type: 'none', valueMinor: 0, percent: 0 };
  const type = str(body.discount_type);
  if (!['none', 'fixed', 'percent'].includes(type)) {
    errors.discount_type = 'Discount type is invalid.';
  } else if (type !== 'none') {
    if (type === 'fixed') {
      const minor = money.parseDecimalToMinor(body.discount_value, digits);
      if (minor === null) errors.discount_value = 'Discount must be a valid non-negative amount.';
      else discount = { type, valueMinor: minor, percent: 0 };
    } else {
      const pct = Number(str(body.discount_value).replace(/,/g, ''));
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        errors.discount_value = 'Discount percentage must be between 0 and 100.';
      } else discount = { type, valueMinor: 0, percent: Math.round(pct * 100) / 100 };
    }
  }

  let taxRate = 0;
  const taxRaw = str(body.tax_rate);
  if (taxRaw !== '') {
    const n = Number(taxRaw.replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0 || n > 100 || !/^\d*\.?\d{0,2}$/.test(taxRaw.replace(/,/g, ''))) {
      errors.tax_rate = 'Tax rate must be a percentage between 0 and 100.';
    } else taxRate = n;
  }

  const { items, errors: itemErrors } = parseItems(body, digits);
  Object.assign(errors, itemErrors);
  return { data: { ...data, discount, taxRate, items }, errors };
}

/** Values used to re-render the form after a validation error. */
function formValuesFromInput(data) {
  return {
    customer_id: String(data.customerId || ''),
    issue_date: data.issueDate,
    due_date: data.dueDate,
    currency: data.currency,
    discount_type: data.discount.type,
    discount_value: data.discount.type === 'fixed'
      ? (data.discount.valueMinor / 100).toFixed(2)
      : String(data.discount.percent || ''),
    tax_rate: String(data.taxRate),
    notes: data.notes,
    items: data.items.map((it) => ({
      description: it.description,
      quantity: String(it.quantity),
      unit_price: (it.unitPriceMinor / Math.pow(10, money.currencyDigits(data.currency))).toFixed(
        money.currencyDigits(data.currency)
      ),
    })),
  };
}

function renderForm(req, res, { mode, invoice, values, errors }) {
  res.status(errors && Object.keys(errors).length ? 400 : 200).render('invoice_form', {
    title: mode === 'edit' ? `Edit ${invoice.number}` : 'New invoice',
    mode,
    invoice,
    customers: listCustomers(req.user.id),
    values,
    errors: errors || {},
    currencies: money.CURRENCY_CODES,
    currencyDigits: currencyMap(),
    today: TODAY(),
  });
}

router.get('/', (req, res) => {
  const db = dbm.get();
  const status = str(req.query.status);
  const q = str(req.query.q);
  const where = ['i.user_id = ?'];
  const params = [req.user.id];
  if (['draft', 'sent', 'paid', 'overdue'].includes(status)) {
    if (status === 'overdue') {
      where.push(`i.status = 'sent' AND i.due_date < date('now')`);
    } else {
      where.push('i.status = ?');
      params.push(status);
    }
  }
  if (q) {
    where.push('(i.number LIKE ? OR c.name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const invoices = db
    .prepare(
      `SELECT i.*, c.name AS customer_name,
              CASE WHEN i.status = 'sent' AND i.due_date < date('now')
                   THEN 'overdue' ELSE i.status END AS effective_status
         FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.created_at DESC, i.id DESC LIMIT 200`
    )
    .all(...params);

  const counts = { all: 0, draft: 0, sent: 0, paid: 0, overdue: 0 };
  for (const row of db
    .prepare(
      `SELECT CASE WHEN status = 'sent' AND due_date < date('now')
                   THEN 'overdue' ELSE status END AS s, COUNT(*) AS n
         FROM invoices WHERE user_id = ? GROUP BY s`
    )
    .all(req.user.id)) {
    counts[row.s] = row.n;
    counts.all += row.n;
  }

  res.render('invoices', { title: 'Invoices', invoices, counts, status, q });
});

router.get('/new', (req, res) => {
  if (!req.business) return res.redirect('/business');
  if (listCustomers(req.user.id).length === 0) {
    res.flash('Add a customer before creating your first invoice.');
    return res.redirect('/customers/new?next=/invoices/new');
  }
  renderForm(req, res, {
    mode: 'new',
    invoice: null,
    values: {
      customer_id: '',
      issue_date: TODAY(),
      due_date: DAYS_AHEAD(14),
      currency: req.business.default_currency,
      discount_type: 'none',
      discount_value: '',
      tax_rate: String(req.business.default_tax_rate),
      notes: '',
      items: [{ description: '', quantity: '1', unit_price: '' }],
    },
  });
});

router.post('/new', (req, res) => {
  const digits = money.currencyDigits(str(req.body.currency).toUpperCase());
  const { data, errors } = parseInvoiceBody(req.body, digits);
  if (Object.keys(errors).length) {
    return renderForm(req, res, { mode: 'new', invoice: null, values: formValuesFromInput(data), errors });
  }
  try {
    const invoice = service.createInvoice(req.user.id, data);
    res.flash(`Invoice ${invoice.number} created.`);
    res.redirect(`/invoices/${invoice.id}`);
  } catch (err) {
    if (err.status === 404) {
      errors.customer_id = 'Choose a customer.';
      return renderForm(req, res, { mode: 'new', invoice: null, values: formValuesFromInput(data), errors });
    }
    throw err;
  }
});

function findOwned(req, res) {
  const invoice = service.getOwned(req.user.id, req.params.id);
  if (!invoice) {
    res.status(404).render('error', { title: 'Not found', message: 'Invoice not found.' });
    return null;
  }
  return invoice;
}

router.get('/:id(\\d+)', (req, res) => {
  const full = service.getFull(req.user.id, req.params.id);
  if (!full) return res.status(404).render('error', { title: 'Not found', message: 'Invoice not found.' });
  res.render('invoice_view', {
    title: `${full.invoice.number}`,
    ...full,
    effectiveStatus: service.effectiveStatus(full.invoice),
    shareUrl: `${config.baseUrl}/share/${full.invoice.share_token}`,
  });
});

router.get('/:id(\\d+)/edit', (req, res) => {
  const invoice = findOwned(req, res);
  if (!invoice) return;
  if (invoice.status === 'paid') {
    res.flash('Paid invoices cannot be edited.', 'error');
    return res.redirect(`/invoices/${invoice.id}`);
  }
  const digits = money.currencyDigits(invoice.currency);
  const items = dbm.get()
    .prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position, id')
    .all(invoice.id);
  renderForm(req, res, {
    mode: 'edit',
    invoice,
    values: {
      customer_id: String(invoice.customer_id),
      issue_date: invoice.issue_date,
      due_date: invoice.due_date,
      currency: invoice.currency,
      discount_type: invoice.discount_type,
      discount_value: invoice.discount_type === 'fixed'
        ? (invoice.discount_value_minor / Math.pow(10, digits)).toFixed(digits)
        : invoice.discount_type === 'percent' ? String(invoice.discount_percent) : '',
      tax_rate: String(invoice.tax_rate),
      notes: invoice.notes || '',
      items: items.map((it) => ({
        description: it.description,
        quantity: String(it.quantity),
        unit_price: (it.unit_price_minor / Math.pow(10, digits)).toFixed(digits),
      })),
    },
  });
});

router.post('/:id(\\d+)/edit', (req, res) => {
  const invoice = findOwned(req, res);
  if (!invoice) return;
  if (invoice.status === 'paid') {
    res.flash('Paid invoices cannot be edited.', 'error');
    return res.redirect(`/invoices/${invoice.id}`);
  }
  const digits = money.currencyDigits(str(req.body.currency).toUpperCase());
  const { data, errors } = parseInvoiceBody(req.body, digits);
  if (Object.keys(errors).length) {
    return renderForm(req, res, { mode: 'edit', invoice, values: formValuesFromInput(data), errors });
  }
  try {
    service.updateInvoice(req.user.id, invoice.id, data);
    res.flash(`Invoice ${invoice.number} updated.`);
    res.redirect(`/invoices/${invoice.id}`);
  } catch (err) {
    if (err.status === 404) {
      errors.customer_id = 'Choose a customer.';
      return renderForm(req, res, { mode: 'edit', invoice, values: formValuesFromInput(data), errors });
    }
    throw err;
  }
});

router.post('/:id(\\d+)/status', (req, res) => {
  const to = str(req.body.action);
  try {
    const invoice = service.setStatus(req.user.id, req.params.id, to);
    const messages = {
      sent: `Invoice ${invoice.number} marked as sent.`,
      paid: `Invoice ${invoice.number} marked as paid. You can now download its receipt.`,
      draft: `Invoice ${invoice.number} moved back to draft.`,
    };
    res.flash(messages[to] || 'Status updated.');
  } catch (err) {
    if (err.status === 400 || err.status === 404) res.flash(err.message, 'error');
    else throw err;
  }
  res.redirect(`/invoices/${req.params.id}`);
});

router.post('/:id(\\d+)/delete', (req, res) => {
  const invoice = findOwned(req, res);
  if (!invoice) return;
  if (invoice.status === 'paid') {
    res.flash('Paid invoices cannot be deleted (they have issued receipts).', 'error');
    return res.redirect(`/invoices/${invoice.id}`);
  }
  dbm.get().prepare('DELETE FROM invoices WHERE id = ?').run(invoice.id);
  res.flash(`Invoice ${invoice.number} deleted.`);
  res.redirect('/invoices');
});

router.get('/:id(\\d+)/pdf', async (req, res) => {
  const full = service.getFull(req.user.id, req.params.id);
  if (!full) return res.status(404).render('error', { title: 'Not found', message: 'Invoice not found.' });
  const pdf = await require('../pdf').renderToBuffer(
    { ...full, effectiveStatus: service.effectiveStatus(full.invoice) },
    'invoice'
  );
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="invoice-${full.invoice.number}.pdf"`);
  res.send(pdf);
});

router.get('/:id(\\d+)/receipt', async (req, res) => {
  const full = service.getFull(req.user.id, req.params.id);
  if (!full) return res.status(404).render('error', { title: 'Not found', message: 'Invoice not found.' });
  if (full.invoice.status !== 'paid') {
    res.flash('Receipts are only available for paid invoices.', 'error');
    return res.redirect(`/invoices/${full.invoice.id}`);
  }
  const pdf = await require('../pdf').renderToBuffer(full, 'receipt');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${full.invoice.number}.pdf"`);
  res.send(pdf);
});

router.post('/:id(\\d+)/share/reset', (req, res) => {
  const invoice = findOwned(req, res);
  if (!invoice) return;
  service.resetShareToken(req.user.id, invoice.id);
  res.flash('A new share link was generated. The old link no longer works.');
  res.redirect(`/invoices/${invoice.id}`);
});

module.exports = router;
