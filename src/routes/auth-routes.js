'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const dbm = require('../db');
const auth = require('../auth');
const { validate, validators: v } = require('../validators');

const router = express.Router();

function safeNext(raw) {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : null;
}

router.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (!req.business) return res.redirect('/business');
  res.redirect('/dashboard');
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('register', { title: 'Create your account', errors: {}, values: {} });
});

router.post('/register', (req, res) => {
  const { data, errors } = validate(
    {
      name: v.required('Name'),
      email: (val) => {
        const r = v.email('Email')(val);
        if (r.error) return r;
        if (!r.value) return { error: 'Email is required.' };
        return r;
      },
      password: v.password(),
    },
    req.body
  );

  if (!errors.email && dbm.get().prepare('SELECT id FROM users WHERE email = ?').get(data.email)) {
    errors.email = 'An account with this email already exists.';
  }
  if (Object.keys(errors).length) {
    return res.status(400).render('register', {
      title: 'Create your account',
      errors,
      values: { name: req.body.name, email: req.body.email },
    });
  }

  const hash = bcrypt.hashSync(data.password, 12);
  const result = dbm
    .get()
    .prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
    .run(data.email, hash, data.name);
  auth.createLoginSession(req, Number(result.lastInsertRowid));
  res.redirect('/business');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Log in', errors: {}, values: {} });
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = dbm.get().prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', {
      title: 'Log in',
      errors: { form: 'Invalid email or password.' },
      values: { email },
    });
  }
  auth.createLoginSession(req, user.id);
  const next = safeNext(req.body.next);
  res.redirect(next || '/dashboard');
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.redirect('/login');
});

module.exports = router;
