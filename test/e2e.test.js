'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.BASE_URL = '';

const { createApp } = require('../src/app');

/**
 * End-to-end test of the complete user flow over real HTTP:
 * register -> business setup -> customer -> invoice -> PDF -> share ->
 * mark paid -> receipt -> dashboard totals.
 */

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoicelite-e2e-'));
  return path.join(dir, 'e2e.db');
}

function makeClient(server) {
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  let csrf = null;

  /** Serialize form values, supporting arrays as repeated keys. */
  function encodeForm(form) {
    const parts = [];
    for (const [key, value] of Object.entries(form)) {
      for (const v of [].concat(value)) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
      }
    }
    return parts.join('&');
  }

  return {
    base,
    async request(method, p, { form = null, follow = false } = {}) {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      if (form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        if (csrf) form = { ...form, _csrf: csrf };
      }
      const res = await fetch(base + p, {
        method,
        headers,
        body: form ? encodeForm(form) : undefined,
        redirect: follow ? 'follow' : 'manual',
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return res;
    },
    /** GET a page and extract the CSRF token for subsequent posts. */
    async getWithCsrf(p) {
      const res = await this.request('GET', p);
      assert.strictEqual(res.status, 200, `GET ${p} should be 200`);
      const html = await res.text();
      csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] || null;
      assert.ok(csrf, `GET ${p} should expose a CSRF token`);
      return html;
    },
    async post(p, form, { follow = true } = {}) {
      // The CSRF token stays valid for the whole session, so it is kept
      // between posts; getWithCsrf() re-extracts it when needed.
      const res = await this.request('POST', p, { form, follow });
      return res;
    },
    /** Anonymous request (no cookies) for share-link checks. */
    async anon(p) {
      return fetch(base + p, { redirect: 'manual' });
    },
    getCSRF() { return csrf; },
    setCSRF(v) { csrf = v; },
  };
}

test('complete user flow: register → business → customer → invoice → PDF → share → paid → receipt', async () => {
  const server = createApp({ dbPath: tmpDb() }).listen(0);
  const c = makeClient(server);
  try {
    // 1. Landing redirects to login when logged out.
    const root = await c.request('GET', '/');
    assert.strictEqual(root.status, 302);
    assert.match(root.headers.get('location'), /\/login/);

    // 2. Register (also logs us in) -> redirected to business setup.
    await c.getWithCsrf('/register');
    const reg = await c.post('/register', {
      name: 'Dana Freelancer', email: 'dana@example.com', password: 'correct-horse-1',
    });
    assert.strictEqual(reg.status, 200); // followed redirect lands on /business
    assert.match(await reg.text(), /Set up your business/);

    // 3. Configure business profile.
    const bizHtml = await c.getWithCsrf('/business');
    assert.match(bizHtml, /Invoice number prefix/);
    const bizSaved = await c.post('/business', {
      name: 'Dana Design Co.', email: 'billing@danadesign.example', phone: '+1 555 0101',
      address: '7 Studio Lane\nPortland, OR 97205', tax_id: 'US-99-8888888',
      default_currency: 'USD', invoice_prefix: 'DANA', default_tax_rate: '8.5',
      payment_details: 'Bank: Cascade Bank · IBAN: US64 SVBK 0000 0000 1234 5678',
    });
    assert.match(await bizSaved.text(), /Dashboard/);

    // 4. Dashboard renders empty totals.
    const dash = await c.getWithCsrf('/dashboard');
    assert.match(dash, /Total invoiced/);
    assert.match(dash, /\$0\.00/);

    // 5. Create a customer.
    await c.getWithCsrf('/customers/new');
    await c.post('/customers/new', {
      name: 'Globex Corporation', email: 'ap@globex.example', phone: '+1 555 0200',
      address: '1 Infinite Loop\nCupertino, CA 95014', notes: 'Net 14 terms', next: '',
    });
    const custList = await c.getWithCsrf('/customers');
    assert.match(custList, /Globex Corporation/);

    // 6. Create an invoice with two lines, 10% discount, 8.5% tax.
    await c.getWithCsrf('/invoices/new');
    const invRes = await c.post('/invoices/new', {
      customer_id: '1', issue_date: '2026-01-10', due_date: '2026-01-24', currency: 'USD',
      'description[]': ['Website design', 'Frontend development'],
      'quantity[]': ['1', '10'],
      'unit_price[]': ['300.00', '20.00'],
      discount_type: 'percent', discount_value: '10', tax_rate: '8.5',
      notes: 'Thank you for your business!',
    });
    const invHtml = await invRes.text();
    assert.match(invHtml, /DANA-0001/);
    assert.match(invHtml, /\$488\.25/); // server-computed total

    // Wrong password is rejected.
    // (covered in auth test below)

    // 7. Download the invoice PDF.
    const pdfRes = await c.request('GET', '/invoices/1/pdf');
    assert.strictEqual(pdfRes.status, 200);
    assert.strictEqual(pdfRes.headers.get('content-type'), 'application/pdf');
    const pdf = Buffer.from(await pdfRes.arrayBuffer());
    assert.ok(pdf.subarray(0, 5).toString('latin1') === '%PDF-');
    assert.ok(pdf.length > 1500);

    // 8. Public share link works without any session.
    const shareRes = await c.anon('/share/test-share-token-placeholder');
    assert.strictEqual(shareRes.status, 404); // bogus token -> 404
    const invPage = await c.getWithCsrf('/invoices/1');
    const shareMatch = /value="(http[^"]+\/share\/[^"]+)"/.exec(invPage);
    assert.ok(shareMatch, 'invoice page should show a share URL');
    const sharePath = new URL(shareMatch[1]).pathname;
    const publicView = await c.anon(sharePath);
    assert.strictEqual(publicView.status, 200);
    const publicHtml = await publicView.text();
    assert.match(publicHtml, /Globex Corporation/);
    assert.match(publicHtml, /\$488\.25/);
    const publicPdf = await c.anon(`${sharePath}/pdf`);
    assert.strictEqual(publicPdf.status, 200);
    assert.ok(Buffer.from(await publicPdf.arrayBuffer()).subarray(0, 4).toString() === '%PDF');

    // 9. Mark as paid; receipt becomes available.
    await c.getWithCsrf('/invoices/1');
    await c.post('/invoices/1/status', { action: 'sent' });
    const paid = await c.post('/invoices/1/status', { action: 'paid' });
    const paidHtml = await paid.text();
    assert.match(paidHtml, /PAID/);
    assert.match(paidHtml, /Download receipt/);

    const receipt = await c.request('GET', '/invoices/1/receipt');
    assert.strictEqual(receipt.status, 200);
    const receiptBuf = Buffer.from(await receipt.arrayBuffer());
    assert.ok(receiptBuf.subarray(0, 5).toString('latin1') === '%PDF-');

    // 10. Public page now offers the receipt too.
    const publicPaid = await (await c.anon(sharePath)).text();
    assert.match(publicPaid, /This invoice was paid/);
    assert.match(publicPaid, /Download receipt/);

    // 11. Dashboard totals reflect payment.
    const dash2 = await c.getWithCsrf('/dashboard');
    assert.match(dash2, /\$488\.25/);
    assert.match(dash2, /DANA-0001/);
  } finally {
    server.close();
  }
});

