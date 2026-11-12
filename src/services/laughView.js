// Shape of a laugh event as the dashboard, overlay and results page see it.
export function laughView(e) {
  if (!e) return null;
  return {
    id: e.id,
    status: e.status,
    callerName: e.callerName,
    detectedAt: e.detectedAt,
    mode: e.mode,
    simulated: e.simulated,
    flags: e.flags,
    peak: e.metrics.peak,
    durationMs: e.metrics.durationMs,
    face: e.metrics.face,
    audio: e.metrics.audio,
    verdict: e.judgement?.verdict || null,
    confidence: e.judgement?.confidence ?? null,
    ruling: e.judgement?.ruling || null,
    judgedBy: e.judgement ? (e.judgement.source === 'claude' ? `Claude (${e.judgement.model})` : 'Rule-based fallback') : null,
    autoError: e.autoError || null,
  };
}
