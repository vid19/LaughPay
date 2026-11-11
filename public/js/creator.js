import { $, api, badge, clock, copy, esc, money, pathId, poll, timeAgo, toast } from '/js/common.js';

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
$('#nextBtn').onclick = () => act(() => call('/next'));
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
