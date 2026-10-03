'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderToBuffer } = require('../src/pdf');

const business = {
  name: 'Acme Design Studio',
  email: 'billing@acme.example',
  phone: '+1 555 0100',
  address: '42 Market Street\nSpringfield, IL 62701',
  tax_id: 'US-123-456-789',
  logo_path: null,
  payment_details: 'Bank: Global Bank\nIBAN: DE89 3704 0044 0532 0130 00',
};

const customer = {
  name: 'Globex Corporation',
  email: 'ap@globex.example',
  phone: '+1 555 0200',
  address: '1 Infinite Loop\nCupertino, CA 95014',
};

const invoice = {
  number: 'INV-0042',
  status: 'sent',
  issue_date: '2026-02-01',
  due_date: '2026-02-15',
  currency: 'USD',
  discount_type: 'percent',
  discount_percent: 10,
  discount_value_minor: 0,
  tax_rate: 8.5,
  subtotal_minor: 50000,
  discount_minor: 5000,
  tax_minor: 3825,
  total_minor: 48825,
  notes: 'Thank you for your business!',
  paid_at: null,
};

const items = [
  { description: 'Website design (fixed scope)', quantity: 1, unit_price_minor: 30000, amount_minor: 30000 },
  { description: 'Frontend development', quantity: 10, unit_price_minor: 2000, amount_minor: 20000 },
];

/**
 * pdfkit writes standard-font text as hex string runs inside TJ arrays with
 * kerning adjustments, e.g. [<494e56> 50 <4f494345>] TJ. Decode and
 * concatenate every hex run so whole words can be asserted regardless of
 * kerning splits.
 */
function extractText(pdf) {
  const runs = pdf.toString('latin1').match(/<([0-9A-Fa-f]+)>/g) || [];
  return runs
    .map((m) => Buffer.from(m.slice(1, -1), 'hex').toString('latin1'))
    .join('');
}

test('invoice PDF contains the expected content and structure', async () => {
  // compress:false keeps text streams readable so we can assert on content.
  const pdf = await renderToBuffer(
    { business, customer, invoice, items, effectiveStatus: 'sent' },
    'invoice',
    { compress: false }
  );

  assert.ok(pdf.subarray(0, 5).toString('latin1') === '%PDF-', 'missing PDF header');
  assert.ok(pdf.includes(Buffer.from('%%EOF')), 'missing PDF trailer');
  assert.ok(pdf.length > 2000, 'suspiciously small PDF');

  const text = extractText(pdf);
  for (const needle of ['INVOICE', 'INV-0042', 'Acme Design Studio', 'Globex Corporation',
    'Website design', 'fixed scope', 'Frontend development', '$300.00', '$200.00',
    '$500.00', '$50.00', '$488.25', 'DUE DATE', '8.5%', 'Thank you for your business!']) {
    assert.ok(text.includes(needle), `PDF text should include "${needle}"`);
  }
});

test('receipt PDF is titled RECEIPT and mentions payment', async () => {
  const paid = { ...invoice, status: 'paid', paid_at: '2026-02-14' };
  const pdf = await renderToBuffer(
    { business, customer, invoice: paid, items, effectiveStatus: 'paid' },
    'receipt',
    { compress: false }
  );
  const text = extractText(pdf);
  for (const needle of ['RECEIPT', 'INV-0042', 'Amount paid', '$488.25', 'confirms payment of invoice']) {
    assert.ok(text.includes(needle), `receipt text should include "${needle}"`);
  }
});

test('multi-page invoices paginate without errors', async () => {
  const manyItems = [];
  for (let i = 0; i < 80; i++) {
    manyItems.push({
      description: `Line item ${i + 1} — consulting services with a reasonably long description`,
      quantity: 1, unit_price_minor: 1000, amount_minor: 1000,
    });
  }
  const pdf = await renderToBuffer(
    { business, customer, invoice, items: manyItems, effectiveStatus: 'sent' }
  );
  assert.ok(pdf.subarray(0, 5).toString('latin1') === '%PDF-');
  // 80 rows at ~24pt each must span more than one A4 page.
  const pages = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  assert.ok(pages && pages.length >= 2, `expected multiple pages, got ${pages ? pages.length : 0}`);
});
