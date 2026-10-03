'use strict';

const test = require('node:test');
const assert = require('node:assert');
const money = require('../src/money');

test('currencyDigits reflects currency decimal places', () => {
  assert.strictEqual(money.currencyDigits('USD'), 2);
  assert.strictEqual(money.currencyDigits('JPY'), 0);
  assert.strictEqual(money.currencyDigits('BHD'), 3);
});

test('isValidCurrency accepts ISO codes and rejects junk', () => {
  assert.ok(money.isValidCurrency('EUR'));
  assert.ok(money.isValidCurrency('usd')); // normalised by callers
  assert.ok(!money.isValidCurrency('XX1'));
  assert.ok(!money.isValidCurrency(''));
  assert.ok(!money.isValidCurrency(null));
});

test('parseDecimalToMinor converts user input to integer minor units', () => {
  assert.strictEqual(money.parseDecimalToMinor('12.34', 2), 1234);
  assert.strictEqual(money.parseDecimalToMinor('0.1', 2), 10);
  assert.strictEqual(money.parseDecimalToMinor('5', 2), 500);
  assert.strictEqual(money.parseDecimalToMinor('1,234.56', 2), 123456); // thousands separator tolerated
  assert.strictEqual(money.parseDecimalToMinor('0.005', 2), 1); // rounds half-up
  assert.strictEqual(money.parseDecimalToMinor('10', 0), 10); // JPY: no decimals
  assert.strictEqual(money.parseDecimalToMinor('10.4', 0), 10);
  assert.strictEqual(money.parseDecimalToMinor('10.5', 0), 11);
  assert.strictEqual(money.parseDecimalToMinor('0.123', 3), 123); // BHD
  assert.strictEqual(money.parseDecimalToMinor('', 2), null);
  assert.strictEqual(money.parseDecimalToMinor('abc', 2), null);
  assert.strictEqual(money.parseDecimalToMinor('-5', 2), null); // negatives rejected here
  assert.strictEqual(money.parseDecimalToMinor('1.2.3', 2), null);
});

test('calcTotals computes subtotal, discount and tax with correct rounding', () => {
  // 2 x 100.00 + 1 x 50.00 = 250.00; 10% discount; 8% tax
  const items = [
    { quantity: 2, unitPriceMinor: 10000 },
    { quantity: 1, unitPriceMinor: 5000 },
  ];
  const t = money.calcTotals(items, { type: 'percent', percent: 10 }, 8);
  assert.strictEqual(t.subtotalMinor, 25000);
  assert.strictEqual(t.discountMinor, 2500);
  assert.strictEqual(t.taxMinor, 1800); // 8% of 225.00
  assert.strictEqual(t.totalMinor, 24300);
});

test('calcTotals handles fixed discounts and clamps to subtotal', () => {
  const items = [{ quantity: 1, unitPriceMinor: 10000 }];
  const t = money.calcTotals(items, { type: 'fixed', valueMinor: 2000 }, 0);
  assert.strictEqual(t.totalMinor, 8000);
  const clamped = money.calcTotals(items, { type: 'fixed', valueMinor: 99999 }, 0);
  assert.strictEqual(clamped.totalMinor, 0);
});

test('calcTotals rounds tax half-up on fractional cents', () => {
  // subtotal 100.05 with 5% tax = 5.0025 -> 5.00 ; subtotal 100.10 -> 5.005 -> 5.01
  const a = money.calcTotals([{ quantity: 1, unitPriceMinor: 10005 }], { type: 'none' }, 5);
  assert.strictEqual(a.taxMinor, 500);
  const b = money.calcTotals([{ quantity: 1, unitPriceMinor: 10010 }], { type: 'none' }, 5);
  assert.strictEqual(b.taxMinor, 501);
});

test('calcTotals with no discount and no tax is just the subtotal', () => {
  const t = money.calcTotals(
    [{ quantity: 2.5, unitPriceMinor: 8000 }, { quantity: 1, unitPriceMinor: 1 }],
    { type: 'none' },
    0
  );
  assert.strictEqual(t.subtotalMinor, 20001);
  assert.strictEqual(t.totalMinor, 20001);
});

test('formatMoney renders per-currency symbols and digits', () => {
  assert.strictEqual(money.formatMoney(123456, 'USD'), '$1,234.56');
  assert.strictEqual(money.formatMoney(1234, 'EUR'), '€12.34');
  assert.strictEqual(money.formatMoney(1000, 'JPY'), '¥1,000'); // zero-decimal
  assert.strictEqual(money.formatMoney(0, 'GBP'), '£0.00');
});

test('parseQuantity allows fractional hours and rejects junk', () => {
  assert.strictEqual(money.parseQuantity('2.5'), 2.5);
  assert.strictEqual(money.parseQuantity('0.25'), 0.25);
  assert.strictEqual(money.parseQuantity('10'), 10);
  assert.strictEqual(money.parseQuantity('0'), null);
  assert.strictEqual(money.parseQuantity('-1'), null);
  assert.strictEqual(money.parseQuantity('abc'), null);
  assert.strictEqual(money.parseQuantity(''), null);
});
