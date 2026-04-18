<div align="center">

<img src="assets/logo.png" alt="AgentOS" width="200">

# AgentOS

**Everything your AI agent needs — one CLI.**

Phone, email, compute, domains, wallets, X accounts, and more. Pay with USDC. Your wallet is your identity.

[![npm](https://img.shields.io/npm/v/@agntos/agentos?color=f54900)](https://www.npmjs.com/package/@agntos/agentos)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/typescript-5.7-blue)](https://www.typescriptlang.org)
[![license](https://img.shields.io/badge/license-MIT-green)](https://github.com/0xArtex/AgentOS/blob/main/LICENSE)
[![services](https://img.shields.io/badge/services-7+-f54900)](https://agntos.dev/skill.md)
[![Solana](https://img.shields.io/badge/Solana-mainnet-9945FF)](https://solana.com)
[![Base](https://img.shields.io/badge/Base-mainnet-0052FF)](https://base.org)

[Quick Start](#quick-start) • [Services](#services) • [Dashboard](https://agntos.dev/dashboard.html) • [Skill File](https://agntos.dev/skill.md) • [Docs](https://agntos.dev/docs)

</div>

---

> Stop asking your human for a credit card.

## Quick Start

### CLI
```bash
npm i -g @agntos/agentos
agentos setup --keyfile ~/.config/solana/id.json --chain solana

agentos phone search --country US
agentos email create --name my-agent --wallet SOL_PUBKEY
agentos compute deploy --name my-vps --type cx23
agentos domain buy --name myagent.dev
agentos wallet create
agentos twitter buy                        # $5 USDC → ready X account from the pool
agentos twitter post @handle --body "gm"   # post immediately, no setup
```

Or run without installing: `npx @agntos/agentos phone search --country US`

### Skill File
Add to your OpenClaw / Claude Code agent: [agntos.dev/skill.md](https://agntos.dev/skill.md)

### Dashboard
Visual node-based agent deployment: [agntos.dev/dashboard.html](https://agntos.dev/dashboard.html)

## Services

| Service | Status | Cost (USDC) |
|---------|--------|-------------|
| **Phone** | ✅ Live | $2/number, $0.05/SMS, $0.10/call |
| **Voice Calls** | ✅ Live | TTS, DTMF, record, transfer, gather |
| **Email** | ✅ Live | $2/inbox, E2E encrypted (NaCl box) |
| **Compute** | ✅ Live | $8-40/mo VPS, SSH hardened, OpenClaw pre-installed |
| **Domains** | ✅ Live | Dynamic pricing, DNS management included |
| **Wallet** | ✅ Live | Non-custodial smart wallets on Base + Solana |
| **Skills** | ✅ Live | 3500+ from ClawHub, one-click install |
| **Social Media Accounts** | ✅ Live (X) | Buy ready X accounts ($5), post / reply / like / follow / update bio, name, pfp, banner, username — sticky residential IP per account |
| **Crypto Card** | 🟡 Pending | Visa debit linked to agent wallet |
| **Address** | 🟡 Pending | Physical mailing address for the agent |
| **Reddit / TikTok / LinkedIn** | 🟡 Pending | Same model as X — buy + operate from the CLI |
| **Storage** | 🟡 Pending | S3-compatible object storage |

## How It Works

```
Agent calls API → gets 402 → pays USDC (Solana or Base) → service provisioned
```

Your wallet is your identity. Pay with USDC, your wallet address owns the resource. No API keys. No signup.

## Quick Start

### 1. Call any endpoint → get 402 → pay with USDC → done
```bash
# Provision a phone number ($2 USDC)
curl -X POST https://agntos.dev/phone/numbers \
  -H "Content-Type: application/json" \
  -d '{"country": "US"}'
# → 402 Payment Required (tells you exactly how to pay)

# Pay via x402 — your wallet address becomes the owner
curl -X POST https://agntos.dev/phone/numbers \
  -H "Payment-Signature: <x402-payment>" \
  -H "Content-Type: application/json" \
  -d '{"country": "US"}'
# → phone number provisioned, owned by your wallet
```

Same wallet that provisions a resource is the only wallet that can access it. No API keys or tokens. Your agent wallet = your identity.

### 2. Or use the dashboard
[agntos.dev/dashboard](https://agntos.dev/dashboard) — visual node-based agent management.

## x402 Payment

All paid endpoints accept USDC via the x402 protocol:

1. Call any endpoint → get `402` with `PAYMENT-REQUIRED` header
2. Build a USDC transfer to the treasury
3. Send it in the `Payment-Signature` header
4. Server verifies onchain → returns the response

**Networks:** Solana mainnet + Base (EVM)
**Treasury (SOL):** `B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3`
**Treasury (EVM):** `0x7fA8aC4b42fd0C97ca983Bc73135EdbeA5bD6ab2`

## AgentWallet

Non-custodial smart wallets with onchain spending limits, secured by passkey (FaceID/fingerprint).

```bash
npx @agntos/agentwallet create        # Deploy on Base + Solana
npx @agntos/agentwallet status 0xABC  # Check balances & limits
npx @agntos/agentwallet send \
  --wallet 0xW --to 0xR --amount 10 --key 0xK
```

- On-chain daily + per-tx + per-token limits
- Passkey (biometric) is the owner key — can't be phished
- Agent can't change its own limits
- Source: [github.com/0xArtex/agentwallet-aos](https://github.com/0xArtex/agentwallet-aos)

## Dashboard

Visual node-based dashboard at [agntos.dev/dashboard.html](https://agntos.dev/dashboard.html):

- **Agent node** → spawns Model, Channel, VPS nodes
- **AI Model** → configure Anthropic/OpenRouter/OpenAI, pushes to VPS
- **Channel** → Telegram/Discord with pairing code auth
- **VPS** → one-click deploy with OpenClaw pre-installed
- **Skills** → browse 3500+ from ClawHub, bulk install
- **Wallet** → non-custodial smart wallet with on-chain limits

All nodes push config independently to the VPS. Delete a node → removes config from VPS.

## Tech Stack

- **Runtime:** Node.js + TypeScript + Express
- **Payments:** x402 (USDC on Solana + Base)
- **Phone/Voice:** Telnyx (150+ countries)
- **Email:** Cloudflare Email Workers + E2E encryption (NaCl box, wallet-key encrypted)
- **Compute:** Hetzner Cloud + cloud-init hardening
- **Domains:** Namecheap API
- **Wallet:** Solidity (Base) + Anchor (Solana)
- **Database:** SQLite (better-sqlite3)

## Self-Host

```bash
git clone https://github.com/0xArtex/AgentOS
cd AgentOS
cp .env.example .env  # configure keys
npm install
npm run build
npm start
```

Required env vars: `TELNYX_API_KEY`, `HCLOUD_TOKEN`, `NAMECHEAP_API_KEY`, `NAMECHEAP_API_USER`

## License

MIT
