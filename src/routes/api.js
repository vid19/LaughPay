import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { toCents } from '../money.js';
import { paypal } from '../paypal/index.js';
import {
  creatorView, currentEntry, getChallenge, hashKey, joinQueue, publicView, queueFor, resultsView,
} from '../services/challenges.js';
import { endChallenge, payWinner, syncPayout } from '../services/payouts.js';
import { getViewer } from '../services/viewers.js';

const r = Router();

function requireCreator(req) {
  const c = getChallenge(req.params.id);
  const key = req.get('x-creator-key') || '';
  if (!key || hashKey(key) !== c.creatorKeyHash) throw new HttpError(401, 'Creator key is missing or wrong');
  return c;
}

function requireViewer(req) {
  const viewer = getViewer(req);
  if (!viewer) throw new HttpError(401, 'Sign in with PayPal first');
  return viewer;
}

function text(value, { field, min = 0, max }) {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `${field} must be ${min}-${max} characters`);
  return s;
}

r.get('/config', (_req, res) => {
  res.json({
    mock: config.paypal.mock,
    clientId: config.paypal.mock ? null : config.paypal.clientId,
    currency: config.currency,
  });
});

// ---------- Creator: create and fund ----------

r.post('/challenges', (req, res) => {
  const b = req.body || {};
  const title = text(b.title, { field: 'Title', min: 3, max: 80 });
  const rules = text(b.rules, { field: 'Rules', max: 500 });
  const creatorName = text(b.creatorName, { field: 'Creator name', min: 1, max: 40 });
  const prizePerWinCents = toCents(b.prizePerWin);
  if (!(prizePerWinCents >= 100 && prizePerWinCents <= 100_000)) throw new HttpError(400, 'Prize per win must be between $1 and $1,000');
  const maxWinners = Number(b.maxWinners);
  if (!Number.isInteger(maxWinners) || maxWinners < 1 || maxWinners > 10) throw new HttpError(400, 'Winners must be a whole number from 1 to 10');

  const creatorKey = crypto.randomBytes(18).toString('base64url');
  const c = db.insert('challenges', {
    id: crypto.randomBytes(4).toString('hex'),
    title,
    rules,
    creatorName,
    prizePerWinCents,
    maxWinners,
    totalCents: prizePerWinCents * maxWinners,
    status: 'awaiting_funding',
    creatorKeyHash: hashKey(creatorKey),
  });
  res.status(201).json({ id: c.id, creatorKey });
});

r.get('/challenges/:id/creator', (req, res) => {
  res.json(creatorView(requireCreator(req)));
});

r.post('/challenges/:id/fund/order', async (req, res) => {
  const c = requireCreator(req);
  if (c.status !== 'awaiting_funding') throw new HttpError(409, 'This challenge is already funded');
  // The amount always comes from the server-side record, never from the browser.
  const order = await paypal.createOrder({
    amountCents: c.totalCents,
    description: `LaughPay prize pool: ${c.title}`.slice(0, 127),
    customId: c.id,
    requestId: `LP-order-${c.id}-${Date.now()}`,
  });
  db.update('challenges', c.id, { paypalOrderId: order.id });
  res.json({ id: order.id });
});

r.post('/challenges/:id/fund/capture', async (req, res) => {
  const c = requireCreator(req);
  const orderId = String(req.body?.orderID || '');
  if (c.status === 'live' && c.paypalOrderId === orderId) return res.json(creatorView(c));
  if (c.status !== 'awaiting_funding') throw new HttpError(409, 'This challenge is already funded');
  if (!orderId || orderId !== c.paypalOrderId) throw new HttpError(400, 'Order does not match this challenge');

  const result = await paypal.captureOrder(orderId);
  const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
  if (result.status !== 'COMPLETED' || capture?.status !== 'COMPLETED') {
    throw new HttpError(402, `Payment not completed (status ${capture?.status || result.status})`);
  }
  const captured = toCents(capture.amount.value);
  if (captured < c.totalCents) throw new HttpError(402, 'Captured amount is less than the prize pool');

  db.update('challenges', c.id, {
    status: 'live',
    fundedCents: captured,
    paypalCaptureId: capture.id,
    fundedAt: new Date().toISOString(),
  });
  res.json(creatorView(getChallenge(c.id)));
});

// ---------- Creator: run the challenge ----------

r.post('/challenges/:id/next', (req, res) => {
  const c = requireCreator(req);
  if (c.status !== 'live') throw new HttpError(409, 'Challenge is not live');
  const now = new Date().toISOString();
  const current = currentEntry(c);
  if (current) db.update('queue', current.id, { status: 'done', endedAt: now });
  const next = queueFor(c.id).find((q) => q.status === 'waiting');
  if (next) db.update('queue', next.id, { status: 'live', startedAt: now });
  res.json(creatorView(getChallenge(c.id)));
});

r.post('/challenges/:id/winner', async (req, res) => {
  const c = requireCreator(req);
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : undefined;
  await payWinner(c.id, { reason, source: 'manual' });
  res.json(creatorView(getChallenge(c.id)));
});

r.post('/challenges/:id/payouts/:payoutId/refresh', async (req, res) => {
  const c = requireCreator(req);
  const p = db.byId('payouts', req.params.payoutId);
  if (!p || p.challengeId !== c.id) throw new HttpError(404, 'Payout not found');
  await syncPayout(p.id);
  res.json(creatorView(getChallenge(c.id)));
});

r.post('/challenges/:id/end', async (req, res) => {
  const c = requireCreator(req);
  await endChallenge(c.id);
  res.json(creatorView(getChallenge(c.id)));
});

// ---------- Viewers ----------

r.get('/challenges/:id', (req, res) => {
  res.json(publicView(getChallenge(req.params.id), getViewer(req)));
});

r.post('/challenges/:id/queue/join', (req, res) => {
  const viewer = requireViewer(req);
  const c = getChallenge(req.params.id);
  joinQueue(c, viewer);
  res.json(publicView(c, viewer));
});

r.post('/challenges/:id/queue/leave', (req, res) => {
  const viewer = requireViewer(req);
  const c = getChallenge(req.params.id);
  const entry = db.find('queue', (q) => q.challengeId === c.id && q.viewerId === viewer.id && q.status === 'waiting');
  if (entry) db.update('queue', entry.id, { status: 'left' });
  res.json(publicView(c, viewer));
});

r.get('/challenges/:id/results', (req, res) => {
  res.json(resultsView(getChallenge(req.params.id)));
});

export default r;
