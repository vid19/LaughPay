# LaughPay

Live creator challenges with a verified PayPal call queue and instant PayPal payouts.

Streamers run challenges like "make me laugh, win $100," but paying the winner is messy: emails get read out on stream, fake winners flood the DMs, and money gets sent by hand after the stream. LaughPay fixes the money side. Viewers join the call queue by signing in with PayPal, so every caller is verified and payable before they go live. The creator taps **Winner** and PayPal Payouts sends the prize while the winner is still on the call. Any prize money that was not awarded is refunded when the challenge ends.

> **Status: v1.** This version covers the full PayPal money loop with the creator judging by hand. v2 adds the AI referee (real-time laugh detection on the creator's camera) that triggers the same payout flow automatically.

## How it uses PayPal

| PayPal capability | What it does in LaughPay |
| --- | --- |
| **Orders v2 + JS SDK buttons** | The creator funds the prize pool before the challenge goes live |
| **Log in with PayPal** | Viewers sign in to join the queue; LaughPay stores their PayPal payer ID |
| **Payouts** | Pays the winner's PayPal account (by payer ID, never an email typed on stream) |
| **Webhooks** | Payout item and capture events update the dashboard and the stream overlay |
| **Refunds** | Returns unawarded prize money to the creator when the challenge ends |

Money safety rules enforced on the server:

- Amounts always come from the server-side challenge record, never from the browser.
- Each win creates a judge event first; its ID becomes the payout `sender_batch_id`, so PayPal rejects any duplicate and a double click can never pay twice.
- A payout only goes to the caller who is live at that moment, one win per PayPal account per challenge, and only while funded balance remains.
- Webhooks are signature-verified with PayPal and de-duplicated by event ID. Payout status is also polled, so the app works even when webhooks are not set up.
- The client secret, payouts and refunds stay server-side.

## Quick start (no PayPal account needed)

Requires Node.js 18.17 or newer.

```bash
npm install
cp .env.example .env
# in .env set PAYPAL_MOCK=true
npm start
```

Open http://localhost:3000, create a challenge, then click **Simulate PayPal checkout**. In another terminal, `npm run seed` creates a funded demo challenge with three queued viewers and prints its links.

## Running against the PayPal sandbox

### 0. Get a stable public URL first

PayPal needs a real https address for the login Return URL and for webhooks. Claim a free static domain in the ngrok dashboard under **Domains** (for example `your-name.ngrok-free.app`), then set `BASE_URL=https://your-name.ngrok-free.app` in `.env`. Everywhere below, `<BASE_URL>` means that exact address. Do not type the `<BASE_URL>` placeholder itself.

### 1. Create the sandbox app

1. Sign in at [developer.paypal.com](https://developer.paypal.com) and switch the toggle to **Sandbox**.
2. Go to **Apps & Credentials > Create App** (type: Merchant). Copy the **Client ID** and **Secret** into `.env`.
3. In the app's features, make sure **Payouts** is enabled.
4. Tick **Log in with PayPal**, open **Advanced settings**, and:
   - set the **Return URL** to `<BASE_URL>/auth/paypal/callback`, for example `https://your-name.ngrok-free.app/auth/paypal/callback` (https, no trailing slash; changes can take up to three hours to apply)
   - share **Full name**, **Email** and **PayPal account ID (payer ID)**
   - click **Save**.
5. Under **Sandbox > Accounts**, use the default **Business** account (it receives the prize pool and sends payouts) and create two or three **Personal** accounts to play the creator and the callers.

### 2. Expose the app with ngrok (for webhooks and login)

```bash
ngrok http --url=your-name.ngrok-free.app 3000
```

Use the same static domain you put in `BASE_URL` and in the Log in with PayPal Return URL.

### 3. Add the webhook (optional, recommended)

In the app settings under **Sandbox Webhooks**, add `<BASE_URL>/api/webhooks/events` (PayPal rejects webhook URLs containing the word "paypal") and subscribe to:

- `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `.FAILED`, `.UNCLAIMED`, `.RETURNED`, `.BLOCKED`, `.HELD`, `.CANCELED`, `.REFUNDED`
- `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`

Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`.

### 4. Run

```bash
PAYPAL_MOCK=false npm start
```

## Demo flow

1. **Create a challenge** on the home page. You land on the creator dashboard (its private link carries your creator key).
2. **Fund the prize pool** with the PayPal button, paying with a sandbox Personal account.
3. **Add the overlay to OBS** as a Browser Source: `<BASE_URL>/overlay/<id>` (transparent background; add `?bg=1` to preview it in a normal browser).
4. **Share the join link.** Viewers open `<BASE_URL>/c/<id>`, click **Join with PayPal**, and see their place in line.
5. **Run the challenge.** Click **Bring on first caller**, then **Next caller** to move through the queue.
6. **Pick a winner.** Click **Winner · Pay $X**. The overlay shows "Sending via PayPal", then "Paid via PayPal ✓". Log in to the winner's sandbox Personal account to see the money arrive.
7. **End the challenge.** Leftover prize money is refunded to the creator. The public results log at `<BASE_URL>/c/<id>/results` lists every win with its PayPal transaction reference.

## Project structure

```
src/
  server.js              Express app, page routes, error handling
  config.js              Environment config (sandbox only)
  db.js                  JSON-file data store (data/db.json)
  session.js             Signed cookies for viewer sessions
  paypal/real.js         PayPal REST client: Orders, Payouts, Refunds, Identity, Webhooks
  paypal/mock.js         Fake PayPal with the same responses, for PAYPAL_MOCK=true
  services/challenges.js Challenge state, balances, queue, public and creator views
  services/payouts.js    Paying winners, payout status sync, refunds on end
  services/viewers.js    Log in with PayPal identities
  routes/api.js          JSON API for the creator dashboard and viewer pages
  routes/auth.js         Log in with PayPal (OAuth code flow)
  routes/webhooks.js     Verified PayPal webhooks
public/                  index, creator dashboard, join page, OBS overlay, results log
scripts/seed.js          Creates a demo challenge on a running server
scripts/reset.js         Clears local data (stop the server first)
```

Styles are compiled with Tailwind into `public/tailwind.css`. After changing classes in `public/`, run `npm run build:css`.

## API overview

| Method | Path | Who |
| --- | --- | --- |
| POST | `/api/challenges` | Create a challenge (returns the creator key) |
| GET | `/api/challenges/:id/creator` | Creator dashboard state |
| POST | `/api/challenges/:id/fund/order` · `/fund/capture` | Fund the prize pool |
| POST | `/api/challenges/:id/next` | Move to the next caller |
| POST | `/api/challenges/:id/winner` | Pay the live caller |
| POST | `/api/challenges/:id/payouts/:payoutId/refresh` | Re-check a payout with PayPal |
| POST | `/api/challenges/:id/end` | Close the queue and refund the leftover |
| GET | `/api/challenges/:id` | Public state, plus the signed-in viewer's place in line |
| POST | `/api/challenges/:id/queue/join` · `/queue/leave` | Viewer joins or leaves |
| GET | `/api/challenges/:id/results` | Public results log |
| GET | `/auth/paypal/login?challenge=:id` | Start Log in with PayPal |
| POST | `/api/webhooks/events` | PayPal webhook receiver |

Creator endpoints require the `x-creator-key` header.

## Notes and limits

- Sandbox only. LaughPay v1 never calls live PayPal.
- Viewers never pay anything. The creator funds every prize, so this is a giveaway, not a game of chance.
- In this prototype the prize pool sits in the app's sandbox business account. A production version would use a licensed marketplace or partner model, with legal review.
- Video calls run in any tool the creator already uses; LaughPay tracks who is live. Built-in calls arrive with the AI referee in v2.

## License

[MIT](LICENSE)
