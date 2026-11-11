import { $, api, badge, esc, money, pathId, poll, toast } from '/js/common.js';

const id = pathId();
let view = null;

const params = new URLSearchParams(location.search);
if (params.get('error')) toast(params.get('error'), 'err');
if (params.get('joined')) toast('You are in the queue');
if (params.has('error') || params.has('joined')) history.replaceState(null, '', location.pathname);

function meCard(v) {
  const me = v.me;
  const ended = ['ended', 'settled'].includes(v.status);
  const loginUrl = `/auth/paypal/login?challenge=${encodeURIComponent(id)}`;

  if (me?.win) {
    const paid = me.win.status === 'succeeded';
    return `
      <div class="label mb-2" style="color:var(--money)">You won</div>
      <div class="text-4xl font-extrabold tracking-tight">${money(me.win.amount)}</div>
      <p class="mt-2">${paid ? 'Paid to your PayPal account.' : 'On its way to your PayPal account…'}</p>
      <div class="mt-3">${badge(me.win.status)}</div>`;
  }
  if (ended) {
    return `<h2 class="text-xl font-bold">This challenge has ended</h2><p class="muted mt-1">Thanks for playing${me ? `, ${esc(me.name)}` : ''}.</p>`;
  }
  if (!me) {
    return `
      <h2 class="text-xl font-bold">Want a shot at ${money(v.prizePerWin)}?</h2>
      <p class="muted mt-1 mb-5">Sign in with PayPal to join the call queue. If you win, the prize goes straight to your PayPal account. No need to share your email on stream.</p>
      <a class="btn btn-pp btn-big w-full" href="${loginUrl}">Join with PayPal</a>`;
  }
  if (me.entryStatus === 'live') {
    return `
      <div class="onair mb-3">You're live</div>
      <h2 class="text-3xl font-extrabold tracking-tight">You're on, ${esc(me.name)}!</h2>
      <p class="muted mt-2">The creator can see you now. ${esc(v.rules || 'Give it your best shot.')}</p>`;
  }
  if (me.entryStatus === 'waiting') {
    const pos = me.ahead === 0 ? "You're next" : `${me.ahead} ahead of you`;
    return `
      <div class="label mb-2">Signed in as ${esc(me.name)}</div>
      <h2 class="text-3xl font-extrabold tracking-tight">${pos}</h2>
      <p class="muted mt-2">Keep this page open. It updates when it's your turn.</p>
      <button class="btn btn-danger mt-5" id="leaveBtn">Leave the queue</button>`;
  }
  return `
    <div class="label mb-2">Signed in as ${esc(me.name)}</div>
    <h2 class="text-xl font-bold">${me.entryStatus === 'done' ? 'Thanks for playing!' : "You're not in the queue"}</h2>
    <button class="btn btn-spot mt-5" id="joinBtn">${me.entryStatus === 'done' ? 'Join again' : 'Join the queue'}</button>`;
}

function render() {
  const v = view;
  document.title = `${v.title} · LaughPay`;
  $('#title').textContent = v.title;
  $('#byline').textContent = `${v.creatorName}'s challenge`;
  $('#rules').textContent = v.rules;
  $('#status').innerHTML = badge(v.status);
  $('#prize').textContent = money(v.prizePerWin);
  $('#left').textContent = v.prizesLeft;
  $('#waiting').textContent = v.queue.waitingCount;
  $('#resultsLink').href = `/c/${id}/results`;
  $('#me').innerHTML = meCard(v);
  $('#winners').innerHTML = v.winners.length
    ? v.winners.map((w) => `
        <li class="flex items-center justify-between rounded-xl px-3 py-2" style="background:var(--panel-2)">
          <span class="font-semibold">${esc(w.name)}</span>
          <span class="flex items-center gap-3"><span class="mono">${money(w.amount)}</span>${badge(w.status)}</span>
        </li>`).join('')
    : `<li class="muted">No winners yet. ${v.status === 'awaiting_funding' ? 'The creator is funding the prize pool.' : ''}</li>`;
}

document.addEventListener('click', async (e) => {
  const join = e.target.closest('#joinBtn');
  const leave = e.target.closest('#leaveBtn');
  if (!join && !leave) return;
  try {
    view = await api(`/api/challenges/${id}/queue/${join ? 'join' : 'leave'}`, { method: 'POST', body: {} });
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
});

poll(async () => {
  try {
    view = await api(`/api/challenges/${id}`);
    render();
  } catch (err) {
    if (err.status === 404) {
      $('#title').textContent = 'Challenge not found';
      $('#me').innerHTML = '<p class="muted">Check the link from the stream.</p>';
      return;
    }
    throw err;
  }
}, 2000);
