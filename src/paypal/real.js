// Thin client for the PayPal REST APIs LaughPay uses (sandbox only).
// Every call runs server-side; the client secret never reaches the browser.
import { config } from '../config.js';
import { PayPalError } from '../errors.js';
import { fmt } from '../money.js';

const { apiBase, webBase, clientId, clientSecret, webhookId } = config.paypal;
const basicAuth = () => Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

let cachedToken = { value: null, expiresAt: 0 };

async function parse(res, label) {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const message = data.message || data.error_description || data.name || `${label} failed`;
    throw new PayPalError(`PayPal ${label}: ${message}`, res.status, data, res.headers.get('paypal-debug-id'));
  }
  return data;
}

// Client-credentials token for the app itself, cached until shortly before expiry.
async function appToken() {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;
  if (!clientId || !clientSecret) {
    throw new PayPalError('PayPal credentials are not configured (see .env.example)', 500);
  }
  const res = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await parse(res, 'auth');
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function api(method, path, { body, requestId, label = path } = {}) {
  const headers = { Authorization: `Bearer ${await appToken()}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId; // makes retries idempotent
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse(res, label);
}

// ---------- Orders v2: creator funds the prize pool ----------

export function createOrder({ amountCents, description, customId, requestId }) {
  return api('POST', '/v2/checkout/orders', {
    label: 'create order',
    requestId,
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: customId,
          custom_id: customId,
          description,
          amount: { currency_code: config.currency, value: fmt(amountCents) },
        },
      ],
    },
  });
}

export function captureOrder(orderId) {
  return api('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    label: 'capture order',
    requestId: `capture-${orderId}`,
  });
}

export function refundCapture(captureId, amountCents, requestId) {
  return api('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    label: 'refund',
    requestId,
    body: { amount: { value: fmt(amountCents), currency_code: config.currency } },
  });
}

// ---------- Payouts: pay the winner ----------

export function createPayout({ senderBatchId, senderItemId, recipientType, receiver, amountCents, note, emailSubject }) {
  return api('POST', '/v1/payments/payouts', {
    label: 'create payout',
    body: {
      sender_batch_header: {
        sender_batch_id: senderBatchId, // PayPal rejects a reused ID, so a double click can never pay twice
        email_subject: emailSubject,
        email_message: note,
      },
      items: [
        {
          recipient_type: recipientType,
          receiver,
          amount: { value: fmt(amountCents), currency: config.currency },
          note,
          sender_item_id: senderItemId,
        },
      ],
    },
  });
}

export function getPayout(payoutBatchId) {
  return api('GET', `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`, { label: 'get payout' });
}

// ---------- Log in with PayPal: verified viewer identity ----------

const LOGIN_SCOPES = 'openid profile email https://uri.paypal.com/services/paypalattributes';

export function authorizeUrl(state, redirectUri) {
  const q = new URLSearchParams({
    flowEntry: 'static',
    client_id: clientId,
    response_type: 'code',
    scope: LOGIN_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `${webBase}/signin/authorize?${q}`;
}

export async function exchangeCode(code) {
  const res = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code }),
  });
  return parse(res, 'login code exchange');
}

export async function getUserInfo(userAccessToken) {
  const res = await fetch(`${apiBase}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, {
    headers: { Authorization: `Bearer ${userAccessToken}`, 'Content-Type': 'application/json' },
  });
  return parse(res, 'userinfo');
}

// ---------- Webhooks ----------

export async function verifyWebhook(headers, event) {
  const data = await api('POST', '/v1/notifications/verify-webhook-signature', {
    label: 'verify webhook',
    body: {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: event,
    },
  });
  return data.verification_status === 'SUCCESS';
}
