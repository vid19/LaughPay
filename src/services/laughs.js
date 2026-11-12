// AI referee flow on the server: a laugh detected in the creator's browser becomes
// a laugh event, Claude reviews it, and then either the creator confirms it or
// (in auto-pay mode, for clear laughs only) it pays out on its own.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { countsAsWin, currentEntry, getChallenge, payoutsFor } from './challenges.js';
import { broadcast } from './live.js';
import { payWinner } from './payouts.js';
import { judgeLaugh } from './referee.js';

const SNAP_DIR = path.join(path.dirname(path.resolve(config.dataFile)), 'snapshots');
const OPEN = new Set(['reviewing', 'pending']);
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

export const snapshotPath = (eventId) => path.join(SNAP_DIR, `${eventId}.jpg`);

export function openLaughFor(entryId) {
  return db.find('laughEvents', (e) => e.queueEntryId === entryId && OPEN.has(e.status));
}

/** Closes any undecided laugh events for a queue entry (e.g. when the creator moves to the next caller). */
export function expireLaughsFor(entryId) {
  for (const e of db.filter('laughEvents', (x) => x.queueEntryId === entryId && OPEN.has(x.status))) {
    db.update('laughEvents', e.id, { status: 'expired' });
  }
}

export async function reportLaugh(challengeId, body) {
  const c = getChallenge(challengeId);
  if (c.status !== 'live') throw new HttpError(409, 'Challenge is not live');
  const entry = currentEntry(c);
  if (!entry || entry.id !== body.queueEntryId) throw new HttpError(409, 'That caller is no longer live');
  if (payoutsFor(c.id).some((p) => p.viewerId === entry.viewerId && countsAsWin(p))) {
    throw new HttpError(409, 'This caller has already won');
  }
  const existing = openLaughFor(entry.id);
  if (existing) return existing;

  const metrics = {
    peak: num(body.peak, 0, 1),
    avg: num(body.avg, 0, 1),
    durationMs: num(body.durationMs, 0, 60_000),
    face: num(body.face, 0, 1),
    audio: num(body.audio, 0, 1),
    threshold: num(body.threshold, 0, 1),
    timeline: Array.isArray(body.timeline) ? body.timeline.slice(-30).map((v) => num(v, 0, 1)) : [],
    callerLiveMs: entry.startedAt ? Date.now() - new Date(entry.startedAt).getTime() : 0,
  };
  const simulated = Boolean(body.simulated);
  const mode = body.mode === 'auto' ? 'auto' : 'confirm';

  // Deterministic flags. These, not the LLM, are what can block an automatic payout.
  const flags = [];
  if (metrics.callerLiveMs < 3000) flags.push('caller_just_joined');
  if (metrics.durationMs < 500) flags.push('very_brief');
  if (metrics.audio < 0.1) flags.push('no_laughter_audio');
  if (simulated) flags.push('simulated');

  let snapshotBase64 = null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.snapshot || ''));
  if (m && m[1].length < 400_000) snapshotBase64 = m[1];

  const viewer = db.byId('viewers', entry.viewerId);
  const event = db.insert('laughEvents', {
    challengeId: c.id,
    queueEntryId: entry.id,
    viewerId: entry.viewerId,
    callerName: viewer?.displayName || 'Caller',
    metrics,
    flags,
    mode,
    simulated,
    hasSnapshot: Boolean(snapshotBase64),
    status: 'reviewing',
    detectedAt: new Date().toISOString(),
  });
  if (snapshotBase64) {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.writeFileSync(snapshotPath(event.id), Buffer.from(snapshotBase64, 'base64'));
  }

  broadcast(c.id, { type: 'laugh', name: event.callerName, at: event.detectedAt });

  // Claude reviews in the background; the dashboard and overlay pick up the result by polling.
  review(event.id, snapshotBase64).catch((err) => console.error('[referee]', err));
  return event;
}

async function review(eventId, snapshotBase64) {
  const event = db.byId('laughEvents', eventId);
  const judgement = await judgeLaugh(event.metrics, { callerName: event.callerName, flags: event.flags, snapshotBase64 });
  const current = db.byId('laughEvents', eventId);
  if (!OPEN.has(current.status)) return; // creator already decided or moved on

  db.update('laughEvents', eventId, { status: 'pending', judgement, reviewedAt: new Date().toISOString() });

  const autoOk =
    current.mode === 'auto' &&
    judgement.verdict === 'laugh' &&
    current.metrics.peak >= config.referee.autoPayMinPeak &&
    current.flags.length === 0;
  if (autoOk) {
    try {
      await settle(eventId, 'auto');
    } catch (err) {
      db.update('laughEvents', eventId, { status: 'pending', autoError: err.message });
    }
  }
}

async function settle(eventId, by) {
  const e = db.byId('laughEvents', eventId);
  const payout = await payWinner(e.challengeId, {
    source: 'laugh_ai',
    reason: e.judgement?.ruling || `Laugh detected for ${e.callerName}`,
    evidence: { laughEventId: e.id },
    expectedViewerId: e.viewerId,
  });
  return db.update('laughEvents', e.id, { status: 'paid', decidedBy: by, payoutId: payout.id, decidedAt: new Date().toISOString() });
}

export async function confirmLaugh(challengeId, eventId) {
  const e = db.byId('laughEvents', eventId);
  if (!e || e.challengeId !== challengeId) throw new HttpError(404, 'Laugh event not found');
  if (!OPEN.has(e.status)) throw new HttpError(409, `This laugh was already ${e.status}`);
  return settle(eventId, 'creator');
}

export function dismissLaugh(challengeId, eventId) {
  const e = db.byId('laughEvents', eventId);
  if (!e || e.challengeId !== challengeId) throw new HttpError(404, 'Laugh event not found');
  if (!OPEN.has(e.status)) return e;
  return db.update('laughEvents', e.id, { status: 'dismissed', decidedBy: 'creator', decidedAt: new Date().toISOString() });
}

export { laughView } from './laughView.js';
