# LaughPay

Live creator challenges with a verified PayPal call queue and instant PayPal payouts.

Streamers run challenges like "make me laugh, win $100," but paying the winner is messy: emails get read out on stream, fake winners flood the DMs, and money gets sent by hand after the stream. LaughPay fixes the money side. Viewers join the call queue by signing in with PayPal, so every caller is verified and payable before they go live. The creator taps **Winner** and PayPal Payouts sends the prize while the winner is still on the call. Any prize money that was not awarded is refunded when the challenge ends.

**The AI referee** watches the creator's face and listens for laughter, right in the creator's browser. When it catches a real laugh it ties it to the caller who was live, Claude reviews the moment and writes a one-line ruling for the stream, and the win pays out through PayPal, either after one click from the creator or automatically for clear laughs.

## Built-in video call

Callers go live inside LaughPay: when it is their turn, the join page asks for camera and microphone and connects them straight to the creator (a direct WebRTC call; the server only relays the connection setup). The creator sees the caller on the dashboard next to their own AI-referee camera, and **Next caller** hangs up and connects the next person automatically. The person on video is always the verified PayPal account that gets paid, so a win can never land on the wrong caller.

Direct calls work on most home and campus networks using Google's public STUN server. For strict corporate or mobile networks, add a TURN server in `.env` (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`). A production deployment would use a managed service such as LiveKit.

## How the AI referee works

1. **On-device detection.** In the creator dashboard, MediaPipe Face Landmarker reads smile, open-jaw and squint blendshapes from the webcam every frame, and the YAMNet audio classifier scores the microphone for laughter (Laughter, Giggle, Belly laugh, Chuckle and similar classes). Both run locally in WebAssembly; video and audio never leave the browser.
2. **Calibration.** The creator keeps a straight face for 5 seconds so the detector learns their neutral look and the room's background sound.
3. **Fused laugh score.** Face (65%) and laughter audio (35%) combine into one smoothed score. A laugh counts only if the score stays above the threshold for 0.6 seconds, and laughter from the speakers alone can never fire it: the creator's own face has to move.
4. **Claude's review.** The server sends Claude Haiku the measurements plus one snapshot from the peak moment. Claude returns a verdict (laugh, unclear, no laugh), a confidence, and a one-line ruling that appears on the overlay, the dashboard and the public results log.
5. **Money stays rule-based.** Claude explains and can hold back an automatic payout, but it never authorizes one on its own. A payout still has to pass every server check: the laugh belongs to the caller who is live right now, one win per PayPal account, funded balance left. Auto-pay only fires when Claude says "laugh", the peak is at least 0.7, and no rule flags were raised (caller just joined, very brief, no laughter audio, simulated).

**Simulate laugh** on the dashboard sends a fake laugh through the same pipeline, so the full flow can be tested without a camera. Simulated laughs are labelled everywhere and never auto-pay.

### AI tools used

| Tool | Where | What it does |
| --- | --- | --- |
| MediaPipe Face Landmarker (`@mediapipe/tasks-vision`) | Creator's browser | Facial blendshapes for smile, jaw and eye squint |
| YAMNet audio classifier (`@mediapipe/tasks-audio`) | Creator's browser | Laughter sound detection from the mic |
| Claude Haiku 5.5 (Claude API) | Server | Reviews each detected laugh (measurements + one snapshot) and writes the stream ruling |

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

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/vid19/LaughPay)

The repo includes a `render.yaml` Blueprint. Render installs dependencies (which also downloads the two on-device models), starts the server and checks `/healthz`. You are asked once for the secrets: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `ANTHROPIC_API_KEY` and the optional `TURN_*` values. `BASE_URL` is filled in automatically from Render's public URL.

After the first deploy, add `<your Render URL>/auth/paypal/callback` as a Return URL for Log in with PayPal, and a sandbox webhook pointing at `<your Render URL>/api/webhooks/events`.

On Render's free plan the service sleeps after a period without traffic (the first request takes up to a minute to wake it), and local data resets on each restart or deploy. That is fine for a demo; a paid instance with a persistent disk keeps challenge history.

## Quick start (no PayPal account needed)

Requires Node.js 18.17 or newer.

```bash
npm install
cp .env.example .env
# in .env set PAYPAL_MOCK=true
npm start
```