test('auth and validation guardrails', async () => {
  const server = createApp({ dbPath: tmpDb() }).listen(0);
  const c = makeClient(server);
  try {
    // Wrong password shows an error, not a crash.
    await c.getWithCsrf('/register');
    await c.post('/register', { name: 'Bob', email: 'bob@example.com', password: 'longenough1' });
    await c.request('POST', '/logout', { form: {} });
    const relogin = await makeClient(server);
    await relogin.getWithCsrf('/login');
    const bad = await relogin.post('/login', { email: 'bob@example.com', password: 'wrong-password' });
    assert.strictEqual(bad.status, 401);
    assert.match(await bad.text(), /Invalid email or password/);

    // Short password is rejected at registration.
    const c2 = makeClient(server);
    await c2.getWithCsrf('/register');
    const short = await c2.post('/register', { name: 'Eve', email: 'eve@example.com', password: 'short' }, { follow: false });
    assert.strictEqual(short.status, 400);

    // Protected pages redirect to login when logged out.
    const dash = await makeClient(server).request('GET', '/dashboard');
    assert.strictEqual(dash.status, 302);

    // Invoice validation: garbage numbers are rejected with a re-rendered form.
    const c3 = makeClient(server);
    await c3.getWithCsrf('/login');
    await c3.post('/login', { email: 'bob@example.com', password: 'longenough1' });
    // Bob has no business -> /invoices/new redirects to business setup.
    await c3.getWithCsrf('/business');
    await c3.post('/business', {
      name: 'Bob Build Ltd', default_currency: 'EUR', invoice_prefix: 'BOB', default_tax_rate: '0',
    });
    await c3.getWithCsrf('/customers/new');
    await c3.post('/customers/new', { name: 'Acme GmbH', next: '/invoices/new' });
    await c3.getWithCsrf('/invoices/new');
    const badInv = await c3.post('/invoices/new', {
      customer_id: '1', issue_date: '2026-01-10', due_date: '2026-01-01', currency: 'EUR',
      'description[]': [''], 'quantity[]': [''], 'unit_price[]': [''],
      discount_type: 'none', discount_value: '', tax_rate: '0',
    });
    assert.strictEqual(badInv.status, 400);
    const badHtml = await badInv.text();
    assert.match(badHtml, /Due date cannot be before the issue date/);
    assert.match(badHtml, /Add at least one product or service line/);
  } finally {
    server.close();
  }
});
