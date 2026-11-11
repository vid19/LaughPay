// Log in with PayPal: every caller is a verified, payable PayPal account
// before they ever appear on stream.
import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { paypal } from '../paypal/index.js';
import { clearCookie, getCookie, setCookie } from '../session.js';
import { getChallenge, joinQueue } from '../services/challenges.js';
import { upsertViewer, VIEWER_COOKIE } from '../services/viewers.js';

const r = Router();
const OAUTH_COOKIE = 'lp_oauth';
const redirectUri = `${config.baseUrl}/auth/paypal/callback`;

r.get('/paypal/login', (req, res) => {
  const challengeId = String(req.query.challenge || '');
  if (challengeId && !db.byId('challenges', challengeId)) return res.redirect('/?error=unknown_challenge');
  const nonce = crypto.randomBytes(12).toString('base64url');
  setCookie(res, OAUTH_COOKIE, `${nonce}|${challengeId}`, 10 * 60 * 1000);
  res.redirect(paypal.authorizeUrl(nonce, redirectUri));
});

r.get('/paypal/callback', async (req, res) => {
  const saved = getCookie(req, OAUTH_COOKIE);
  clearCookie(res, OAUTH_COOKIE);
  const [nonce, challengeId] = (saved || '').split('|');
  const back = challengeId ? `/c/${challengeId}` : '/';
  const fail = (msg) => res.redirect(`${back}?error=${encodeURIComponent(msg)}`);

  if (req.query.error) return fail(`PayPal login was cancelled (${req.query.error})`);
  if (!saved || req.query.state !== nonce) return fail('Login session expired. Please try again.');

  let viewer;
  try {
    const tokens = await paypal.exchangeCode(String(req.query.code || ''));
    const info = await paypal.getUserInfo(tokens.access_token);
    viewer = upsertViewer(info);
  } catch (err) {
    console.error('[login]', err.message, err.details || '');
    return fail('Could not sign in with PayPal. Please try again.');
  }

  setCookie(res, VIEWER_COOKIE, viewer.id, 7 * 24 * 60 * 60 * 1000);
  if (challengeId) {
    try {
      joinQueue(getChallenge(challengeId), viewer);
    } catch (err) {
      return fail(err.message);
    }
  }
  res.redirect(`${back}?joined=1`);
});

r.post('/logout', (_req, res) => {
  clearCookie(res, VIEWER_COOKIE);
  res.json({ ok: true });
});

export default r;
