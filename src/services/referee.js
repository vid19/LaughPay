// The AI referee's judgement: Claude (Haiku) looks at the on-device detector's
// measurements plus one webcam snapshot from the peak moment, and returns a verdict
// and a one-line ruling for the stream. Claude never moves money: the deterministic
// checks in payouts.js decide whether a payout is allowed at all.
import { config } from '../config.js';

const { anthropicKey, model, sendSnapshot } = config.referee;

const SYSTEM = `You are the AI referee for LaughPay, a live "make me laugh, win cash" stream challenge.
A caller is on a video call trying to make the creator laugh. An on-device detector measured the creator's face (smile, open jaw, squinting eyes) and their microphone (a laughter sound classifier), and fired because the combined score stayed high.
Decide whether the CREATOR genuinely laughed. A broad smile alone, talking, coughing, or a brief smirk is not a laugh. Laughing with a closed mouth but clear laughter audio can count.
You do not move money; separate rules decide payouts. Your job is an honest, explainable call that viewers will see on stream.
Always answer by calling the submit_ruling tool.`;

// Forcing a tool call guarantees a structured verdict instead of free text.
const RULING_TOOL = {
  name: 'submit_ruling',
  description: 'Submit the referee verdict for this detected laugh.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['laugh', 'unclear', 'no_laugh'], description: 'Did the creator genuinely laugh?' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      ruling: { type: 'string', description: "One sentence, max 20 words, shown on the stream overlay. May mention the caller's handle." },
    },
    required: ['verdict', 'confidence', 'ruling'],
  },
};

const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

function fallbackRuling(m, callerName) {
  const held = (m.durationMs / 1000).toFixed(1);
  const verdict = m.peak >= 0.7 && m.durationMs >= 500 ? 'laugh' : 'unclear';
  const ruling =
    verdict === 'laugh'
      ? `Clear laugh for ${callerName}: peak ${r2(m.peak)}, held ${held}s.`
      : `Possible laugh for ${callerName}: peak ${r2(m.peak)}, held ${held}s. Creator to confirm.`;
  return { verdict, confidence: clamp(m.peak), ruling, source: 'rules' };
}

function readRuling(data) {
  const call = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_ruling');
  if (!call) {
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    throw new Error(`No ruling in reply (stop_reason ${data.stop_reason}): ${text.slice(0, 160)}`);
  }
  const j = call.input || {};
  if (!['laugh', 'unclear', 'no_laugh'].includes(j.verdict)) throw new Error('Bad verdict');
  return { verdict: j.verdict, confidence: clamp(j.confidence), ruling: String(j.ruling || '').slice(0, 160) };
}

/**
 * @param {object} m metrics from the detector: peak, avg, durationMs, face, audio, timeline, callerLiveMs
 * @param {object} ctx { callerName, flags, snapshotBase64 }
 */
export async function judgeLaugh(m, ctx) {
  if (!anthropicKey) return { ...fallbackRuling(m, ctx.callerName), note: 'ANTHROPIC_API_KEY not set' };

  const facts = {
    caller: ctx.callerName,
    seconds_caller_has_been_live: r2(m.callerLiveMs / 1000),
    peak_combined_score: r2(m.peak),
    average_score_while_triggered: r2(m.avg),
    seconds_above_threshold: r2(m.durationMs / 1000),
    face_score_at_peak: r2(m.face),
    laughter_audio_score_at_peak: r2(m.audio),
    detector_threshold: r2(m.threshold),
    score_timeline_last_3s_at_10hz: (m.timeline || []).map(r2),
    rule_flags: ctx.flags,
  };

  const content = [];
  if (sendSnapshot && ctx.snapshotBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ctx.snapshotBase64 } });
    content.push({ type: 'text', text: 'Webcam snapshot of the creator at the peak moment.' });
  }
  content.push({ type: 'text', text: `Detector measurements:\n${JSON.stringify(facts, null, 2)}` });

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: SYSTEM,
        tools: [RULING_TOOL],
        tool_choice: { type: 'tool', name: 'submit_ruling' },
        messages: [{ role: 'user', content }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    return { ...readRuling(data), source: 'claude', model: data.model || model, ms: Date.now() - started };
  } catch (err) {
    console.warn('[referee] Claude call failed, using rule-based ruling:', err.message);
    return { ...fallbackRuling(m, ctx.callerName), note: `Claude unavailable: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}
