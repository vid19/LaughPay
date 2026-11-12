// Server-sent events: pushes the live laugh meter and "laugh detected" moments
// from the creator's browser to the OBS overlay with sub-second latency.
const channels = new Map(); // challengeId -> Set<res>
const lastMeter = new Map(); // challengeId -> last meter payload

export function subscribe(challengeId, req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  if (!channels.has(challengeId)) channels.set(challengeId, new Set());
  const set = channels.get(challengeId);
  set.add(res);

  const m = lastMeter.get(challengeId);
  if (m) res.write(`data: ${JSON.stringify(m)}\n\n`);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    set.delete(res);
  });
}

export function broadcast(challengeId, payload) {
  if (payload.type === 'meter') lastMeter.set(challengeId, payload);
  const set = channels.get(challengeId);
  if (!set) return;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(line);
}
