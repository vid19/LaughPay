export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

export async function api(path, { method = 'GET', body, creatorKey } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (creatorKey) headers['x-creator-key'] = creatorKey;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const money = (v) => `$${Number(v || 0).toFixed(2)}`;

export const STATUS_LABEL = {
  awaiting_funding: 'Awaiting funding',
  live: 'Live',
  ended: 'Ended',
  settled: 'Settled',
  creating: 'Sending',
  pending: 'Processing',
  succeeded: 'Paid',
  failed: 'Failed',
  returned: 'Returned',
  blocked: 'Blocked',
  on_hold: 'On hold',
  unclaimed: 'Unclaimed',
};

export const badge = (status) => `<span class="badge b-${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function clock(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
}

export function pathId() {
  return location.pathname.split('/').filter(Boolean)[1];
}

let toastTimer;
export function toast(message, kind = 'ok') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.className = `toast ${kind === 'err' ? 'err' : ''}`;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'err' ? 6000 : 3000);
}

/** Calls fn every ms milliseconds, waiting for each call to finish first. */
export function poll(fn, ms) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await fn();
    } catch (err) {
      console.warn(err);
    }
    if (!stopped) setTimeout(tick, ms);
  };
  tick();
  return () => (stopped = true);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    prompt('Copy this link:', text);
  }
}
