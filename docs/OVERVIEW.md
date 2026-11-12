# LaughPay

**Live challenges for creators, refereed by AI, paid instantly through PayPal.**

LaughPay lets a streamer run a live "make me laugh, win cash" challenge from start to finish: verified callers join a queue with their PayPal account, each one goes live on a built-in video call, an AI referee catches the moment the creator genuinely laughs, and the prize lands in the winner's PayPal account while they are still on the call.

---

## The problem

Live challenges are one of the most popular formats on YouTube and Twitch. Viewers hop on a call and try to make the creator laugh, flinch or lose a game, and the winner gets paid. The format is fun; the money side is not.

- **Winners expose their details on stream.** Creators ask winners to read out or type their PayPal email in front of thousands of viewers.
- **Fake claims flood in.** After a win, the creator's DMs fill with people claiming to be the winner, and there is no easy way to prove who was actually on the call.
- **Judging is disputed.** "He laughed!" versus "No I didn't!" is part of the fun, but there is no neutral record when chat accuses the creator of rigging the result.
- **Payouts happen late or never.** Money is sent by hand after the stream, so winners wait and some payments are forgotten.
- **The tooling is stitched together.** Calls run in one app, the queue in a spreadsheet or Discord, and payments in a third tool, so it is easy to pay the wrong person.

## The solution

LaughPay puts the whole loop in one product:

1. **The creator funds the prize pool** with PayPal Checkout before going live, so viewers know the money is real.
2. **Viewers join the queue by signing in with PayPal.** Every caller is a verified, payable PayPal account before they ever appear on screen. No email is ever typed or read aloud.
3. **Callers go live on a built-in video call**, one at a time. The person on camera is always the verified account in the queue.
4. **An AI referee watches the creator.** It detects a genuine laugh from the creator's face and voice, Claude reviews the moment, and the ruling appears on stream.
5. **The winner is paid instantly through PayPal Payouts**, with one click from the creator or automatically for clear laughs.
6. **Every result is auditable.** A public results log shows each win with its timestamp, the AI's ruling, a snapshot of the moment and the PayPal transaction reference.
7. **Leftover prize money is refunded** to the creator when the challenge ends.

## What makes LaughPay different

- **Identity and payout are one step.** Signing in with PayPal to join the queue means the caller is already verified and payable. Fake winner claims are impossible because money only goes to the account that was live at the moment of the win.
- **An impartial AI referee, not just a button.** On-device face and laughter detection catches the laugh, and Claude explains the call in plain language. It settles the classic "you laughed!" argument with evidence viewers can see.
- **AI judges, rules guard the money.** Claude can explain a decision and can hold back an automatic payout, but it can never authorize one on its own. Every payout still has to pass deterministic server checks. This is a deliberate, explainable safety design.
- **Paid before they hang up.** Payouts go out while the winner is still on the call, and the stream overlay flips from "Sending" to "Paid via PayPal" in front of the audience.
- **Privacy by design.** The creator's video and audio are analyzed inside their own browser. Only the measurements and one small snapshot of the creator at the peak moment leave the device, and snapshots become public only as evidence for a paid win.
- **No gambling mechanics.** Viewers never pay to play. The creator funds every prize, which keeps LaughPay a giveaway rather than a game of chance.
- **Platform agnostic.** The overlay is a browser source in OBS, so it works with YouTube, Twitch or any streaming platform.

## Who it is for

Small and mid-size streamers who run live challenges, giveaways and call-in segments, and who today juggle Discord, spreadsheets and manual PayPal transfers to make them work. Viewers benefit too: a fair, transparent game with fast payouts and no need to share personal details on stream.

---

## What we built

### 1. PayPal money loop

| PayPal capability | Role in LaughPay |
| --- | --- |
| Orders v2 with JavaScript SDK buttons | Creator funds the prize pool before the challenge goes live |
| Log in with PayPal | Viewers sign in to join the queue; LaughPay stores their PayPal payer ID |
| Payouts | Pays the winner's PayPal account by payer ID, never by an email typed on stream |
| Webhooks (signature verified) | Payout and capture events update the dashboard and the stream overlay |
| Refunds | Returns unawarded prize money to the creator when the challenge ends |

Money safety rules enforced on the server:

- Amounts always come from the server-side challenge record, never from the browser.
- Each win creates a judge event first; its ID becomes the payout batch ID, so PayPal rejects any duplicate and a double click can never pay twice.
- A payout only goes to the caller who is live at that moment, with one win per PayPal account per challenge, and only while funded balance remains.
- Webhooks are verified with PayPal and de-duplicated. Payout status is also polled, so the app stays correct even if a webhook is delayed.
- The PayPal client secret, payouts and refunds stay server-side.

All of this has been tested end to end against the PayPal sandbox, including confirming the prize arriving in the winner's sandbox wallet.

### 2. AI referee

