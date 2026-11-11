// Money out: paying winners, tracking payout status, refunding leftovers.
import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { paypal } from '../paypal/index.js';
import { balances, countsAsWin, currentEntry, getChallenge, payoutsFor, queueFor, winsFor } from './challenges.js';

// PayPal item transaction_status (and webhook event suffixes) -> our payout status.
const STATUS_MAP = {
  SUCCESS: 'succeeded', SUCCEEDED: 'succeeded',
  PENDING: 'pending', NEW: 'pending', PROCESSING: 'pending',
  UNCLAIMED: 'unclaimed', ONHOLD: 'on_hold', HELD: 'on_hold',
  FAILED: 'failed', DENIED: 'failed', CANCELED: 'failed',
  RETURNED: 'returned', REFUNDED: 'returned', REVERSED: 'returned',
  BLOCKED: 'blocked',
};
export const TERMINAL = new Set(['succeeded', 'failed', 'returned', 'blocked']);

const locks = new Set();

/**
 * Pays the caller who is live right now. Every check runs on the server, and
 * every win becomes a judge event first. In v1 the source is "manual" (the
 * creator's Winner button); the AI judge will create the same event in v2.
 */
export async function payWinner(challengeId, { reason, source = 'manual', evidence = null } = {}) {
  if (locks.has(challengeId)) throw new HttpError(409, 'A payout for this challenge is already in progress');
  locks.add(challengeId);
  try {
    const c = getChallenge(challengeId);
    if (c.status !== 'live') throw new HttpError(409, 'Challenge is not live');

    const entry = currentEntry(c);
    if (!entry) throw new HttpError(409, 'No caller is live right now');
    const viewer = db.byId('viewers', entry.viewerId);

    if (payoutsFor(c.id).some((p) => p.viewerId === viewer.id && countsAsWin(p))) {
      throw new HttpError(409, `${viewer.displayName} has already won this challenge`);
    }
    if (winsFor(c) >= c.maxWinners) throw new HttpError(409, 'All prizes have been awarded');
    if (balances(c).available < c.prizePerWinCents) throw new HttpError(409, 'Not enough funded balance for another prize');

    const recipient = viewer.payerId
      ? { recipientType: 'PAYPAL_ID', receiver: viewer.payerId }
      : viewer.email
        ? { recipientType: 'EMAIL', receiver: viewer.email }
        : null;
    if (!recipient) throw new HttpError(409, 'This caller has no PayPal account on file');

    const event = db.insert('judgeEvents', {
      challengeId: c.id,
      queueEntryId: entry.id,
      viewerId: viewer.id,
      source,
      reason: reason || 'Creator confirmed the win',
      evidence,
      at: new Date().toISOString(),
    });

    const payout = db.insert('payouts', {
      challengeId: c.id,
      judgeEventId: event.id,
      viewerId: viewer.id,
      amountCents: c.prizePerWinCents,
      currency: config.currency,
      senderBatchId: `LP-${c.id}-${event.id}`,
      recipientType: recipient.recipientType,
      status: 'creating',
    });

    try {
      const res = await paypal.createPayout({
        senderBatchId: payout.senderBatchId,
        senderItemId: payout.id,
        ...recipient,
        amountCents: payout.amountCents,
        emailSubject: `You won "${c.title}"!`,
        note: `Congrats! You won "${c.title}" on ${c.creatorName}'s stream. Paid via LaughPay.`,
      });
      db.update('payouts', payout.id, {
        payoutBatchId: res.batch_header.payout_batch_id,
        batchStatus: res.batch_header.batch_status,
        status: 'pending',
      });
    } catch (err) {
      db.update('payouts', payout.id, { status: 'failed', error: err.message, debugId: err.debugId || null });
      throw err;
    }

    // Check status shortly after; the poller and webhooks keep it current after that.
    setTimeout(() => syncPayout(payout.id).catch(() => {}), 2500);
    return db.byId('payouts', payout.id);
  } finally {
    locks.delete(challengeId);
  }
}

export function applyItemStatus(payout, item) {
  const status = STATUS_MAP[String(item.transaction_status || '').toUpperCase()] || payout.status;
  return db.update('payouts', payout.id, {
    status,
    transactionStatus: item.transaction_status || payout.transactionStatus || null,
    payoutItemId: item.payout_item_id || payout.payoutItemId || null,
    transactionId: item.transaction_id || payout.transactionId || null,
    error: item.errors?.message || (status === 'failed' ? payout.error || 'Payout failed at PayPal' : null),
  });
}

export async function syncPayout(payoutId) {
  const p = db.byId('payouts', payoutId);
  if (!p?.payoutBatchId) return p;
  const data = await paypal.getPayout(p.payoutBatchId);
  const item = (data.items || [])[0];
  if (item) return applyItemStatus(p, item);
  return db.update('payouts', p.id, { batchStatus: data.batch_header?.batch_status || p.batchStatus });
}

// Webhooks are the fast path; this poller makes the app work without them too.
export function startPayoutPoller() {
  const timer = setInterval(async () => {
    const open = db.filter('payouts', (p) => p.payoutBatchId && !TERMINAL.has(p.status));
    for (const p of open) {
      try {
        await syncPayout(p.id);
      } catch (err) {
        console.warn(`[poller] payout ${p.id}: ${err.message}`);
      }
    }
  }, config.payoutPollMs);
  timer.unref();
}

/** Closes the queue and refunds whatever part of the prize pool was not awarded. */
export async function endChallenge(challengeId) {
  const c = getChallenge(challengeId);
  if (c.status === 'settled') throw new HttpError(409, 'Challenge is already settled');
  if (payoutsFor(c.id).some((p) => p.status === 'creating')) {
    throw new HttpError(409, 'A payout is still being created. Try again in a moment.');
  }

  const endedAt = c.endedAt || new Date().toISOString();
  for (const q of queueFor(c.id)) {
    if (q.status === 'live') db.update('queue', q.id, { status: 'done', endedAt });
    if (q.status === 'waiting') db.update('queue', q.id, { status: 'closed' });
  }

  if (c.status === 'awaiting_funding') {
    return db.update('challenges', c.id, { status: 'settled', endedAt });
  }

  db.update('challenges', c.id, { status: 'ended', endedAt });
  const leftover = balances(c).available;
  if (leftover <= 0 || !c.paypalCaptureId) {
    return db.update('challenges', c.id, { status: 'settled', refundError: null });
  }

  try {
    const refund = await paypal.refundCapture(c.paypalCaptureId, leftover, `LP-refund-${c.id}-${leftover}`);
    return db.update('challenges', c.id, {
      status: 'settled',
      refundedCents: (c.refundedCents || 0) + leftover,
      refundId: refund.id,
      refundStatus: refund.status,
      refundError: null,
    });
  } catch (err) {
    // Stays "ended" so the creator can retry the refund.
    db.update('challenges', c.id, { refundError: err.message });
    throw err;
  }
}
