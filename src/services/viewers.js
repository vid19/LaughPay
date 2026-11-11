import { db } from '../db.js';
import { getCookie } from '../session.js';

export const VIEWER_COOKIE = 'lp_viewer';

export function getViewer(req) {
  const id = getCookie(req, VIEWER_COOKIE);
  return id ? db.byId('viewers', id) : null;
}

// "Maya Chen" -> "Maya C." so full names never show on stream.
function shortName(given, family, fallback) {
  if (given) return family ? `${given} ${family[0]}.` : given;
  const parts = String(fallback || 'PayPal user').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : parts[0];
}

/** Creates or updates a viewer from the Log in with PayPal userinfo response. */
export function upsertViewer(info) {
  const primaryEmail = (info.emails || []).find((e) => e.primary)?.value || info.emails?.[0]?.value || info.email || null;
  const fields = {
    paypalUserId: info.user_id || null,
    payerId: info.payer_id || null,
    email: primaryEmail, // stored for payout fallback only; never sent to the browser
    displayName: shortName(info.given_name, info.family_name, info.name),
    lastLoginAt: new Date().toISOString(),
  };
  const existing = db.find(
    'viewers',
    (v) => (fields.paypalUserId && v.paypalUserId === fields.paypalUserId) || (fields.payerId && v.payerId === fields.payerId),
  );
  return existing ? db.update('viewers', existing.id, fields) : db.insert('viewers', fields);
}
