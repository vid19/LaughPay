import { $, api, badge, clock, copy, esc, money, pathId, poll, timeAgo, toast } from '/js/common.js';
import { LaughDetector } from '/js/referee.js';
import { CallHost } from '/js/call.js';

const id = pathId();
const storeKey = `lp_creator_${id}`;
let key = null;
let view = null;
let busy = false;
let fundingRendered = false;

// ---------- creator key: from #key=..., else localStorage ----------
const hashKey = new URLSearchParams(location.hash.slice(1)).get('key');
if (hashKey) {
  try { localStorage.setItem(storeKey, hashKey); } catch {}
  history.replaceState(null, '', location.pathname);
}
try { key = hashKey || localStorage.getItem(storeKey); } catch { key = hashKey; }

$('#keyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  key = $('#keyInput').value.trim();
  try { localStorage.setItem(storeKey, key); } catch {}
  start();
});

const call = (path, method = 'POST', body) => api(`/api/challenges/${id}${path}`, { method, body, creatorKey: key });

async function act(fn, okMsg) {
  if (busy) return;
  busy = true;
  render();
  try {
    view = await fn();
    if (okMsg) toast(okMsg);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    busy = false;
    render();
  }
}

// ---------- funding: PayPal JS SDK buttons (or a simulated checkout in mock mode) ----------
async function renderFunding() {
  if (fundingRendered) return;
  fundingRendered = true;
  const cfg = await api('/api/config');
  const box = $('#ppButtons');

  if (cfg.mock) {
    box.innerHTML = '<button class="btn btn-pp w-full">Simulate PayPal checkout</button><p class="muted text-xs mt-2">Mock mode: no real PayPal calls.</p>';
    box.querySelector('button').onclick = () =>
      act(async () => {
        const order = await call('/fund/order');
        return call('/fund/capture', 'POST', { orderID: order.id });
      }, 'Prize pool funded. You are live.');
    return;
  }
  if (!cfg.clientId) {
    box.innerHTML = '<p class="text-sm" style="color:var(--bad)">PAYPAL_CLIENT_ID is not set on the server.</p>';
    return;
  }

  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.clientId)}&currency=${cfg.currency}&intent=capture&components=buttons`;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the PayPal SDK'));
    document.head.appendChild(s);
  }).catch((err) => toast(err.message, 'err'));

  if (!window.paypal) return;
  window.paypal
    .Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'pay', height: 45 },
      createOrder: async () => (await call('/fund/order')).id,
      onApprove: async (data) => {
        try {
          view = await call('/fund/capture', 'POST', { orderID: data.orderID });
          toast('Prize pool funded. You are live.');
          render();
        } catch (err) {
          toast(err.message, 'err');
        }
      },
      onError: (err) => toast(err?.message || 'PayPal checkout failed', 'err'),
    })
    .render('#ppButtons');
}

// ---------- rendering ----------
function render() {
  if (!view) return;
  const v = view;
  const ended = ['ended', 'settled'].includes(v.status);
  const live = v.queue.live;

  $('#title').textContent = v.title;
  $('#byline').textContent = `Hosted by ${v.creatorName}`;
  $('#status').innerHTML = badge(v.status);
  $('#overlayLink').href = v.links.overlay;
  $('#resultsLink').href = v.links.results;

  // funding
  const needsFunding = v.status === 'awaiting_funding';
  $('#funding').hidden = !needsFunding;
  $('#poolAmount').textContent = money(v.totalPool);
  if (needsFunding) renderFunding();

  // stage
  $('#liveTag').innerHTML = live ? '<span class="onair">Live</span>' : '';
  $('#liveName').innerHTML = live ? esc(live.name) : '<span class="muted">Nobody on the line</span>';
  $('#liveMeta').textContent = live ? `On since ${clock(live.since)}` : `${v.queue.waitingCount} waiting in the queue`;
  $('#callBox').hidden = !live;
  if (callHost) callHost.setLiveEntry(v.liveEntry?.id || null);
  if (live) callLabel(live.name);
  const alreadyWon = live && v.liveAlreadyWon;
  const canWin = v.status === 'live' && live && !alreadyWon && v.prizesLeft > 0 && !busy;
  $('#winnerBtn').textContent = `Winner · Pay ${money(v.prizePerWin)}`;
  $('#winnerBtn').disabled = !canWin;
  $('#nextBtn').textContent = live ? 'Next caller' : 'Bring on first caller';
  $('#nextBtn').disabled = v.status !== 'live' || busy || (!live && v.queue.waitingCount === 0);
  $('#stageHint').textContent =
    v.status === 'awaiting_funding' ? 'Fund the prize pool to go live.'
    : ended ? 'This challenge has ended.'
    : v.prizesLeft === 0 ? 'All prizes have been awarded.'
    : alreadyWon ? `${live.name} already won. Bring on the next caller.`
    : `${v.prizesLeft} prize${v.prizesLeft === 1 ? '' : 's'} left. Payouts go to the caller's verified PayPal account.`;

  // balances
  const b = v.balances;
  $('#balances').innerHTML = [
    ['Funded', b.funded], ['Paid out', b.paid], ['Committed', b.committed], ['Refunded', b.refunded], ['Available', b.available],
  ].map(([k, val]) => `<dt class="muted">${k}</dt><dd class="mono text-right ${k === 'Available' ? 'font-bold' : ''}">${money(val)}</dd>`).join('');
  $('#perWin').textContent = money(v.prizePerWin);
  $('#winCount').textContent = `${v.winnersCount} / ${v.maxWinners}`;

  // queue
  const active = v.queueFull.filter((q) => ['live', 'waiting'].includes(q.status));
  $('#queueCount').textContent = `${v.queue.waitingCount} waiting`;
  $('#queue').innerHTML = active.length
    ? active.map((q, i) => `
        <li class="flex items-center justify-between rounded-xl px-3 py-2" style="background:var(--panel-2)">
          <span><span class="mono muted mr-2">${q.status === 'live' ? '▶' : i + (active[0]?.status === 'live' ? 0 : 1)}</span>${esc(q.name)}</span>
          <span class="muted text-xs">${q.status === 'live' ? '<span class="onair">Live</span>' : `joined ${timeAgo(q.joinedAt)}`}</span>
        </li>`).join('')
    : '<li class="muted">Share the join link. Viewers sign in with PayPal to get in line.</li>';

  // payouts
  $('#payouts').innerHTML = v.payouts.length
    ? `<thead><tr><th>Winner</th><th>Amount</th><th>Status</th><th>PayPal ref</th><th></th></tr></thead><tbody>${v.payouts.map((p) => `
        <tr>
          <td><div class="font-semibold">${esc(p.name)}</div><div class="muted text-xs">${clock(p.at)} · ${esc(p.source)}</div></td>
          <td class="mono">${money(p.amount)}</td>
          <td>${badge(p.status)}${p.error ? `<div class="text-xs mt-1" style="color:var(--bad)">${esc(p.error)}</div>` : ''}</td>
          <td class="mono text-xs muted">${esc(p.transactionId || p.payoutBatchId || '–')}</td>
          <td>${p.payoutBatchId && !['succeeded', 'failed', 'returned', 'blocked'].includes(p.status) ? `<button class="btn text-xs py-1 px-2" data-refresh="${esc(p.id)}">Refresh</button>` : ''}</td>
        </tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="muted">No winners yet.</td></tr></tbody>';

  renderLaugh(v);

  // end
  $('#endBtn').disabled = busy || v.status === 'settled';
  $('#endBtn').textContent = v.status === 'ended' ? 'Retry refund' : endArmed ? `Click again to end and refund ${money(b.available)}` : 'End and refund leftover';
  $('#refundInfo').innerHTML = v.paypal.refundError
    ? `<span style="color:var(--bad)">${esc(v.paypal.refundError)}</span>`
    : v.paypal.refundId ? `Refunded ${money(b.refunded)} to the creator · <span class="mono muted text-xs">${esc(v.paypal.refundId)}</span>`
    : v.status === 'settled' ? 'Settled. Nothing left to refund.' : '';
}

