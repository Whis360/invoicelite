'use strict';

const express = require('express');
const dbm = require('../db');
const auth = require('../auth');
const money = require('../money');
const service = require('../invoice-service');

const router = express.Router();

router.get('/', auth.requireAuth, (req, res) => {
  const db = dbm.get();
  const business = req.business;
  if (!business) return res.redirect('/business');

  // Totals grouped by currency — invoices may use different currencies, so we
  // aggregate honestly per currency rather than inventing exchange rates.
  const byCurrency = db
    .prepare(
      `SELECT currency,
              SUM(CASE WHEN status != 'draft' THEN total_minor ELSE 0 END) AS invoiced,
              SUM(CASE WHEN status = 'paid' THEN total_minor ELSE 0 END) AS paid,
              SUM(CASE WHEN status = 'sent' THEN total_minor ELSE 0 END) AS outstanding,
              SUM(CASE WHEN status = 'sent' AND due_date < date('now') THEN total_minor ELSE 0 END) AS overdue,
              COUNT(*) AS n
         FROM invoices WHERE user_id = ?
        GROUP BY currency`
    )
    .all(req.user.id);

  const main = byCurrency.find((r) => r.currency === business.default_currency)
    || byCurrency[0]
    || { currency: business.default_currency, invoiced: 0, paid: 0, outstanding: 0, overdue: 0, n: 0 };
  const others = byCurrency.filter((r) => r.currency !== main.currency);
  const fmt = (m, c) => money.formatMoney(m || 0, c);

  const recent = db
    .prepare(
      `SELECT i.*, c.name AS customer_name,
              CASE WHEN i.status = 'sent' AND i.due_date < date('now')
                   THEN 'overdue' ELSE i.status END AS effective_status
         FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE i.user_id = ? ORDER BY i.created_at DESC, i.id DESC LIMIT 8`
    )
    .all(req.user.id);

  const totalInvoices = db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE user_id = ?').get(req.user.id).n;
  const totalCustomers = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE user_id = ?').get(req.user.id).n;

  res.render('dashboard', {
    title: 'Dashboard',
    main,
    others,
    fmt,
    recent,
    effective: (row) => service.effectiveStatus(row),
    totalInvoices,
    totalCustomers,
  });
});

module.exports = router;
