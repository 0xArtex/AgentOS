---
name: palmyr
description: Buy real-world infrastructure agents normally can't get without a credit card, phone, or KYC — a prepaid Visa card loaded with an exact USD balance, a phone number for SMS and voice calls, an email inbox on a custom domain, domain registration, X/Twitter accounts (buy, post, reply, follow) and TikTok accounts (connect, post, schedule, follow, like, delete, profile, analytics), a VPS to deploy and run commands on, and a crypto wallet that trades tokens on Solana and Base. Everything is paid per action via x402 (USDC on Base or Solana) with no API key and no signup — the wallet is the identity. There is also an i402 intent resolver that turns a natural-language intent plus a budget into an ordered, priced plan of calls to sign. Use this when an agent needs to pay per action, mentions Palmyr, x402, or i402, or needs a payment card for fiat checkouts, SMS, a one-time SMS or email verification code (via a cheap disposable temp number or inbox), a phone number, an email inbox, a registered domain, a social account, compute or a VPS, a wallet, or on-chain trading.
license: MIT
metadata:
  author: palmyr
  version: "2.0"
  cli: "@palmyr/cli"
---

# Palmyr — infrastructure for AI agents

Real-world capabilities an agent normally can't get without a credit card, phone, or KYC — bought per action via x402 (USDC on Base or Solana). No API key, no signup: the wallet is the identity.

- **CLI:** `npm i -g @palmyr/cli` (or `npx @palmyr/cli`)
- **API:** `https://palmyr.ai`
- **MCP:** `https://palmyr.ai/mcp`
- **Source:** https://github.com/0xArtex/Palmyr

## When to use this skill

Reach for Palmyr when an agent needs to:

- buy a **prepaid Visa card** loaded with an exact USD balance (pay any US checkout that takes cards)
- send/receive **SMS** or place a **voice call** from a real **phone number** — or lease a cheap **disposable temp number** ($0.20/30min) just to catch a one-time SMS verification code (`phone temp`)
- read/send **email** on a Palmyr or custom-domain **inbox** — or spin up a cheap **disposable temp inbox** ($0.50) for a one-time verification / order-confirmation email (`email temp`)
- **register a domain**
- buy and operate an **X/Twitter** account (post, reply, follow), or connect and operate a **TikTok** account (post, schedule, follow, like, delete, profile, analytics) — TikTok accounts are connected, not bought
- **deploy a VPS**, run commands on it, or bootstrap an agent runtime
- create a **crypto wallet** and **trade** tokens on Solana + Base
- **pay per action** (x402 / USDC) for infra that is otherwise credit-card, SMS, or KYC gated
- turn a natural-language **intent + budget** into an ordered, priced plan (**i402**)

Prefer the CLI — fewer tokens, cleaner output. Every command maps to an HTTP endpoint if you'd rather call it directly.

## Setup

```bash
npm i -g @palmyr/cli

# Create an HD wallet (Solana + Base from one mnemonic), ready to pay via x402.
# Set PALMYR_WALLET_PASSPHRASE FIRST so the wallet stays recoverable across reboot,
# OS-keychain loss, or host migration. Without it, `wallet create` errors (or prompts on a TTY).
PALMYR_WALLET_PASSPHRASE="your-passphrase" palmyr wallet create

palmyr status          # sanity check
palmyr doctor          # flags wallets that need PALMYR_WALLET_PASSPHRASE to decrypt
```

Keep `PALMYR_WALLET_PASSPHRASE` exported in whatever shell / systemd unit / agent env runs `palmyr`, so `pay`, `sign-message`, and `export` decrypt automatically when the OS keychain is unavailable (different user, fresh OS, headless box). Opt out with `palmyr wallet create --session-only` (ephemeral, NOT recoverable from the JSON file alone). Fund the wallet with USDC on Base or Solana before the first paid call.

## Payment model (x402)

1. Call any paid endpoint with no payment → `402 Payment Required` carrying the USDC amount + treasury addresses (Solana + Base).
2. Sign an x402 payment (USDC) and retry the same request with the `X-PAYMENT` header — the CLI does this automatically.
3. On success your **wallet address owns the resource**; reuse the same wallet to access it later. No API key, no signup.

Solana is verified + settled in-process (you need only USDC, no SOL for gas); Base settles via a facilitator. If a handler fails *after* you paid, the charge is **auto-refunded** to the payer wallet. Free endpoints (search, pricing, availability, ownership-proof reads) never 402. Full detail: https://palmyr.ai/skill/references/payment.md.

## MCP server

