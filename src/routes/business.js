'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const dbm = require('../db');
const config = require('../config');
const auth = require('../auth');
const money = require('../money');
const { validate, validators: v, str } = require('../validators');

const router = express.Router();

const LOGO_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
});

router.use(auth.requireAuth);

function businessValues(body) {
  return {
    name: str(body.name),
    email: str(body.email),
    phone: str(body.phone),
    address: str(body.address),
    tax_id: str(body.tax_id),
    default_currency: str(body.default_currency).toUpperCase(),
    invoice_prefix: str(body.invoice_prefix).toUpperCase(),
    default_tax_rate: str(body.default_tax_rate),
    payment_details: str(body.payment_details),
  };
}

function validateBusiness(body, file) {
  const errors = {};
  const { data, errors: errs } = validate(
    {
      name: v.required('Business name'),
      email: v.email('Business email'),
      phone: v.text('Phone', 40),
      address: v.text('Address', 400),
      tax_id: v.text('Tax ID / VAT number', 60),
      default_currency: (val) => {
        const code = str(val).toUpperCase();
        if (!money.isValidCurrency(code)) return { error: 'Choose a valid currency.' };
        return { value: code };
      },
      invoice_prefix: (val) => {
        const p = str(val).toUpperCase();
        if (!/^[A-Z0-9-]{1,10}$/.test(p)) {
          return { error: 'Prefix must be 1–10 letters, numbers or dashes.' };
        }
        return { value: p };
      },
      default_tax_rate: (val) => {
        const s = str(val);
        if (s === '') return { value: 0 };
        const n = Number(s.replace(/,/g, ''));
        if (!Number.isFinite(n) || n < 0 || n > 100 || !/^\d*\.?\d{0,2}$/.test(s.replace(/,/g, ''))) {
          return { error: 'Default tax rate must be a percentage between 0 and 100.' };
        }
        return { value: n };
      },
      payment_details: v.text('Payment details', 500),
    },
    body
  );
  Object.assign(errors, errs);

  let logoPath = null;
  let logoError = null;
  if (file && file.size > 0) {
    const ext = LOGO_TYPES[file.mimetype];
    if (!ext) logoError = 'Logo must be a PNG, JPG or WEBP image.';
    else logoPath = `${crypto.randomUUID()}${ext}`;
  }
  return { data, errors, logoPath, logoError };
}

function saveLogo(file, logoPath) {
  if (!file || !logoPath) return;
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadDir, logoPath), file.buffer);
}

function removeLogoFile(logoPath) {
  if (!logoPath) return;
  const abs = path.join(config.uploadDir, path.basename(logoPath));
  fs.unlink(abs, () => {});
}

router.get('/', (req, res) => {
  res.render('business_form', {
    title: req.business ? 'Business settings' : 'Set up your business',
    isSetup: !req.business,
    errors: {},
    values: req.business
      ? {
          ...req.business,
          default_tax_rate: String(req.business.default_tax_rate),
        }
      : { default_currency: 'USD', invoice_prefix: 'INV', default_tax_rate: '0' },
    currencies: money.CURRENCY_CODES,
    currencyDigits: Object.fromEntries(money.CURRENCY_CODES.map((c) => [c, money.currencyDigits(c)])),
    logoError: null,
  });
});

router.post('/', upload.single('logo'), (req, res) => {
  // Multipart requests verify CSRF here (multer had to parse the body first).
  if (!auth.csrfValid(req)) {
    return res.status(403).render('error', {
      title: 'Request blocked',
      message: 'Your session expired. Please go back and try again.',
    });
  }
  const values = businessValues(req.body);
  const { data, errors, logoPath, logoError } = validateBusiness(req.body, req.file);

  if (Object.keys(errors).length || logoError) {
    return res.status(400).render('business_form', {
      title: req.business ? 'Business settings' : 'Set up your business',
      isSetup: !req.business,
      errors: logoError ? { ...errors, logo: logoError } : errors,
      values: { ...values, default_tax_rate: values.default_tax_rate },
      currencies: money.CURRENCY_CODES,
      currencyDigits: Object.fromEntries(money.CURRENCY_CODES.map((c) => [c, money.currencyDigits(c)])),
      logoError,
    });
  }

  const db = dbm.get();
  if (req.business) {
    removeLogoFile(req.business.logo_path);
    saveLogo(req.file, logoPath);
    db.prepare(
      `UPDATE businesses SET name=?, email=?, phone=?, address=?, tax_id=?,
         default_currency=?, invoice_prefix=?, default_tax_rate=?, payment_details=?,
         logo_path=COALESCE(?, logo_path)
       WHERE user_id=?`
    ).run(
      data.name, data.email, data.phone, data.address, data.tax_id,
      data.default_currency, data.invoice_prefix, data.default_tax_rate,
      data.payment_details, logoPath, req.user.id
    );
    res.flash('Business profile updated.');
    res.redirect('/business');
  } else {
    saveLogo(req.file, logoPath);
    db.prepare(
      `INSERT INTO businesses (user_id, name, email, phone, address, tax_id,
         default_currency, invoice_prefix, default_tax_rate, payment_details, logo_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.user.id, data.name, data.email, data.phone, data.address, data.tax_id,
      data.default_currency, data.invoice_prefix, data.default_tax_rate,
      data.payment_details, logoPath
    );
    res.flash('Welcome! Your business profile is ready.');
    res.redirect('/dashboard');
  }
});

router.post('/logo/remove', auth.csrfMiddleware, (req, res) => {
  if (req.business && req.business.logo_path) {
    removeLogoFile(req.business.logo_path);
    dbm.get().prepare('UPDATE businesses SET logo_path = NULL WHERE user_id = ?').run(req.user.id);
    res.flash('Logo removed.');
  }
  res.redirect('/business');
});

module.exports = router;
