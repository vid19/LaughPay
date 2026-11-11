// PayPal webhooks: the fast path for payout and capture status.
import express, { Router } from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { toCents } from '../money.js';
import { paypal } from '../paypal/index.js';
import { applyItemStatus } from '../services/payouts.js';

const r = Router();

function handleEvent(event) {
  const type = event.event_type || '';
  const res = event.resource || {};

  if (type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
    const p = db.find(
      'payouts',
      (x) =>
        (res.payout_item_id && x.payoutItemId === res.payout_item_id) ||
        (res.payout_item?.sender_item_id && x.id === res.payout_item.sender_item_id) ||
        (res.payout_batch_id && x.payoutBatchId === res.payout_batch_id),
    );
    if (p) applyItemStatus(p, { ...res, transaction_status: res.transaction_status || type.split('.').pop() });
    return;
  }

  if (type === 'PAYMENT.CAPTURE.COMPLETED') {
    // Backup for the capture route: marks a challenge live if the browser closed mid-checkout.
    const c = db.find('challenges', (x) => x.paypalCaptureId === res.id || x.id === res.custom_id);
    if (c && c.status === 'awaiting_funding' && toCents(res.amount?.value) >= c.totalCents) {
      db.update('challenges', c.id, {
        status: 'live',
        fundedCents: toCents(res.amount.value),
        paypalCaptureId: res.id,
        fundedAt: new Date().toISOString(),
      });
    }
  }
}

// PayPal's dashboard rejects webhook URLs that contain the word "paypal",
// so /api/webhooks/events is the one to register. /paypal stays as an alias.
async function receive(req, res) {
  let event;
  try {
    event = JSON.parse(Buffer.from(req.body || '').toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!config.paypal.mock) {
    if (!config.paypal.webhookId) {
      console.warn('[webhook] PAYPAL_WEBHOOK_ID not set; ignoring event', event.event_type);
      return res.json({ ok: true, ignored: true });
    }
    let verified = false;
    try {
      verified = await paypal.verifyWebhook(req.headers, event);
    } catch (err) {
      console.error('[webhook] verification error:', err.message);
    }
    if (!verified) return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  if (db.find('webhookLog', (w) => w.eventId === event.id)) return res.json({ ok: true, duplicate: true });
  db.insert('webhookLog', {
    eventId: event.id,
    type: event.event_type,
    resourceId: event.resource?.id || event.resource?.payout_item_id || null,
    summary: event.summary || null,
  });

  try {
    handleEvent(event);
  } catch (err) {
    console.error('[webhook] handler error:', err);
  }
  res.json({ ok: true });
}

const raw = express.raw({ type: '*/*', limit: '1mb' });
r.post('/events', raw, receive);
r.post('/paypal', raw, receive);

export default r;