let endArmed = false;
let endTimer;

$('#winnerBtn').onclick = () => act(() => call('/winner', 'POST', {}), 'Payout sent through PayPal');
$('#nextBtn').onclick = () => {
  callHost?.ensureMedia().catch((err) => toast(`Camera for the call: ${err.message}`, 'err'));
  act(() => call('/next'));
};
$('#copyJoin').onclick = () => view && copy(view.links.join);
$('#payouts').addEventListener('click', (e) => {
  const pid = e.target.closest('[data-refresh]')?.dataset.refresh;
  if (pid) act(() => call(`/payouts/${pid}/refresh`));
});
$('#endBtn').onclick = () => {
  if (view?.status !== 'ended' && !endArmed) {
    endArmed = true;
    render();
    clearTimeout(endTimer);
    endTimer = setTimeout(() => { endArmed = false; render(); }, 4000);
    return;
  }
  endArmed = false;
  act(() => call('/end'), 'Challenge ended');
};

let stopPolling = null;

function start() {
  if (!key) {
    $('#keyGate').hidden = false;
    return;
  }
  if (stopPolling) stopPolling();
  stopPolling = poll(async () => {
    try {
      view = await call('/creator', 'GET');
      startCall();
      $('#keyGate').hidden = true;
      $('#app').hidden = false;
      if (!busy) render();
    } catch (err) {
      if (err.status === 401) {
        $('#keyGate').hidden = false;
        $('#app').hidden = true;
      } else throw err;
    }
  }, 2000);
}

