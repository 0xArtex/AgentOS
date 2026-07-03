> Fetch this when provisioning a phone number, sending SMS, or running a voice call.

# Palmyr — Phone, SMS & Voice

Every command is `palmyr phone ...` and maps to an HTTP endpoint (table below). Pay per action via x402.

## CLI

```bash
palmyr phone search --country US                     # Search numbers (free)
palmyr phone buy --country US                        # Buy a number ($3)
palmyr phone sms --id ID --to +1... --body "hi"      # Send SMS ($0.05)
palmyr phone call --id ID --to +1... --tts "hello"   # Voice call ($0.10)
```

## API

| Action | Endpoint | Cost (USDC) |
|---|---|---|
| Search numbers | `GET /phone/numbers/search?country=US` | Free |
| Provision number | `POST /phone/numbers` | 3.00 |
| Send SMS | `POST /phone/numbers/:id/send` | 0.05 |
| Read messages | `GET /phone/numbers/:id/messages` | 0.02 |
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

## Webhooks

- **SMS inbound:** messages to your number arrive via Telnyx webhook → stored, readable via `GET /phone/numbers/:id/messages`.
- **Voice events:** `call.initiated`, `call.answered`, `call.hangup`, `call.recording.saved`, `call.gather.ended`.