`npm install` also downloads the two on-device models (about 8 MB) into `public/models/`. If that step was offline, run `npm run setup:models`.

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

### 4. Add the Claude API key (for the AI referee)

Create a key in the [Claude Console](https://console.anthropic.com) and set `ANTHROPIC_API_KEY` in `.env`. Without a key the referee still detects laughs and falls back to a rule-based ruling.

### 5. Run

```bash
PAYPAL_MOCK=false npm start
```

## Demo flow

1. **Create a challenge** on the home page. You land on the creator dashboard (its private link carries your creator key).
2. **Fund the prize pool** with the PayPal button, paying with a sandbox Personal account.
3. **Add the overlay to OBS** as a Browser Source: `<BASE_URL>/overlay/<id>` (transparent background; add `?bg=1` to preview it in a normal browser).
4. **Share the join link.** Viewers open `<BASE_URL>/c/<id>`, click **Join with PayPal**, and see their place in line.
5. **Start the AI referee.** On the dashboard click **Start AI referee**, allow camera and microphone, and keep a straight face for 5 seconds while it calibrates. Headphones help, so the caller's own laughter does not reach your mic.
6. **Run the challenge.** Click **Bring on first caller**. The caller taps **Turn on camera and join the call** on their page and appears on your dashboard. **Next caller** hangs up and moves to the next person. The overlay shows the live laugh meter.
7. **Laugh.** The referee flags "Laugh detected", Claude's ruling appears, and you click **Confirm and pay** (or, in auto-pay mode, clear laughs pay out by themselves). You can always pick a winner by hand with **Winner · Pay $X**. The overlay shows "Sending via PayPal", then "Paid via PayPal ✓". Log in to the winner's sandbox Personal account to see the money arrive.
8. **End the challenge.** Leftover prize money is refunded to the creator. The public results log at `<BASE_URL>/c/<id>/results` lists every win with its PayPal transaction reference.

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
  services/laughs.js     AI referee flow: laugh events, confirm or auto-pay, expiry
  services/referee.js    Claude Haiku review of each laugh
  services/live.js       Server-sent events for the overlay's live laugh meter
  services/signal.js     Signaling relay for the built-in 1:1 video call
  routes/api.js          JSON API for the creator dashboard and viewer pages
  routes/auth.js         Log in with PayPal (OAuth code flow)
  routes/webhooks.js     Verified PayPal webhooks
public/                  index, creator dashboard, join page, OBS overlay, results log
public/js/referee.js     On-device laugh detector (MediaPipe face + YAMNet audio)
public/js/call.js        Built-in WebRTC call (creator places the call, caller answers)
scripts/fetch-models.js  Downloads the two on-device models (runs on npm install)
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
| POST | `/api/challenges/:id/laughs` | Detector reports a laugh (creator) |
| POST | `/api/challenges/:id/laughs/:laughId/confirm` · `/dismiss` | Creator decides on a detected laugh |
| POST | `/api/challenges/:id/meter` | Live laugh meter from the creator's browser |
| GET | `/api/challenges/:id/live` | Server-sent events for the overlay |
| POST | `/api/challenges/:id/call/token` | Creator gets a token for the call event stream |
| GET | `/api/challenges/:id/call/events` | Call signaling stream (creator token or caller session) |
| POST | `/api/challenges/:id/call/signal` | Offer, answer and ICE messages, only between the creator and the live caller |
| GET | `/auth/paypal/login?challenge=:id` | Start Log in with PayPal |
| POST | `/api/webhooks/events` | PayPal webhook receiver |

Creator endpoints require the `x-creator-key` header.

## Notes and limits

- Sandbox only. LaughPay v1 never calls live PayPal.
- Viewers never pay anything. The creator funds every prize, so this is a giveaway, not a game of chance.
- In this prototype the prize pool sits in the app's sandbox business account. A production version would use a licensed marketplace or partner model, with legal review.
- Privacy: video and audio are processed on the creator's device. Only the measurements and one small snapshot of the creator at the peak moment go to the server and to Claude (set `REFEREE_SEND_SNAPSHOT=false` to send numbers only). Snapshots become public only as evidence for a paid win.

## License

[MIT](LICENSE)
