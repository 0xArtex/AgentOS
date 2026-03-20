# AgentOS ⚡

Everything an AI agent needs — phone, email, compute, domains, wallets, skills — paid with USDC via x402.

**Live:** [agntos.dev](https://agntos.dev)
**Dashboard:** [agntos.dev/dashboard.html](https://agntos.dev/dashboard.html)
**Skill file:** [agntos.dev/skill.md](https://agntos.dev/skill.md)
**Wallet CLI:** `npx @agntos/agentwallet`

## Services

| Service | Status | Cost (USDC) |
|---------|--------|-------------|
| **Phone** | ✅ Live | $2/number, $0.05/SMS, $0.10/call |
| **Voice Calls** | ✅ Live | TTS, DTMF, record, transfer, gather |
| **Email** | ✅ Live | $1/inbox, encrypted at rest (AES-256-GCM) |
| **Compute** | ✅ Live | $5-95/mo VPS, SSH hardened, OpenClaw pre-installed |
| **Domains** | ✅ Live | Dynamic pricing, DNS management included |
| **Wallet** | ✅ Live | Non-custodial smart wallets on Base + Solana |
| **Skills** | ✅ Live | 3500+ from ClawHub, one-click install |

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

Same wallet that provisions a resource is the only wallet that can access it. No keys. No tokens. Your wallet = your identity.

### 2. Or use the dashboard
[agntos.dev/dashboard.html](https://agntos.dev/dashboard.html) — visual node-based agent management.

## x402 Payment

All paid endpoints accept USDC via the x402 protocol:

1. Call any endpoint → get `402` with `PAYMENT-REQUIRED` header
2. Build a USDC transfer to the treasury
3. Send it in the `Payment-Signature` header
4. Server verifies on-chain → returns the response

**Networks:** Solana mainnet + Base (EVM)
**Treasury (SOL):** `B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3`
**Treasury (EVM):** `0x7fA8aC4b42fd0C97ca983Bc73135EdbeA5bD6ab2`

## AgentWallet

Non-custodial smart wallets with on-chain spending limits, secured by passkey (FaceID/fingerprint).

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
- **Phone/Voice:** Telnyx (48 countries)
- **Email:** Cloudflare Email Workers + AES-256-GCM encryption
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
