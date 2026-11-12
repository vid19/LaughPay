// Signaling relay for the built-in 1:1 video call between the creator and the
// caller who is live. The server only passes small messages (offer, answer, ICE
// candidates); the video itself flows directly between the two browsers.
import crypto from 'node:crypto';

const rooms = new Map(); // challengeId -> { creators: Set<res>, callers: Map<viewerId, Set<res>> }
const tokens = new Map(); // short-lived creator tokens for EventSource (which cannot send headers)

function room(cid) {
  if (!rooms.has(cid)) rooms.set(cid, { creators: new Set(), callers: new Map() });
  return rooms.get(cid);
}

export function issueCreatorToken(cid) {
  const token = crypto.randomBytes(18).toString('base64url');
  tokens.set(token, { cid, exp: Date.now() + 12 * 60 * 60 * 1000 });
  return token;
}

export function checkCreatorToken(cid, token) {
  const t = tokens.get(String(token || ''));
  return Boolean(t && t.cid === cid && t.exp > Date.now());
}

function openStream(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  return () => clearInterval(heartbeat);
}

export function subscribeCreator(cid, req, res) {
  const stop = openStream(req, res);
  const r = room(cid);
  r.creators.add(res);
  req.on('close', () => {
    stop();
    r.creators.delete(res);
  });
}

export function subscribeCaller(cid, viewerId, req, res) {
  const stop = openStream(req, res);
  const r = room(cid);
  if (!r.callers.has(viewerId)) r.callers.set(viewerId, new Set());
  const set = r.callers.get(viewerId);
  set.add(res);
  req.on('close', () => {
    stop();
    set.delete(res);
  });
}

const write = (res, msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);

export function toCreator(cid, msg) {
  for (const res of room(cid).creators) write(res, msg);
}

export function toCaller(cid, viewerId, msg) {
  for (const res of room(cid).callers.get(viewerId) || []) write(res, msg);
}
