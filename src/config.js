import 'dotenv/config';

// Trim every setting: values pasted into hosting dashboards often carry a stray
// space or newline, which PayPal rejects as "Client Authentication failed".
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v !== v.trim()) process.env[k] = v.trim();
}

const port = Number(process.env.PORT || 3000);

export const config = {
  port,
  // Render sets RENDER_EXTERNAL_URL automatically, so BASE_URL is only needed locally (ngrok).
  baseUrl: (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'laughpay-dev-secret-change-me',
  currency: 'USD',
  dataFile: process.env.DATA_FILE || 'data/db.json',
  payoutPollMs: Number(process.env.PAYOUT_POLL_MS || 8000),
  // Video calls: STUN is enough on most home and campus networks. Add a TURN server
  // (e.g. a free metered.ca or Twilio account) for strict corporate or mobile networks.
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // TURN_URL may list several addresses, comma-separated (UDP first, then TCP/TLS fallbacks).
    ...(process.env.TURN_URL
      ? [{
          urls: process.env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean),
          username: process.env.TURN_USERNAME || '',
          credential: process.env.TURN_CREDENTIAL || '',
        }]
      : []),
  ],
  referee: {
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
    // Send the single peak-moment snapshot to Claude so it can look at the face, not just the numbers.
    sendSnapshot: String(process.env.REFEREE_SEND_SNAPSHOT || 'true').toLowerCase() !== 'false',
    // Auto-pay mode only pays on its own when the peak score is at least this high.
    autoPayMinPeak: Number(process.env.REFEREE_AUTOPAY_MIN_PEAK || 0.7),
  },
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
  if (!config.referee.anthropicKey) {
    warnings.push('ANTHROPIC_API_KEY is not set: the AI referee uses a template ruling instead of Claude.');
  }
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
