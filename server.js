'use strict';

const { createApp } = require('./src/app');
const config = require('./src/config');
const auth = require('./src/auth');

const app = createApp();
app.listen(config.port, () => {
  console.log(`InvoiceLite running at ${config.baseUrl} (port ${config.port})`);
});

// Light housekeeping once a day.
setInterval(() => {
  try {
    auth.pruneSessions();
  } catch (err) {
    console.error('Session pruning failed:', err.message);
  }
}, 24 * 3600 * 1000).unref();
