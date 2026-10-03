'use strict';

/**
 * Session middleware + auth guards.
 * Sessions are stored in SQLite (they survive restarts) and referenced by an
 * opaque random token in an httpOnly cookie. Each session carries a CSRF
 * token that must accompany every state-changing request, plus a one-shot
 * flash message slot that survives redirects.
 */

const crypto = require('crypto');
const dbm = require('./db');
const config = require('./config');

const COOKIE = 'il_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isoAt(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Load or create the session row; expose it as req.session. */
function sessionMiddleware(req, res, next) {
  const db = dbm.get();
  const token = req.cookies[COOKIE];

  let row = null;
  if (token) {
    row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (row && new Date(row.expires_at).getTime() < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(row.token);
      row = null;
    }
  }

  if (row) {
    // Sliding expiry: bump if more than a day has passed since the last touch.
    if (new Date(row.expires_at).getTime() < Date.now() + TTL_MS - 24 * 3600 * 1000) {
      db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(isoAt(TTL_MS), row.token);
    }
    req.session = {
      token: row.token,
      userId: row.user_id,
      csrfToken: row.csrf_token,
      flash: row.flash ? JSON.parse(row.flash) : null,
    };
  } else {
    const newToken = randomToken();
    const csrf = randomToken();
    db.prepare('INSERT INTO sessions (token, user_id, csrf_token, flash, expires_at) VALUES (?, NULL, ?, NULL, ?)')
      .run(newToken, csrf, isoAt(TTL_MS));
    req.session = { token: newToken, userId: null, csrfToken: csrf, flash: null };
  }

  res.cookie(COOKIE, req.session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    maxAge: TTL_MS,
  });
  next();
}

/** Verify the CSRF token for urlencoded bodies. Returns true when valid. */
function csrfValid(req) {
  return req.body && req.body._csrf === req.session.csrfToken;
}

function csrfMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // Multipart requests verify explicitly inside their route (after multer runs).
  const isMultipart = (req.headers['content-type'] || '').startsWith('multipart/form-data');
  if (isMultipart) return next();
  if (!csrfValid(req)) {
    return res.status(403).render('error', {
      title: 'Request blocked',
      message: 'Your session expired or the form was tampered with. Please go back and try again.',
    });
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

/** Attach the logged-in user (and their business) to req/res.locals. */
function userMiddleware(req, res, next) {
  req.user = null;
  req.business = null;
  if (req.session.userId) {
    const db = dbm.get();
    req.user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.session.userId) || null;
    if (req.user) {
      req.business =
        db.prepare('SELECT * FROM businesses WHERE user_id = ?').get(req.user.id) || null;
    } else {
      req.session.userId = null; // stale session for a deleted user
    }
  }
  res.locals.currentUser = req.user;
  res.locals.currentBusiness = req.business;
  next();
}

function createLoginSession(req, userId) {
  dbm.get().prepare('UPDATE sessions SET user_id = ? WHERE token = ?').run(userId, req.session.token);
  req.session.userId = userId;
}

/** Store a one-shot flash message visible on the next rendered page. */
function setFlash(req, message, type = 'success') {
  dbm.get()
    .prepare('UPDATE sessions SET flash = ? WHERE token = ?')
    .run(JSON.stringify({ message, type }), req.session.token);
}

function clearFlash(req) {
  dbm.get().prepare('UPDATE sessions SET flash = NULL WHERE token = ?').run(req.session.token);
}

function destroySession(req, res) {
  dbm.get().prepare('DELETE FROM sessions WHERE token = ?').run(req.session.token);
  res.clearCookie(COOKIE);
}

/** Housekeeping: drop sessions older than their TTL. */
function pruneSessions() {
  dbm.get().prepare('DELETE FROM sessions WHERE expires_at < ?').run(isoAt(-TTL_MS));
}

module.exports = {
  sessionMiddleware,
  csrfMiddleware,
  csrfValid,
  requireAuth,
  userMiddleware,
  createLoginSession,
  setFlash,
  clearFlash,
  destroySession,
  pruneSessions,
};
