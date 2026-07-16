> Fetch this when provisioning a phone number, sending SMS, waiting for an SMS verification code (OTP), or running a voice call.

# Palmyr — Phone, SMS & Voice

Every command is `palmyr phone ...` and maps to an HTTP endpoint (table below). Pay per action via x402.

## CLI

```bash
palmyr phone search --country US                     # Search numbers (free)
palmyr phone buy --country US                        # Buy a number ($3)
palmyr phone sms --id ID --to +1... --body "hi"      # Send SMS ($0.05)
palmyr phone wait-otp ID --timeout 90                # Wait for a verification code ($0.02)
palmyr phone call --id ID --to +1... --tts "hello"   # Voice call ($0.10)
```

## API

| Action | Endpoint | Cost (USDC) |
|---|---|---|
| Search numbers | `GET /phone/numbers/search?country=US` | Free |
| Provision number | `POST /phone/numbers` | 3.00 |
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

## Waiting for a verification code (OTP)

`POST /phone/numbers/:id/wait-otp` blocks until an SMS verification code arrives on your number, then returns the parsed code — use it after submitting the number to a signup/2FA form instead of polling `messages` yourself. Body (all optional): `timeout_s` (default 60, max 90), `lookback_s` (default 10 — also matches codes that arrived up to this many seconds before the call; **pass `lookback_s: 0` when reusing a number across signups** so a previous signup's stale code can't be re-served), `pattern` (custom extraction regex, max 256 chars; first capture group wins — a pattern that exceeds its per-match budget is dropped mid-wait, extraction falls back to the defaults, and the response carries `pattern_timeout: true`). Default extraction handles standalone 4–8 digit codes, `code is`/`code:` tokens, and Google-style `G-XXXXXX`. Returns `{ found: true, code, message_text, message_id, received_at }` on a hit, or `{ found: false, waited_s }` on timeout — not an error, just call again.

## Webhooks

- **SMS inbound:** messages to your number arrive via Telnyx webhook → stored, readable via `GET /phone/numbers/:id/messages`.
- **Voice events:** `call.initiated`, `call.answered`, `call.hangup`, `call.recording.saved`, `call.gather.ended`.
