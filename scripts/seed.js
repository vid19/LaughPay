// Creates a demo challenge on a RUNNING LaughPay server and prints its links.
// In mock mode it also funds the pool and adds three fake viewers to the queue.
//   npm run seed            (server must be running: npm start)
import 'dotenv/config';

const base = (process.env.SEED_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

async function json(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error || res.statusText}`);
  return data;
}

async function main() {
  const cfg = await json(await fetch(`${base}/api/config`)).catch(() => {
    throw new Error(`Could not reach ${base}. Start the server first with "npm start".`);
  });

  const { id, creatorKey } = await json(
    await fetch(`${base}/api/challenges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Make me laugh, win cash',
        rules: 'Hop on the call and make me laugh. One minute per caller. Keep it clean.',
        creatorName: 'Demo Creator',
        prizePerWin: 25,
        maxWinners: 2,
      }),
    }),
  );
  const auth = { 'x-creator-key': creatorKey, 'Content-Type': 'application/json' };

  if (cfg.mock) {
    const order = await json(await fetch(`${base}/api/challenges/${id}/fund/order`, { method: 'POST', headers: auth }));
    await json(await fetch(`${base}/api/challenges/${id}/fund/capture`, { method: 'POST', headers: auth, body: JSON.stringify({ orderID: order.id }) }));
    for (let i = 0; i < 3; i++) {
      // Walk the mock login flow by hand, carrying cookies between the two redirects.
      const login = await fetch(`${base}/auth/paypal/login?challenge=${id}`, { redirect: 'manual' });
      const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      await fetch(login.headers.get('location'), { redirect: 'manual', headers: { cookie } });
    }
  }

  console.log(`\nDemo challenge ${id} created${cfg.mock ? ' (mock: funded, 3 viewers queued)' : ''}\n`);
  console.log(`  Creator dashboard  ${base}/creator/${id}#key=${creatorKey}`);
  console.log(`  Viewer join page   ${base}/c/${id}`);
  console.log(`  OBS overlay        ${base}/overlay/${id}   (add ?bg=1 to preview)`);
  console.log(`  Results log        ${base}/c/${id}/results\n`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
