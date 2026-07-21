> Fetch this when provisioning a phone number, sending SMS, waiting for an SMS verification code (OTP), or running a voice call.

# Palmyr — Phone, SMS & Voice

Every command is `palmyr phone ...` and maps to an HTTP endpoint (table below). Pay per action via x402.

## CLI

```bash
palmyr phone search --country US                     # Search numbers (free)
palmyr phone buy --country US                        # Buy a number ($3)
palmyr phone temp --ttl 1800                          # Lease a disposable receive-only number ($0.20/30min)
palmyr phone extend PN_abc                            # Rent another 30 min on a temp number ($0.20)
palmyr phone sms --id ID --to +1... --body "hi"      # Send SMS ($0.05)
palmyr phone wait-otp ID --timeout 90                # Wait for a verification code ($0.02)
palmyr phone call --id ID --to +1... --tts "hello"   # Voice call ($0.10)
```

## API

| Action | Endpoint | Cost (USDC) |
|---|---|---|
| Search numbers | `GET /phone/numbers/search?country=US` | Free |
| Provision number | `POST /phone/numbers` | 3.00 |
| Lease temp number | `POST /phone/temp` | 0.20 |
| Extend temp number | `POST /phone/temp/:id/extend` | 0.20 |
| Send SMS | `POST /phone/numbers/:id/send` | 0.05 |
| Read messages | `GET /phone/numbers/:id/messages` | 0.02 |
| Wait for OTP | `POST /phone/numbers/:id/wait-otp` | 0.02 |
| Place call | `POST /phone/numbers/:id/call` | 0.10 |
| Speak (TTS) | `POST /phone/calls/:callControlId/speak` | 0.08 |
| Play audio | `POST /phone/calls/:callControlId/play` | 0.08 |
| Send DTMF | `POST /phone/calls/:callControlId/dtmf` | 0.02 |
| Gather input | `POST /phone/calls/:callControlId/gather` | 0.08 |
| Record call | `POST /phone/calls/:callControlId/record` | 0.10 |
| Hangup | `POST /phone/calls/:callControlId/hangup` | 0.02 |
| Answer inbound | `POST /phone/calls/:callControlId/answer` | 0.02 |
| Transfer call | `POST /phone/calls/:callControlId/transfer` | 0.10 |
| List calls | `GET /phone/numbers/:id/calls` | 0.02 |
| Call details | `GET /phone/calls/:id` | 0.02 |

## Disposable temp numbers (pooled, receive-only)

`POST /phone/temp` leases a cheap, instant, **receive-only** US number from a pre-owned pool — the phone analogue of a disposable temp email inbox. Use it to catch one SMS verification code during a signup/2FA flow, then let it evaporate. **$0.20 for 30 minutes** (`ttl_seconds`, default 1800, clamped 300–1800); `POST /phone/temp/:id/extend` rents another 30 min per $0.20 call (stackable up to **24h total**). The lease is owned by the paying wallet — read codes with `wait-otp` / `messages` exactly like a bought number. Returns `{ id, phone_number, expires_at, note }`.

Receive-only: `send` / `call` / `transfer-ownership` / `share` / `unshare` all hard-403 on a temp number (use `POST /phone/numbers` for a number that can send). `DELETE /phone/numbers/:id` early-releases the lease back to the pool. An expired lease reads/waits as **410** — lease a fresh one, no revival. When the pool is momentarily dry you get a **503** and are **not charged**.

> **Important — recycled numbers, best-effort delivery.**
> 1. **Use for one-time codes only.** These are shared pool numbers reused across agents (a number rests ~1h after your lease, then someone else can lease it). Never permanently bind a temp number to an account you want to keep (2FA / account recovery) — after your lease ends a later agent could receive that account's codes. Buy a dedicated number (`POST /phone/numbers`) for anything long-lived.
> 2. **US VoIP line — works with most, not all.** Confirmed delivering: **Google, X/Twitter, Discord**. Some services block VoIP numbers as anti-fraud: **Telegram, WhatsApp, OpenAI**. If a service rejects the number, release it and lease another (it's $0.20), or use a dedicated number.

> **VoIP reality:** Receive-only US number for verification codes. Works with most major services (confirmed: Google, X/Twitter, Discord). Some services block VoIP numbers as anti-fraud (e.g. Telegram, WhatsApp, OpenAI) — if a service rejects this number, release it and lease another, or use a dedicated number (`POST /phone/numbers`). Codes usually arrive within seconds; call `wait-otp` to receive.

Per-wallet caps: **3 concurrent** live leases and **12 per rolling 24h** (429 before charging when exceeded).

## Waiting for a verification code (OTP)

`POST /phone/numbers/:id/wait-otp` blocks until an SMS verification code arrives on your number, then returns the parsed code — use it after submitting the number to a signup/2FA form instead of polling `messages` yourself. Body (all optional): `timeout_s` (default 60, max 90), `lookback_s` (default 10 — also matches codes that arrived up to this many seconds before the call; **pass `lookback_s: 0` when reusing a number across signups** so a previous signup's stale code can't be re-served), `pattern` (custom extraction regex, max 256 chars; first capture group wins — a pattern that exceeds its per-match budget is dropped mid-wait, extraction falls back to the defaults, and the response carries `pattern_timeout: true`). Default extraction handles standalone 4–8 digit codes, `code is`/`code:` tokens, and Google-style `G-XXXXXX`. Returns `{ found: true, code, message_text, message_id, received_at }` on a hit, or `{ found: false, waited_s }` on timeout — not an error, just call again.

## Webhooks

- **SMS inbound:** messages to your number arrive via Telnyx webhook → stored, readable via `GET /phone/numbers/:id/messages`.
- **Voice events:** `call.initiated`, `call.answered`, `call.hangup`, `call.recording.saved`, `call.gather.ended`.
