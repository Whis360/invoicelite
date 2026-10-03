'use strict';

/**
 * Small validation helpers. Each route builds a `spec` of field validators,
 * runs `validate()`, and gets back { data, errors } to re-render the form.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

const validators = {
  required: (label) => (v) => {
    const s = str(v);
    return s ? { value: s } : { error: `${label} is required.` };
  },
  text: (label, max) => (v) => {
    const s = str(v);
    if (s.length > max) return { error: `${label} must be at most ${max} characters.` };
    return { value: s };
  },
  email: (label = 'Email') => (v) => {
    const s = str(v);
    if (!s) return { value: s };
    if (s.length > 200 || !EMAIL_RE.test(s)) return { error: `${label} is not a valid email address.` };
    return { value: s };
  },
  date: (label) => (v) => {
    const s = str(v);
    if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) {
      return { error: `${label} must be a valid date (YYYY-MM-DD).` };
    }
    return { value: s };
  },
  password: () => (v) => {
    const s = typeof v === 'string' ? v : '';
    if (s.length < 8) return { error: 'Password must be at least 8 characters.' };
    if (s.length > 100) return { error: 'Password must be at most 100 characters.' };
    return { value: s };
  },
  choice: (label, allowed) => (v) => {
    const s = str(v);
    if (!allowed.includes(s)) return { error: `${label} is invalid.` };
    return { value: s };
  },
};

/**
 * spec: { field: fn } where fn(raw) -> { value } | { error }.
 * Returns { data, errors } — data holds successfully parsed fields,
 * errors maps field -> message.
 */
function validate(spec, input) {
  const data = {};
  const errors = {};
  for (const [field, fn] of Object.entries(spec)) {
    const res = fn(input[field]);
    if (res.error) errors[field] = res.error;
    else data[field] = res.value;
  }
  return { data, errors };
}

/** Parse a decimal string into minor units with a friendly error message. */
function moneyField(label, digits, { min = 0, max = 1e12 } = {}) {
  const money = require('./money');
  return (v) => {
    const minor = money.parseDecimalToMinor(v, digits);
    if (minor === null) return { error: `${label} must be a valid non-negative amount.` };
    if (minor < min || minor > max) return { error: `${label} is out of range.` };
    return { value: minor };
  };
}

module.exports = { str, validate, validators, moneyField, EMAIL_RE, DATE_RE };
