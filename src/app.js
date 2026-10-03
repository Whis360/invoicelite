'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const db = require('./db');
const money = require('./money');
const auth = require('./auth');

function createApp(options = {}) {
  db.init(options.dbPath || config.dbPath);

  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));

  // extended:false keeps form keys verbatim (e.g. "description[]" for item rows).
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '1d' }));

  app.use(auth.sessionMiddleware);
  app.use(auth.csrfMiddleware);
  app.use(auth.userMiddleware);

  // View helpers + per-request locals.
  app.use((req, res, next) => {
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.path = req.path;
    res.locals.flash = req.session.flash || null;
    if (req.session.flash) auth.clearFlash(req);
    res.locals.fmtMoney = (m, c) => money.formatMoney(m, c);
    res.locals.fmtDate = (iso) => {
      if (!iso) return '—';
      const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) return iso;
      return new Intl.DateTimeFormat('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
      }).format(d);
    };
    next();
  });

  // Flash helper for redirects — must be attached before routes run.
  app.use((req, res, next) => {
    res.flash = (message, type = 'success') => auth.setFlash(req, message, type);
    next();
  });

  // Each router is mounted under its path prefix so its router-level
  // requireAuth guard only applies to its own routes (public share pages,
  // health check etc. stay open).
  app.use('/', require('./routes/auth-routes'));
  app.use('/business', require('./routes/business'));
  app.use('/customers', require('./routes/customers'));
  app.use('/invoices', require('./routes/invoices'));
  app.use('/dashboard', require('./routes/dashboard'));
  app.use('/', require('./routes/public'));

  // 404
  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'The page you are looking for does not exist.' });
  });

  // Central error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN' || err.status === 403) {
      return res.status(403).render('error', { title: 'Request blocked', message: 'Invalid or missing CSRF token.' });
    }
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).render('error', {
      title: status === 500 ? 'Something went wrong' : 'Error',
      message: status === 500 ? 'An unexpected error occurred. Please try again.' : err.message,
    });
  });

  return app;
}

module.exports = { createApp };
