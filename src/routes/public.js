'use strict';

const express = require('express');
const service = require('../invoice-service');

const router = express.Router();

router.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// Public, unauthenticated share views — read-only, addressed by opaque token.
router.get('/share/:token', (req, res) => {
  const full = service.getShared(req.params.token);
  if (!full) {
    return res.status(404).render('share_404', { title: 'Invoice not found' });
  }
  res.render('share', {
    title: `Invoice ${full.invoice.number}`,
    ...full,
    effectiveStatus: service.effectiveStatus(full.invoice),
  });
});

router.get('/share/:token/pdf', async (req, res) => {
  const full = service.getShared(req.params.token);
  if (!full) return res.status(404).render('share_404', { title: 'Invoice not found' });
  const pdf = await require('../pdf').renderToBuffer(
    { ...full, effectiveStatus: service.effectiveStatus(full.invoice) },
    'invoice'
  );
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="invoice-${full.invoice.number}.pdf"`);
  res.send(pdf);
});

router.get('/share/:token/receipt', async (req, res) => {
  const full = service.getShared(req.params.token);
  if (!full || full.invoice.status !== 'paid') {
    return res.status(404).render('share_404', { title: 'Receipt not found' });
  }
  const pdf = await require('../pdf').renderToBuffer(full, 'receipt');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${full.invoice.number}.pdf"`);
  res.send(pdf);
});

module.exports = router;
