// Signed cookies without extra dependencies.
import crypto from 'node:crypto';
import { config } from './config.js';

const secure = config.baseUrl.startsWith('https://');

function mac(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

export function sign(value) {
  return `${value}.${mac(value)}`;
}

export function unsign(signed) {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const given = Buffer.from(signed.slice(i + 1));
  const expected = Buffer.from(mac(value));
  if (given.length !== expected.length) return null;
  return crypto.timingSafeEqual(given, expected) ? value : null;
}

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // ignore malformed cookie
    }
  }
  return out;
}

export function setCookie(res, name, value, maxAge) {
  res.cookie(name, sign(value), { httpOnly: true, sameSite: 'lax', secure, maxAge, path: '/' });
}

export function getCookie(req, name) {
  return unsign(readCookies(req)[name]);
}

export function clearCookie(res, name) {
  res.clearCookie(name, { path: '/' });
}