Any MCP client can connect to **`https://palmyr.ai/mcp`** (Streamable HTTP, stateless — plain JSON responses, no session id). Curated Palmyr capabilities are exposed as tools. Free tools (`palmyr_pricing`, capabilities) return immediately. A **paid** tool called with no `payment` argument returns x402 instructions as a normal (non-error) result — sign the payment, then call the same tool again with `payment=<base64 X-PAYMENT>`. Same money model as the HTTP API.

## i402 intent resolver

`POST /chat` (0.10 USDC flat) turns a natural-language **intent + budget** into an ordered, priced plan the agent executes itself. Send `{ intent, budget_usdc, params?, constraints?, deadline_seconds? }`; pay the 402 challenge, and the paid call returns `200` with:

- `steps[]` — each has `capability`, `provider`, `input`, `cost_usdc`, `depends_on`, and an `x402` block (`endpoint`, `method`, `payment_rail: x402-solana | x402-base`).
- `totals` — `step_cost_usdc`, `orchestration_fee_usdc`, `total_cost_usdc`, `within_budget`, `eta_seconds`.

**The agent signs and runs each x402 call itself** — there is no server-side execution or escrow. Over budget → a non-executable preview unless you pass `allow_budget_exceeded: true`. Ambiguous intents come back as clarifying `questions` instead of steps. Free helpers: `GET /chat/capabilities`, `GET /chat/providers`.

## Capabilities index

Fetch a reference file only when the task needs it.

| Capability | Reference (fetch on demand) | Read when |
|---|---|---|
| Prepaid Visa cards | https://palmyr.ai/skill/references/card.md | buying a card with an exact balance, fetching its number/CVV, or checking balance |
| Phone / SMS / voice | https://palmyr.ai/skill/references/phone.md | provisioning a number, sending SMS, or running a voice call |
| Email + inboxes | https://palmyr.ai/skill/references/email.md | creating/reading inboxes, sending mail, or decrypting E2E messages |
| Domains | https://palmyr.ai/skill/references/domains.md | checking, pricing, registering, or sharing a domain |
| Social (X + TikTok) | https://palmyr.ai/skill/references/social.md | buying/importing an account, posting, or transferring/sharing/disputing one |
| Wallets + trading | https://palmyr.ai/skill/references/trading.md | creating wallets in bulk, buying/selling tokens, or running the monitor daemon |
| Compute / VPS | https://palmyr.ai/skill/references/compute.md | deploying a VPS, running commands, or bootstrapping an agent runtime |
| Payment / x402 detail | https://palmyr.ai/skill/references/payment.md | before the first paid call, or when parsing 402s, exit codes, or refunds |

Full price list: `palmyr pricing` or `GET /pricing`. Machine-readable spec: `GET /openapi.json` and `GET /.well-known/x402`.

## Gotchas

- **Async ops return `202` + `poll_url`** (TikTok posts, account transfers, VPS provision). **Poll the `poll_url`; do NOT re-send the paid request** — retrying pays again. Poll routes are free or ~$0.0001.
- **TikTok scheduling is TikTok's own, and caps at ~10 days.** `schedule_at` drives TikTok Studio's native scheduler, which accepts only ~15 minutes to ~10 days ahead — anything outside that is rejected and refunded, and there is no way to schedule further out. A scheduled post returns `scheduled_at` and **no `video_url`** (TikTok holds the video until it publishes), so never chain a step on `video_url` after scheduling one.
- **Sessions go stale.** `palmyr tiktok session <user>` only reports the age of a cached session — it performs no login and refreshes nothing. To re-establish a TikTok session use `palmyr tiktok connect <user> --server`; for X use `palmyr twitter login <user>`. An account connected with `--server` keeps its session in its own browser profile on the server, so there is no local jar to go stale.
- **Handler failure after payment auto-refunds** to the payer wallet (idempotent, retried hourly) — don't manually re-pay a failed call; check for the refund first.
- **Spend ceiling:** set `PALMYR_MAX_USDC` (or `--max-usdc`) to cap what any single call will sign — the CLI refuses to pay above it.
- **Exit code 7 = vault tamper / security check failed — do NOT retry.** (Full exit-code table in references/payment.md.)
- **X/Twitter has velocity caps** — space out posts/follows; bursts get throttled or flagged.
- **`--dry-run` is strictly read-only** for trading — it never mutates position files. Use it to validate before spending.
- **E2E email is opt-in:** an inbox created with a Solana pubkey is sealed to that key (server can't read it) and returns `w:` ciphertext you decrypt yourself (references/email.md). Without one, it's server-side AES at rest.
