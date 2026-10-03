'use strict';

/**
 * Money helpers. All amounts are INTEGER minor units (cents for USD, etc.)
 * consistent with each currency's decimal digits. Never use floats for storage.
 */

// Curated list offered in the UI (any ISO-4217 code Intl supports is accepted
// by validation, but this keeps the selects manageable).
const CURRENCY_CODES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'HKD',
  'SGD', 'INR', 'KRW', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON',
  'BGN', 'TRY', 'BRL', 'MXN', 'ARS', 'CLP', 'COP', 'PEN', 'ZAR', 'NGN',
  'KES', 'EGP', 'AED', 'SAR', 'QAR', 'ILS', 'THB', 'MYR', 'IDR', 'PHP',
  'VND', 'PKR', 'BDT',
];

// Static fallback for environments without full ICU data.
const FALLBACK_DIGITS = {
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, RSD: 2, TND: 3,
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};

/** Decimal digits for a currency (2 for USD, 0 for JPY, 3 for BHD...). */
function currencyDigits(code) {
  try {
    const opts = new Intl.NumberFormat('en', { style: 'currency', currency: code })
      .resolvedOptions();
    return opts.maximumFractionDigits;
  } catch {
    return FALLBACK_DIGITS[code] !== undefined ? FALLBACK_DIGITS[code] : 2;
  }
}

function isValidCurrency(code) {
  if (typeof code !== 'string' || !/^[A-Za-z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code.toUpperCase() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a user-entered decimal string ("12.34", "1,234.5", "0.005") into
 * integer minor units, rounding half-up when more digits than the currency
 * supports are given. Returns null for invalid input.
 * Only non-negative amounts are accepted here (negatives are rejected).
 */
function parseDecimalToMinor(input, digits) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/[,\s]/g, '');
  if (s === '' || s.includes('-')) return null;
  if (!/^\d*(?:\.\d*)?$/.test(s) || s === '.') return null;

  const [intPart = '0', fracRaw = ''] = s.split('.');
  let frac = fracRaw.slice(0, digits).padEnd(digits, '0');
  let roundUp = false;
  if (fracRaw.length > digits) {
    roundUp = Number(fracRaw[digits]) >= 5;
  }
  let minor = BigInt(intPart + frac);
  if (roundUp) minor += 1n;
  const max = 9007199254740991n; // Number.MAX_SAFE_INTEGER
  if (minor > max) return null;
  return Number(minor);
}

/** Integer minor units -> JS number in major units (e.g. 1234 -> 12.34). */
function minorToNumber(minor, digits) {
  return minor / Math.pow(10, digits);
}

/** Format integer minor units as a currency string, e.g. 1234 -> "$12.34". */
function formatMoney(minor, currency, locale = 'en') {
  const digits = currencyDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minorToNumber(minor, digits));
}

/**
 * Compute invoice totals from line items.
 *  items:    [{ quantity: number, unitPriceMinor: integer }]
 *  discount: { type: 'none'|'fixed'|'percent', valueMinor?: integer, percent?: number }
 *  taxRate:  percentage, e.g. 8.5
 * Returns integer minor units; tax applies to (subtotal - discount).
 */
function calcTotals(items, discount, taxRate) {
  const subtotal = items.reduce(
    (sum, it) => sum + Math.round(Number(it.quantity) * Number(it.unitPriceMinor)),
    0
  );

  let discountMinor = 0;
  if (discount.type === 'fixed') {
    discountMinor = Math.min(Math.round(Number(discount.valueMinor) || 0), subtotal);
  } else if (discount.type === 'percent') {
    discountMinor = Math.round((subtotal * (Number(discount.percent) || 0)) / 100);
  }

  const taxable = subtotal - discountMinor;
  const tax = Math.round((taxable * (Number(taxRate) || 0)) / 100);
  return {
    subtotalMinor: subtotal,
    discountMinor,
    taxMinor: tax,
    totalMinor: taxable + tax,
  };
}

/** Round a quantity to at most 4 decimal places; null if invalid. */
function parseQuantity(input) {
  const n = Number(String(input).trim().replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return null;
  return Math.round(n * 10000) / 10000;
}

module.exports = {
  CURRENCY_CODES,
  currencyDigits,
  isValidCurrency,
  parseDecimalToMinor,
  minorToNumber,
  formatMoney,
  calcTotals,
  parseQuantity,
};
