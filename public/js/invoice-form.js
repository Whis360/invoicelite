'use strict';

/**
 * Invoice form behaviour: dynamic line items and live totals.
 * The server always recomputes authoritative totals; this is UX sugar.
 */
(function () {
  const form = document.getElementById('invoice-form');
  if (!form) return;

  let currency = form.elements.currency.value;
  let digits = 2;
  try {
    const digitsMap = JSON.parse(form.dataset.digits);
    digits = digitsMap[currency] !== undefined ? digitsMap[currency] : 2;
  } catch { /* keep default */ }

  const fmt = () => new Intl.NumberFormat('en', { style: 'currency', currency });
  const rowsEl = document.getElementById('items-rows');
  const template = document.getElementById('item-template');
  const initial = JSON.parse(document.getElementById('initial-items').textContent || '[]');

  function minorToDecimal(minor) {
    return (minor / Math.pow(10, digits)).toFixed(digits);
  }

  function addRow(values) {
    const row = template.content.firstElementChild.cloneNode(true);
    if (values) {
      row.querySelector('[name="description[]"]').value = values.description || '';
      row.querySelector('[name="quantity[]"]').value = values.quantity != null ? values.quantity : '';
      row.querySelector('[name="unit_price[]"]').value = values.unit_price != null ? values.unit_price : '';
    }
    rowsEl.appendChild(row);
    return row;
  }

  function parseMinor(input) {
    const s = String(input).trim().replace(/[,\s]/g, '');
    if (!s || !/^\d*(\.\d*)?$/.test(s)) return null;
    const [int = '0', frac = ''] = s.split('.');
    return Number(int + frac.padEnd(digits, '0').slice(0, digits));
  }

  function recalc() {
    const f = fmt();
    let subtotalMinor = 0;
    rowsEl.querySelectorAll('.items-row').forEach((row) => {
      const qty = parseFloat(row.querySelector('[name="quantity[]"]').value.replace(/,/g, ''));
      const priceMinor = parseMinor(row.querySelector('[name="unit_price[]"]').value);
      const amountEl = row.querySelector('.item-amount');
      if (Number.isFinite(qty) && qty > 0 && priceMinor !== null) {
        const amountMinor = Math.round(qty * priceMinor);
        subtotalMinor += amountMinor;
        amountEl.textContent = f.format(amountMinor / Math.pow(10, digits));
      } else {
        amountEl.textContent = '—';
      }
    });

    const discountType = document.getElementById('discount_type').value;
    const discountInput = document.getElementById('discount_value');
    discountInput.disabled = discountType === 'none';
    let discountMinor = 0;
    if (discountType === 'fixed') {
      const v = parseMinor(discountInput.value);
      discountMinor = v ? Math.min(v, subtotalMinor) : 0;
    } else if (discountType === 'percent') {
      const pct = parseFloat(discountInput.value.replace(/,/g, ''));
      discountMinor = Number.isFinite(pct) && pct > 0
        ? Math.round((subtotalMinor * Math.min(pct, 100)) / 100) : 0;
    }

    const taxPct = parseFloat(document.getElementById('tax_rate').value.replace(/,/g, ''));
    const taxable = subtotalMinor - discountMinor;
    const taxMinor = Number.isFinite(taxPct) && taxPct > 0
      ? Math.round((taxable * Math.min(taxPct, 100)) / 100) : 0;
    const totalMinor = taxable + taxMinor;

    document.getElementById('t-subtotal').textContent = f.format(subtotalMinor / Math.pow(10, digits));
    document.getElementById('t-discount').textContent =
      discountMinor > 0 ? '− ' + f.format(discountMinor / Math.pow(10, digits)) : f.format(0);
    document.getElementById('t-tax').textContent = f.format(taxMinor / Math.pow(10, digits));
    document.getElementById('t-total').textContent = f.format(totalMinor / Math.pow(10, digits));
  }

  document.getElementById('add-row').addEventListener('click', () => {
    addRow();
    recalc();
  });

  rowsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.remove-row');
    if (!btn) return;
    // Keep at least one row so the form always posts a line.
    if (rowsEl.querySelectorAll('.items-row').length > 1) btn.closest('.items-row').remove();
    recalc();
  });

  form.addEventListener('input', recalc);
  form.elements.currency.addEventListener('change', () => {
    currency = form.elements.currency.value;
    try {
      const digitsMap = JSON.parse(form.dataset.digits);
      digits = digitsMap[currency] !== undefined ? digitsMap[currency] : 2;
    } catch { /* keep default */ }
    recalc();
  });

  if (initial.length) initial.forEach(addRow);
  else addRow();
  recalc();
})();
