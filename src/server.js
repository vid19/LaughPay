import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, configWarnings } from './config.js';
import { HttpError, PayPalError } from './errors.js';
import apiRoutes from './routes/api.js';
import authRoutes from './routes/auth.js';
import webhookRoutes from './routes/webhooks.js';
import { startPayoutPoller } from './services/payouts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const page = (name) => (_req, res) => res.sendFile(path.join(pub, `${name}.html`));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // behind ngrok / Render

// Webhooks need the raw body, so they mount before the JSON parser.
app.use('/api/webhooks', webhookRoutes);
app.use(express.json({ limit: '100kb' }));
app.use('/auth', authRoutes);
app.use('/api', apiRoutes);

app.get('/', page('index'));
app.get('/creator/:id', page('creator'));
app.get('/c/:id', page('join'));
app.get('/c/:id/results', page('results'));
app.get('/overlay/:id', page('overlay'));
app.use(express.static(pub));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(pub, 'index.html'));
});

// Express 5 forwards async errors here.
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err instanceof PayPalError) {
    console.error('[paypal]', err.message, err.debugId ? `(debug id ${err.debugId})` : '', JSON.stringify(err.details));
    return res.status(502).json({ error: err.message, paypalDebugId: err.debugId, details: err.details?.details });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

app.listen(config.port, () => {
  console.log(`\nLaughPay running at ${config.baseUrl} (port ${config.port})`);
  for (const w of configWarnings()) console.warn(`  ! ${w}`);
  console.log('');
  startPayoutPoller();
});
