import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { fmt } from '../money.js';
import { laughView } from './laughView.js';

// Payout states that mean the money did NOT reach the winner.
const FAILED_PAYOUT = new Set(['failed', 'returned', 'blocked']);
export const countsAsWin = (p) => !FAILED_PAYOUT.has(p.status);

export const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

export function getChallenge(id) {
  const c = db.byId('challenges', id);
  if (!c) throw new HttpError(404, 'Challenge not found');
  return c;
}

export const payoutsFor = (challengeId) =>
  db.filter('payouts', (p) => p.challengeId === challengeId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export const queueFor = (challengeId) =>
  db.filter('queue', (q) => q.challengeId === challengeId).sort((a, b) => a.position - b.position);

export const currentEntry = (c) => queueFor(c.id).find((q) => q.status === 'live') || null;

export function winsFor(c) {
  return payoutsFor(c.id).filter(countsAsWin).length;
}

export function balances(c) {
  const payouts = payoutsFor(c.id);
  const committed = payouts.filter(countsAsWin).reduce((s, p) => s + p.amountCents, 0);
  const paid = payouts.filter((p) => p.status === 'succeeded').reduce((s, p) => s + p.amountCents, 0);
  const funded = c.fundedCents || 0;
  const refunded = c.refundedCents || 0;
  return { funded, committed, paid, refunded, available: Math.max(0, funded - committed - refunded) };
}

export function prizesLeft(c) {
  const byCount = c.maxWinners - winsFor(c);
  if (c.status === 'awaiting_funding') return byCount;
  return Math.max(0, Math.min(byCount, Math.floor(balances(c).available / c.prizePerWinCents)));
}

const viewerName = (viewerId) => db.byId('viewers', viewerId)?.displayName || 'Someone';

export function joinQueue(c, viewer) {
  if (['ended', 'settled'].includes(c.status)) throw new HttpError(409, 'This challenge has ended');
  const existing = db.find(
    'queue',
    (q) => q.challengeId === c.id && q.viewerId === viewer.id && ['waiting', 'live'].includes(q.status),
  );
  if (existing) return existing;
  const position = queueFor(c.id).reduce((m, q) => Math.max(m, q.position), 0) + 1;
  return db.insert('queue', { challengeId: c.id, viewerId: viewer.id, position, status: 'waiting', joinedAt: new Date().toISOString() });
}

function aiEvidence(ev) {
  const laugh = ev?.evidence?.laughEventId ? db.byId('laughEvents', ev.evidence.laughEventId) : null;
  if (!laugh) return null;
  const v = laughView(laugh);
  return {
    ruling: v.ruling,
    verdict: v.verdict,
    judgedBy: v.judgedBy,
    peak: v.peak,
    heldMs: v.durationMs,
    simulated: v.simulated,
    decidedBy: laugh.decidedBy || null,
    snapshotUrl: laugh.hasSnapshot ? `/api/laughs/${laugh.id}/snapshot.jpg` : null,
  };
}

function publicPayout(p) {
  const ev = db.byId('judgeEvents', p.judgeEventId);
  return {
    id: p.id,
    name: viewerName(p.viewerId),
    amount: fmt(p.amountCents),
    status: p.status,
    source: ev?.source || 'manual',
    reason: ev?.reason || '',
    at: ev?.at || p.createdAt,
    transactionRef: p.transactionId ? `…${p.transactionId.slice(-6)}` : null,
    ai: aiEvidence(ev),
  };
}

function links(c) {
  return {
    join: `${config.baseUrl}/c/${c.id}`,
    overlay: `${config.baseUrl}/overlay/${c.id}`,
    results: `${config.baseUrl}/c/${c.id}/results`,
    creator: `${config.baseUrl}/creator/${c.id}`,
  };
}

export function publicView(c, viewer = null) {
  const queue = queueFor(c.id);
  const waiting = queue.filter((q) => q.status === 'waiting');
  const live = queue.find((q) => q.status === 'live');

  let me = null;
  if (viewer) {
    const entry = [...queue].reverse().find((q) => q.viewerId === viewer.id) || null;
    const myPayout = payoutsFor(c.id).filter((p) => p.viewerId === viewer.id && countsAsWin(p)).pop();
    me = {
      name: viewer.displayName,
      entryStatus: entry?.status || null,
      entryId: entry?.id || null,
      ahead: entry?.status === 'waiting' ? waiting.filter((q) => q.position < entry.position).length : null,
      win: myPayout ? publicPayout(myPayout) : null,
    };
  }

  return {
    id: c.id,
    title: c.title,
    rules: c.rules,
    creatorName: c.creatorName,
    status: c.status,
    currency: config.currency,
    prizePerWin: fmt(c.prizePerWinCents),
    maxWinners: c.maxWinners,
    prizesLeft: prizesLeft(c),
    winnersCount: winsFor(c),
    queue: {
      waitingCount: waiting.length,
      live: live ? { name: viewerName(live.viewerId), since: live.startedAt } : null,
      upNext: waiting.slice(0, 5).map((q) => viewerName(q.viewerId)),
    },
    winners: payoutsFor(c.id).filter(countsAsWin).map(publicPayout).reverse(),
    me,
    links: links(c),
  };
}

export function creatorView(c) {
  const live = currentEntry(c);
  return {
    ...publicView(c),
    liveAlreadyWon: Boolean(live && payoutsFor(c.id).some((p) => p.viewerId === live.viewerId && countsAsWin(p))),
    liveEntry: live ? { id: live.id, startedAt: live.startedAt } : null,
    laugh: live
      ? laughView(
          db
            .filter('laughEvents', (e) => e.queueEntryId === live.id && e.status !== 'expired')
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .pop() || null,
        )
      : null,
    totalPool: fmt(c.totalCents),
    balances: Object.fromEntries(Object.entries(balances(c)).map(([k, v]) => [k, fmt(v)])),
    paypal: {
      orderId: c.paypalOrderId || null,
      captureId: c.paypalCaptureId || null,
      refundId: c.refundId || null,
      refundError: c.refundError || null,
    },
    queueFull: queueFor(c.id).map((q) => ({
      id: q.id,
      name: viewerName(q.viewerId),
      status: q.status,
      position: q.position,
      joinedAt: q.joinedAt,
      startedAt: q.startedAt || null,
    })),
    payouts: payoutsFor(c.id)
      .map((p) => ({
        ...publicPayout(p),
        payoutBatchId: p.payoutBatchId || null,
        transactionId: p.transactionId || null,
        error: p.error || null,
      }))
      .reverse(),
  };
}

export function resultsView(c) {
  return {
    id: c.id,
    title: c.title,
    creatorName: c.creatorName,
    status: c.status,
    currency: config.currency,
    fundedAt: c.fundedAt || null,
    endedAt: c.endedAt || null,
    balances: Object.fromEntries(Object.entries(balances(c)).map(([k, v]) => [k, fmt(v)])),
    results: payoutsFor(c.id).map(publicPayout).reverse(),
  };
}
