---
name: tiktok-automation
description: Connect, post, schedule, manage, and analyze TikTok accounts through an x402 API.
homepage: https://tiktok.palmyr.ai
---

# TikTok Automation API

Use `https://tiktok.palmyr.ai` for TikTok automation. Paid actions use x402 USDC payments. There are no API keys or subscriptions.

## Discover and call

```bash
npx agentcash@latest add https://tiktok.palmyr.ai
npx agentcash@latest discover https://tiktok.palmyr.ai
npx agentcash@latest check https://tiktok.palmyr.ai/v1/post
```

AgentCash handles the x402 challenge and payment automatically:

```bash
npx agentcash@latest fetch https://tiktok.palmyr.ai/v1/connect \
  -m POST \
  -b '{"account_id":"my-brand"}'
```

Open the returned `connect_url`, scan the TikTok QR code, then poll the returned `poll_url`. The wallet that pays for the connection owns the account; use the same wallet for later actions.

Post a public video URL after the account is connected:

```bash
npx agentcash@latest fetch https://tiktok.palmyr.ai/v1/post \
  -m POST \
  -b '{"account_id":"my-brand","caption":"We shipped.","video_url":"https://example.com/launch.mp4"}'
```

TikTok actions are asynchronous. Poll `poll_url` until `done` is `true`. Never resubmit an accepted action while it is still running; payment has already settled for that operation.

## Endpoints

| Method | Path | Price |
|---|---|---:|
| POST | `/v1/connect` | $0.01 |
| GET | `/v1/connect/:token` | free |
| GET | `/v1/accounts` | $0.001 |
| POST | `/v1/post` | $0.01 |
| GET | `/v1/operations/:id` | free |
| POST | `/v1/follow` | $0.001 |
| POST | `/v1/like` | $0.001 |
| POST | `/v1/delete` | $0.001 |
| POST | `/v1/profile` | $0.001 |
| POST | `/v1/avatar` | $0.005 |
| POST | `/v1/analytics` | $0.005 |
| GET | `/v1/series` | $0.001 |
| GET | `/v1/hooks` | $0.001 account/tag, $0.05 niche |
| GET | `/v1/niches` | free |
| GET | `/v1/scheduled` | $0.001 |
| POST | `/v1/scheduled/:id/cancel` | $0.001 |
| GET | `/v1/health` | free |

Machine-readable contract: [OpenAPI](https://tiktok.palmyr.ai/openapi.json) and [x402 discovery](https://tiktok.palmyr.ai/.well-known/x402).