start();

// ---------- AI referee ----------
const snapshots = new Map(); // laugh event id -> local snapshot (the creator's own copy)
const STATUS_UI = {
  off: ['Off', 'b-settled'],
  loading: ['Loading', 'b-pending'],
  calibrating: ['Calibrating', 'b-pending'],
  armed: ['Armed', 'b-live'],
  error: ['Error', 'b-failed'],
};
const VERDICT_UI = { laugh: ['Laugh', 'b-live'], unclear: ['Unclear', 'b-pending'], no_laugh: ['No laugh', 'b-failed'] };
const refMode = () => document.querySelector('input[name="refMode"]:checked')?.value || 'confirm';
let reporting = false;
let lastMeterPost = 0;

const detector = new LaughDetector({
  video: $('#refVideo'),
  onStatus(state, detail) {
    const [label, cls] = STATUS_UI[state] || STATUS_UI.off;
    $('#refStatus').className = `badge ${cls}`;
    $('#refStatus').textContent = label;
    if (detail) $('#refHint').textContent = detail;
    const on = state !== 'off' && state !== 'error';
    $('#refStart').textContent = on ? 'Stop referee' : 'Start AI referee';
    $('#refStart').classList.toggle('btn-spot', !on);
    $('#refRecal').hidden = !['armed', 'calibrating'].includes(state);
    $('#refCam').hidden = !on;
    $('#refGrid').classList.toggle('cam-on', on);
  },
  onTick({ score, face, audio, audioRaw, micLevel, audioOk, faceFound, threshold, simulating }) {
    $('#refFill').style.width = `${Math.round(score * 100)}%`;
    $('#refFill').classList.toggle('hot', score >= threshold);
    $('#refMark').style.left = `${threshold * 100}%`;
    $('#refNums').textContent = simulating
      ? 'simulated'
      : detector.state === 'off'
        ? '–'
        : !audioOk && $('#refMic').checked
          ? `face ${face.toFixed(2)} · mic not running`
          : `face ${face.toFixed(2)} · laugh ${audioRaw.toFixed(2)} · mic ${Math.round(micLevel * 100)}%`;
    $('#refFaceTag').textContent = faceFound ? 'Face found' : 'No face';
    $('#refFaceTag').style.color = faceFound ? 'var(--money)' : 'var(--warn)';

    const now = performance.now();
    const armed = (detector.state === 'armed' || simulating) && view?.status === 'live' && Boolean(view?.liveEntry);
    if (key && view && now - lastMeterPost > 300 && (armed || score > 0.02)) {
      lastMeterPost = now;
      call('/meter', 'POST', { score, threshold, armed }).catch(() => {});
    }
  },
  async onLaugh(m) {
    const v = view;
    const why =
      !v || v.status !== 'live' ? 'the challenge is not live'
      : !v.liveEntry ? 'nobody is on the line'
      : v.liveAlreadyWon ? 'this caller already won'
      : v.prizesLeft <= 0 ? 'no prizes are left'
      : v.laugh && ['reviewing', 'pending'].includes(v.laugh.status) ? 'a laugh is already waiting for review'
      : !m.simulated && Date.now() - new Date(v.liveEntry.startedAt).getTime() < 2000 ? 'the caller only just came on'
      : null;
    if (why) {
      if (m.simulated) toast(`Laugh ignored: ${why}`, 'err');
      return;
    }
    if (reporting) return;
    reporting = true;
    try {
      const next = await call('/laughs', 'POST', { ...m, queueEntryId: v.liveEntry.id, mode: refMode() });
      if (next.laugh) snapshots.set(next.laugh.id, m.snapshot);
      view = next;
      render();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      reporting = false;
    }
  },
});