1. **On-device detection.** MediaPipe Face Landmarker reads smile, open-jaw and eye-squint signals from the creator's webcam every frame, and the YAMNet audio classifier scores the microphone for laughter. Both run in the browser in WebAssembly.
2. **Calibration.** The creator keeps a straight face for 5 seconds so the detector learns their neutral look and the room's background sound.
3. **Fused laugh score.** Face and laughter audio combine into one smoothed score. A laugh counts only if the score stays above the threshold for 0.6 seconds, and laughter from the speakers alone can never trigger it because the creator's own face has to move.
4. **Claude's review.** The server sends Claude Haiku 5.5 the measurements and one snapshot from the peak moment. Claude returns a structured verdict (laugh, unclear or no laugh), a confidence score and a one-line ruling shown on the overlay, the dashboard and the results log.
5. **Two payout modes.** In confirm mode the creator approves each win with one click. In auto-pay mode, a laugh pays out on its own only when Claude says "laugh", the peak score is high and no rule flags were raised.

In live testing, the referee correctly rejected a broad smile as "no laugh" and approved a real laugh, with rulings that matched the snapshot.

| AI tool | Where it runs | What it does |
| --- | --- | --- |
| MediaPipe Face Landmarker | Creator's browser | Facial blendshapes for smile, jaw and eye squint |
| YAMNet audio classifier | Creator's browser | Laughter detection from the microphone |
| Claude Haiku 5.5 (Claude API) | Server | Reviews each detected laugh and writes the on-stream ruling |

### 3. Built-in video call

Callers go live inside LaughPay on a direct browser-to-browser WebRTC call. The creator sees the caller on the dashboard next to their own referee camera, and **Next caller** hangs up and connects the next person automatically. The server only relays the connection setup; the video itself never passes through it. A TURN server can be configured for strict networks.

### 4. Screens

- **Creator dashboard:** fund the pool, run the AI referee, see the live caller on video, review detected laughs, pay winners, track payouts and end the challenge.
- **Viewer join page:** sign in with PayPal, see your place in line, join the call when it is your turn, and see your prize arrive.
- **OBS overlay:** prize, prizes left, who is on the line, a live laugh meter, a "Laugh detected" flash and the winner banner with the AI ruling.
- **Public results log:** every win with time, judge, AI ruling, snapshot, amount and PayPal transaction reference.

---

## How it works

```
Creator funds pool ──► PayPal Orders (capture) ──► challenge goes live
                                                         │
Viewer ──► Log in with PayPal ──► verified queue entry ──┤
                                                         ▼
                        Built-in WebRTC call (creator ◄──► live caller)
                                                         │
Creator's browser: MediaPipe face + YAMNet audio ──► laugh detected
                                                         │
Server: Claude Haiku reviews measurements + snapshot ──► verdict and ruling
                                                         │
Creator confirms (or auto-pay for clear laughs) ──► deterministic payout checks
                                                         │
PayPal Payouts ──► webhook ──► overlay shows "Paid via PayPal"
                                                         │
End challenge ──► PayPal Refund of the unawarded balance
```

**Tech stack:** Node.js and Express 5, plain HTML and JavaScript with Tailwind, a JSON file store, server-sent events for real-time updates, WebRTC for calls, MediaPipe Tasks (vision and audio) in the browser, and the Claude API on the server. Everything runs against the PayPal sandbox.

## Trust, safety and privacy

- Viewers never pay to enter; the creator funds every prize.
- No PayPal email or personal detail is ever shown on stream. Winner names are shortened (for example "Maya C.").
- The AI explains and can block an automatic payout, but cannot authorize one.
- Video and audio analysis happens on the creator's device. Only one peak-moment snapshot is sent to Claude, and that can be turned off.
- Simulated laughs (a test feature) are labelled everywhere and never auto-pay.
- In this prototype the prize pool sits in the app's sandbox business account. A production version would use a licensed marketplace or partner model, with legal review.

## How LaughPay maps to the judging criteria

| Criterion | Why LaughPay scores well |
| --- | --- |
| Technological implementation | Five PayPal capabilities wired end to end, real-time multimodal AI on device, a Claude review step with structured output, and built-in WebRTC calls |
| Design | A complete product for both sides: creator dashboard, viewer join page, stream overlay and public results log |
| Potential impact | Solves a visible, everyday problem for streamers who run challenges and giveaways, and makes payouts safer for viewers |
| Innovation | An AI referee that turns a human reaction into a verified, explainable payment trigger |
| Presentation | A real laugh, an AI ruling and a payout landing live on camera make a memorable demo |

## Roadmap

- **More challenge types on the same engine:** staring contests (blink detection), trivia, "say the magic word" (speech-to-text plus Claude) and creator-defined rules in plain English.
- **Direct platform hooks:** read YouTube and Twitch chat for a chat-based challenge mode.
- **Managed calls at scale:** move from direct WebRTC to a managed media service such as LiveKit.
- **Production payments model:** licensed marketplace setup for holding prize pools, per-creator onboarding and payout reporting.
- **Hosted deployment** on Render with persistent storage.

## Status

| Area | Status |
| --- | --- |
| PayPal funding, login, payouts, webhooks, refunds | Built and tested against the PayPal sandbox |
| AI referee (on-device detection plus Claude rulings) | Built and tested with a real camera and the Claude API |
| Built-in video call | Built and tested across two browsers |
| Hosted deployment (Render) | Next |
| Demo video | Next |
