// Asks PayPal directly for the record of every payout LaughPay has sent,
// so you can confirm who received what. Read-only; safe to run while the server is up.
//   npm run check-payouts
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { paypal } from '../src/paypal/index.js';

const file = path.resolve(config.dataFile);
if (!fs.existsSync(file)) {
  console.log('No data yet. Run a challenge first.');
  process.exit(0);
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const viewers = Object.fromEntries((data.viewers || []).map((v) => [v.id, v]));
const payouts = (data.payouts || []).filter((p) => p.payoutBatchId);

if (!payouts.length) {
  console.log('No payouts have been sent yet.');
  process.exit(0);
}

for (const p of payouts) {
  const v = viewers[p.viewerId] || {};
  try {
    const res = await paypal.getPayout(p.payoutBatchId);
    const item = res.items?.[0] || {};
    console.log(`\n${v.displayName || 'Unknown'} (${v.email || 'no email on file'})`);
    console.log(`  Sent to PayPal account ID : ${item.payout_item?.receiver} (${item.payout_item?.recipient_type})`);
    console.log(`  Amount                    : ${item.payout_item?.amount?.value} ${item.payout_item?.amount?.currency}`);
    console.log(`  PayPal status             : ${item.transaction_status}`);
    console.log(`  Transaction ID            : ${item.transaction_id || '-'}`);
    console.log(`  Processed at              : ${item.time_processed || '-'}`);
  } catch (err) {
    console.log(`\n${v.displayName || 'Unknown'}: could not fetch payout ${p.payoutBatchId}: ${err.message}`);
  }
}
console.log('');
