'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  // Public base URL used for shareable links (set in production).
  baseUrl: (process.env.BASE_URL || '').replace(/\/+$/, ''),
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'invoicelite.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'),
  // In production a persistent SESSION_SECRET is required; in dev we fall back
  // to a random one (sessions are invalidated on restart).
  sessionSecret:
    process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
};

config.baseUrl = config.baseUrl || `http://localhost:${config.port}`;

if (config.nodeEnv === 'production' && !process.env.SESSION_SECRET) {
  throw new Error(
    'SESSION_SECRET must be set in production. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

module.exports = config;
