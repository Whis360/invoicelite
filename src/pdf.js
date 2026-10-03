'use strict';

/**
 * PDF generation with pdfkit. One layout engine renders both documents:
 *   kind = 'invoice' -> INVOICE
 *   kind = 'receipt' -> RECEIPT (proof of payment for a paid invoice)
 * All data is passed in preloaded; nothing here touches the database.
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const money = require('./money');
const config = require('./config');

const COLORS = {
  text: '#111827',
  muted: '#6b7280',
  line: '#e5e7eb',
  zebra: '#f9fafb',
  headBg: '#f3f4f6',
  accent: '#4f46e5',
  badge: {
    draft: { bg: '#6b7280', label: 'DRAFT' },
    sent: { bg: '#2563eb', label: 'SENT' },
    paid: { bg: '#16a34a', label: 'PAID' },
    overdue: { bg: '#dc2626', label: 'OVERDUE' },
  },
};

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(d);
}

/** Draw a filled rounded badge with centered white label. */
function drawBadge(doc, x, y, key) {
  const spec = COLORS.badge[key] || COLORS.badge.draft;
  doc.font('Helvetica-Bold').fontSize(9);
  const w = doc.widthOfString(spec.label) + 16;
  doc.roundedRect(x - w, y, w, 18, 4).fill(spec.bg);
  doc.fill('#ffffff').text(spec.label, x - w, y + 5, { width: w, align: 'center', lineBreak: false });
}

/**
 * Build the PDF as a Buffer.
 * data: { business, customer, invoice, items, effectiveStatus }
 */