function renderLaugh(v) {
  const box = $('#laughBox');
  const l = v.laugh;
  if (!l || l.status === 'dismissed') {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const snap = snapshots.get(l.id);
  const [vLabel, vCls] = VERDICT_UI[l.verdict] || [];
  const meta = [
    `peak ${l.peak.toFixed(2)}`,
    `held ${(l.durationMs / 1000).toFixed(1)}s`,
    `face ${l.face.toFixed(2)}`,
    `audio ${l.audio.toFixed(2)}`,
  ].join(' · ');
  let body;
  if (l.status === 'reviewing') {
    body = '<p class="mt-2">Claude is reviewing the moment…</p>';
  } else if (l.status === 'paid') {
    body = `<p class="mt-2">${esc(l.ruling || '')}</p><p class="mt-2 font-semibold" style="color:var(--money)">Paid via PayPal ✓ ${l.mode === 'auto' ? '(auto-paid)' : ''}</p>`;
  } else {
    body = `
      <p class="mt-2 text-lg font-semibold">${esc(l.ruling || 'Laugh detected')}</p>
      ${l.flags.length ? `<p class="text-xs mt-1" style="color:var(--warn)">Flags: ${l.flags.map((f) => esc(f.replace(/_/g, ' '))).join(', ')}</p>` : ''}
      ${l.autoError ? `<p class="text-xs mt-1" style="color:var(--bad)">Auto-pay stopped: ${esc(l.autoError)}</p>` : ''}
      <div class="flex flex-wrap gap-2 mt-3">
        <button class="btn btn-spot" data-laugh="confirm" data-id="${esc(l.id)}">Confirm and pay ${money(v.prizePerWin)}</button>
        <button class="btn" data-laugh="dismiss" data-id="${esc(l.id)}">Not a laugh</button>
      </div>`;
  }
  box.innerHTML = `
    ${snap ? `<img src="${snap}" alt="Snapshot of the laugh" />` : '<div class="noimg"></div>'}
    <div>
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-bold">Laugh detected · ${esc(l.callerName)}</span>
        ${vLabel ? `<span class="badge ${vCls}">${vLabel}</span>` : ''}
        ${l.simulated ? '<span class="badge b-pending">Simulated</span>' : ''}
      </div>
      <div class="muted text-xs mt-1 mono">${meta}${l.judgedBy ? ` · ${esc(l.judgedBy)}` : ''}</div>
      ${body}
    </div>`;
}

$('#laughBox').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-laugh]');
  if (!btn) return;
  const { laugh: action, id: lid } = btn.dataset;
  act(() => call(`/laughs/${lid}/${action}`), action === 'confirm' ? 'Payout sent through PayPal' : 'Dismissed');
});

$('#refStart').onclick = async () => {
  if (!['off', 'error'].includes(detector.state)) {
    detector.stop();
    $('#refHint').textContent = 'Referee stopped.';
    return;
  }
  const head = await fetch('/models/face_landmarker.task', { method: 'HEAD' }).catch(() => null);
  if (!head?.ok) {
    detector.onStatus('error', 'The AI models are missing. Run "npm run setup:models" in the project folder, then reload.');
    return;
  }
  try {
    await detector.start({ useMic: $('#refMic').checked });
  } catch (err) {
    detector.stop();
    const msg = err?.name === 'NotAllowedError' ? 'Camera or microphone permission was denied. Allow it in the browser and try again.' : `Could not start: ${err?.message || err}`;
    detector.onStatus('error', msg);
  }
};
$('#refRecal').onclick = () => detector.calibrate();
$('#refSim').onclick = () => {
  if (!view?.liveEntry) return toast('Bring a caller on first, then simulate a laugh', 'err');
  detector.simulate();
};
$('#refSens').oninput = (e) => {
  detector.threshold = Number(e.target.value);
  $('#refSensVal').textContent = Number(e.target.value).toFixed(2);
};

// ---------- built-in video call ----------
let callHost = null;
let callState = 'idle';

function startCall() {
  if (callHost) return;
  callHost = new CallHost({
    cid: id,
    creatorKey: key,
    remoteVideo: $('#callVideo'),
    onState(state) {
      callState = state;
      callLabel(view?.queue.live?.name || 'the caller');
    },
  });
  callHost.connect().catch((err) => toast(`Call setup failed: ${err.message}`, 'err'));
}

function callLabel(name) {
  const text = {
    waiting: `Waiting for ${name} to turn on their camera…`,
    connecting: `Connecting to ${name}…`,
    reconnecting: 'Connection dropped. Reconnecting…',
    failed: `Couldn't connect to ${name}. Ask them to refresh their page.`,
  }[callState];
  $('#callState').hidden = !text;
  if (text) $('#callState').textContent = text;
}
