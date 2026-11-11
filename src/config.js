import 'dotenv/config';

const port = Number(process.env.PORT || 3000);

export const config = {
  port,
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'laughpay-dev-secret-change-me',
  currency: 'USD',
  dataFile: process.env.DATA_FILE || 'data/db.json',
  payoutPollMs: Number(process.env.PAYOUT_POLL_MS || 8000),
  paypal: {
    mock: String(process.env.PAYPAL_MOCK || '').toLowerCase() === 'true',
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
    // Sandbox only. LaughPay v1 never talks to live PayPal.
    apiBase: 'https://api-m.sandbox.paypal.com',
    webBase: 'https://www.sandbox.paypal.com',
  },
};

export function configWarnings() {
  const warnings = [];
  const { paypal } = config;
  if (paypal.mock) {
    warnings.push('PAYPAL_MOCK=true: PayPal calls are simulated. Turn it off for the real sandbox demo.');
    return warnings;
  }
  if (!paypal.clientId || !paypal.clientSecret) {
    warnings.push('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are missing. Fill in .env or set PAYPAL_MOCK=true.');
  }
  if (!paypal.webhookId) {
    warnings.push('PAYPAL_WEBHOOK_ID is not set: webhooks are ignored and payout status is polled instead.');
  }
  if (config.sessionSecret === 'laughpay-dev-secret-change-me') {
    warnings.push('SESSION_SECRET is the default value. Set your own in .env.');
  }
  return warnings;
}