function renderToBuffer(data, kind, opts = {}) {
  return new Promise((resolve, reject) => {
    const isReceipt = kind === 'receipt';
    const { business, customer, invoice, items } = data;
    const statusKey = isReceipt ? 'paid' : data.effectiveStatus || invoice.status;

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 48, bottom: 56, left: 48, right: 48 },
      compress: opts.compress !== false,
      info: {
        Title: `${isReceipt ? 'Receipt' : 'Invoice'} ${invoice.number}`,
        Author: business.name,
        Creator: 'InvoiceLite',
      },
    });
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));

    const fmt = (m) => money.formatMoney(m, invoice.currency);
    const M = doc.page.margins.left;
    const W = doc.page.width - M - doc.page.margins.right;
    let y = M;

    // ---- Header --------------------------------------------------------
    let logoBottom = y;
    if (business.logo_path) {
      const abs = path.join(config.uploadDir, path.basename(business.logo_path));
      if (fs.existsSync(abs)) {
        try {
          doc.image(abs, M, y, { fit: [150, 52], align: 'left' });
          // Approximate placed height so text never overlaps the logo.
          logoBottom = y + 52;
        } catch {
          /* unreadable image file — render without it */
        }
      }
    }
    const title = isReceipt ? 'RECEIPT' : 'INVOICE';
    doc.font('Helvetica-Bold').fontSize(24).fillColor(COLORS.accent).text(title, M, y, {
      width: W, align: 'right', lineBreak: false,
    });
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted)
      .text(invoice.number, M, doc.y + 2, { width: W, align: 'right', lineBreak: false });
    y = Math.max(logoBottom, doc.y) + 20;

    // ---- Status + dates --------------------------------------------------
    const rightW = 190;
    drawBadge(doc, M + W, y, statusKey);
    doc.fillColor(COLORS.text).font('Helvetica').fontSize(10);
    const metaLines = isReceipt
      ? [['Payment date', fmtDate(invoice.paid_at || invoice.updated_at)]]
      : [
          ['Issue date', fmtDate(invoice.issue_date)],
          ['Due date', fmtDate(invoice.due_date)],
        ];
    let metaY = y + 26;
    for (const [label, value] of metaLines) {
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
        .text(label.toUpperCase(), M + W - rightW, metaY, { width: rightW, lineBreak: false });
      doc.font('Helvetica-Bold').fillColor(COLORS.text)
        .text(value, M + W - rightW, metaY + 11, { width: rightW, align: 'right', lineBreak: false });
      metaY += 30;
    }

    // ---- From / Bill to --------------------------------------------------
    const colW = (W - rightW - 24);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.muted)
      .text('FROM', M, y + 6, { width: colW, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text)
      .text(business.name, M, doc.y + 4, { width: colW });
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
    const fromLines = [business.address, business.email, business.phone, business.tax_id && `Tax ID: ${business.tax_id}`]
      .filter(Boolean).join('\n');
    if (fromLines) doc.text(fromLines, M, doc.y + 2, { width: colW });

    const billY = Math.max(metaY, doc.y) + 14;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.muted)
      .text('BILL TO', M, billY, { width: colW, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text)
      .text(customer.name, M, doc.y + 4, { width: colW });
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
    const billLines = [customer.address, customer.email, customer.phone].filter(Boolean).join('\n');
    if (billLines) doc.text(billLines, M, doc.y + 2, { width: colW });

    y = Math.max(billY + 20, doc.y) + 22;

    // ---- Items table ------------------------------------------------------
    const qtyW = 60, unitW = 95, amtW = 100;
    const descW = W - qtyW - unitW - amtW;
    const colX = { desc: M, qty: M + descW, unit: M + descW + qtyW, amt: M + W };
    const pageBottom = doc.page.height - doc.page.margins.bottom;

    function tableHeader(yy) {
      doc.rect(M, yy, W, 22).fill(COLORS.headBg);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.muted);
      doc.text('DESCRIPTION', colX.desc + 8, yy + 7, { width: descW - 16, lineBreak: false });
      doc.text('QTY', colX.qty, yy + 7, { width: qtyW - 8, align: 'right', lineBreak: false });
      doc.text('UNIT PRICE', colX.unit, yy + 7, { width: unitW - 8, align: 'right', lineBreak: false });
      doc.text('AMOUNT', colX.amt, yy + 7, { width: amtW - 8, align: 'right', lineBreak: false });
      return yy + 22;
    }

    y = tableHeader(y);
    items.forEach((item, i) => {
      doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.text);
      const descH = doc.heightOfString(item.description, { width: descW - 16 });
      const rowH = Math.max(descH + 12, 24);
      if (y + rowH > pageBottom - 40) {
        doc.addPage();
        y = doc.page.margins.top;
        y = tableHeader(y);
      }
      if (i % 2 === 1) doc.rect(M, y, W, rowH).fill(COLORS.zebra);
      doc.fillColor(COLORS.text);
      doc.text(item.description, colX.desc + 8, y + 6, { width: descW - 16 });
      doc.text(String(item.quantity), colX.qty, y + 6, { width: qtyW - 8, align: 'right' });
      doc.text(fmt(item.unit_price_minor), colX.unit, y + 6, { width: unitW - 8, align: 'right' });
      doc.font('Helvetica-Bold').text(fmt(item.amount_minor), colX.amt, y + 6, { width: amtW - 8, align: 'right' });
      y += rowH;
      doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(COLORS.line).stroke();
    });

    // ---- Totals -----------------------------------------------------------
    y += 14;
    const totalsX = M + W - 250, totalsW = 250;
    if (y + 110 > pageBottom) { doc.addPage(); y = doc.page.margins.top; }
    const rows = [['Subtotal', fmt(invoice.subtotal_minor)]];
    if (invoice.discount_minor > 0) {
      const label = invoice.discount_type === 'percent'
        ? `Discount (${Number(invoice.discount_percent)}%)`
        : 'Discount';
      rows.push([label, `− ${fmt(invoice.discount_minor)}`]);
    }
    if (invoice.tax_minor > 0 || invoice.tax_rate > 0) {
      rows.push([`Tax (${Number(invoice.tax_rate)}%)`, fmt(invoice.tax_minor)]);
    }
    for (const [label, value] of rows) {
      doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.muted)
        .text(label, totalsX, y, { width: totalsW - 110, lineBreak: false });
      doc.font('Helvetica').fillColor(COLORS.text)
        .text(value, totalsX + totalsW - 110, y, { width: 110, align: 'right', lineBreak: false });
      y += 17;
    }
    y += 4;
    doc.moveTo(totalsX, y).lineTo(M + W, y).lineWidth(1).strokeColor(COLORS.text).stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text)
      .text(isReceipt ? 'Amount paid' : 'Total due', totalsX, y, { width: totalsW - 110, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(11)
      .text(fmt(invoice.total_minor), totalsX + totalsW - 110, y, { width: 110, align: 'right', lineBreak: false });
    y += 26;

    // ---- Notes / payment details ------------------------------------------
    const blocks = [];
    if (isReceipt && invoice.number) {
      blocks.push(['ABOUT THIS RECEIPT', `This receipt confirms payment of invoice ${invoice.number} issued to ${customer.name}.`]);
    }
    if (invoice.notes) blocks.push(['NOTES', invoice.notes]);
    if (business.payment_details) blocks.push(['PAYMENT DETAILS', business.payment_details]);
    for (const [heading, body] of blocks) {
      if (y + 40 > pageBottom) { doc.addPage(); y = doc.page.margins.top; }
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.muted)
        .text(heading, M, y, { width: W, lineBreak: false });
      doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.text)
        .text(body, M, y + 13, { width: W });
      y = doc.y + 10;
    }

    // ---- Footer on every page (two-pass stamping) --------------------------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
        .text(
          isReceipt ? 'Receipt generated by InvoiceLite' : 'Generated with InvoiceLite',
          M, doc.page.height - 34, { width: W, align: 'center', lineBreak: false }
        );
    }
    doc.end();
  });
}

module.exports = { renderToBuffer };
