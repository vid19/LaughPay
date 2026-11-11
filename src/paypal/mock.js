// Fake PayPal used when PAYPAL_MOCK=true, so the full flow can be developed
// and tested without sandbox credentials. Response shapes mirror the real APIs.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { PayPalError } from '../errors.js';
import { fmt } from '../money.js';

const rand = (n = 8) => crypto.randomBytes(n).toString('hex').toUpperCase();
const orders = new Map();
const payouts = new Map();
const usedBatchIds = new Set();

export async function createOrder({ amountCents, customId }) {
  const id = `MOCKORDER${rand(5)}`;
  orders.set(id, { amountCents, customId, status: 'CREATED' });
  return { id, status: 'CREATED' };
}

export async function captureOrder(orderId) {
  const order = orders.get(orderId);
  if (!order) throw new PayPalError('PayPal capture order: order not found', 404);
  order.status = 'COMPLETED';
  order.captureId = order.captureId || `MOCKCAP${rand(5)}`;
  return {
    id: orderId,
    status: 'COMPLETED',
    purchase_units: [
      {
        payments: {
          captures: [
            {
              id: order.captureId,
              status: 'COMPLETED',
              custom_id: order.customId,
              amount: { currency_code: config.currency, value: fmt(order.amountCents) },
            },
          ],
        },
      },
    ],
  };
}

export async function refundCapture(_captureId, amountCents) {
  return { id: `MOCKREFUND${rand(5)}`, status: 'COMPLETED', amount: { value: fmt(amountCents) } };
}

export async function createPayout({ senderBatchId, senderItemId, receiver, amountCents }) {
  if (usedBatchIds.has(senderBatchId)) {
    throw new PayPalError('PayPal create payout: Batch with given sender_batch_id already exists', 400);
  }
  usedBatchIds.add(senderBatchId);
  const payoutBatchId = `MOCKBATCH${rand(5)}`;
  payouts.set(payoutBatchId, { senderItemId, receiver, amountCents, createdAt: Date.now() });
  return { batch_header: { payout_batch_id: payoutBatchId, batch_status: 'PENDING' } };
}

// Payouts flip to SUCCESS a couple of seconds after creation, like the sandbox.
export async function getPayout(payoutBatchId) {
  const p = payouts.get(payoutBatchId);
  if (!p) throw new PayPalError('PayPal get payout: batch not found', 404);
  const done = Date.now() - p.createdAt > 2000;
  return {
    batch_header: { payout_batch_id: payoutBatchId, batch_status: done ? 'SUCCESS' : 'PROCESSING' },
    items: [
      {
        payout_item_id: `MOCKITEM${payoutBatchId.slice(-6)}`,
        transaction_id: done ? `MOCKTXN${payoutBatchId.slice(-8)}` : undefined,
        transaction_status: done ? 'SUCCESS' : 'PENDING',
        payout_batch_id: payoutBatchId,
        payout_item: { sender_item_id: p.senderItemId, receiver: p.receiver, amount: { value: fmt(p.amountCents) } },
      },
    ],
  };
}

// Skips PayPal's login page and comes straight back with a fake code.
export function authorizeUrl(state, redirectUri) {
  return `${redirectUri}?${new URLSearchParams({ code: `mock_${rand(6)}`, state })}`;
}

export async function exchangeCode(code) {
  return { access_token: code };
}

const NAMES = [
  ['Maya', 'Chen'], ['Leo', 'Okafor'], ['Priya', 'Nair'], ['Sam', 'Rivera'],
  ['Ava', 'Kowalski'], ['Noah', 'Haddad'], ['Zara', 'Ali'], ['Ben', 'Moreau'],
];

export async function getUserInfo(token) {
  const n = parseInt(crypto.createHash('sha1').update(token).digest('hex').slice(0, 6), 16);
  const [given, family] = NAMES[n % NAMES.length];
  const tag = token.slice(5, 11).toLowerCase();
  return {
    user_id: `https://www.paypal.com/webapps/auth/identity/user/mock-${tag}`,
    payer_id: `MOCKPAYER${tag.toUpperCase()}`,
    name: `${given} ${family}`,
    given_name: given,
    family_name: family,
    emails: [{ value: `${given.toLowerCase()}.${tag}@example.com`, primary: true }],
  };
}

export async function verifyWebhook() {
  return true;
}
