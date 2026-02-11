# AgentOS — Infrastructure for AI Agents

Phone, email, compute, domains for AI agents. Pay with USDC on Solana via x402. No API keys needed — your wallet is your identity.

**Base URL:** `https://agntos.dev`
**Source:** https://github.com/0xArtex/AgentOS

## Quick Reference

| Service | Endpoint | Cost (USDC) |
|---------|----------|-------------|
| Register agent | `POST /agents/register` | Free |
| Provision email | `POST /email/inboxes` | 1.00 |
| Read inbox | `GET /email/inboxes/:id/messages` | 0.01 |
| Send email | `POST /email/inboxes/:id/send` | 0.05 |
| Provision phone | `POST /phone/numbers` | 2.00 |
| Send SMS | `POST /messages/send` | 0.05 |
| Create server | `POST /compute/servers` | 5.00 |
| Check domain | `GET /domains/check?domain=example.com` | Free |
| Register domain | `POST /domains/register` | ~$14-44 |
| Update DNS | `POST /domains/:domain/dns` | Free |
| Pricing details | `GET /pricing` | Free |

All paid endpoints use **x402** — just make the request, get a 402 paywall, pay, done.

## Authentication

Two options (both work for all endpoints):

**Option A: Agent token** (register once, get a token)
```
Authorization: Bearer aos_xxxxx
```

**Option B: x402 payment only** (no registration needed)
Just make the request. The 402 response tells you what to pay. Payment = auth.

## How x402 Works

1. Call any paid endpoint → get `402 Payment Required` with payment details
2. Build a Solana USDC transfer transaction to the treasury
3. Send it back in the `Payment-Signature` header
4. Server verifies, settles on-chain, returns the response

**If you have AgentWallet**, use its `x402/fetch` proxy — handles everything in one call:

```bash
curl -X POST "https://agentwallet.mcpay.tech/api/wallets/USERNAME/actions/x402/fetch" \
  -H "Authorization: Bearer WALLET_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://agntos.dev/email/inboxes",
    "method": "POST",
    "body": {"name": "my-agent", "walletAddress": "YOUR_SOLANA_PUBKEY"},
    "headers": {"X-Api-Key": "aos_xxxxx"},
    "preferredChain": "solana"
  }'
```

---

## Register Agent (Free)

```bash
curl -X POST https://agntos.dev/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "walletAddress": "YOUR_SOLANA_PUBKEY"}'
```

Response:
```json
{"agent": {"id": "uuid", "name": "my-agent", "token": "aos_xxxxx"}}
```

Save the `token` — use it as `Authorization: Bearer aos_xxxxx` or `X-Api-Key: aos_xxxxx`.

---

## 📧 Email

### Provision Inbox (1.00 USDC)

```bash
curl -X POST https://agntos.dev/email/inboxes \
  -H "X-Api-Key: aos_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "walletAddress": "YOUR_SOLANA_PUBKEY"}'
```

Response:
```json
{"inbox": {"id": "uuid", "address": "my-agent@agntos.dev", "walletAddress": "..."}}
```

### Read Inbox (0.01 USDC via x402)

```bash
curl https://agntos.dev/email/inboxes/INBOX_ID/messages
```

Returns 402 → pay $0.01 from the wallet that created the inbox → get decrypted messages.

**Security model:** Messages are encrypted at rest. Your x402 payment proves you own the wallet, so the server decrypts and returns plaintext over TLS. No private key needed — works with any wallet-as-a-service.

Response (after payment):
```json
{
  "inbox": "my-agent@agntos.dev",
  "messages": [
    {
      "from": "sender@example.com",
      "subject": "Hello",
      "body": "Decrypted message content",
      "timestamp": "2026-02-11T12:00:00Z"
    }
  ],
  "totalMessages": 1
}
```

### Send Email (0.05 USDC via x402)

```bash
curl -X POST https://agntos.dev/email/inboxes/INBOX_ID/send \
  -H "Content-Type: application/json" \
  -d '{"to": "user@example.com", "subject": "Hello", "body": "Message from my agent"}'
```

---

## 📱 Phone

### Provision Number (2.00 USDC)

```bash
curl -X POST https://agntos.dev/phone/numbers \
  -H "X-Api-Key: aos_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"country": "US"}'
```

### Send SMS (0.05 USDC)

```bash
curl -X POST https://agntos.dev/messages/send \
  -H "X-Api-Key: aos_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"to": "+1234567890", "body": "Hello from my agent"}'
```

---

## 💻 Compute

### Create Server (5.00 USDC)

```bash
curl -X POST https://agntos.dev/compute/servers \
  -H "X-Api-Key: aos_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-server", "size": "small"}'
```

---

## 🌐 Domains

### Check Domain Availability (Free)

```bash
curl "https://agntos.dev/domains/check?domain=example.com"
```

Response:
```json
{
  "available": true,
  "domain": "example.com",
  "premium": false,
  "price": 14.28
}
```

### Get TLD Pricing (Free)

```bash
curl https://agntos.dev/domains/pricing
```

Response:
```json
{
  "currency": "USDC",
  "pricing": {
    "com": 14.28,
    "dev": 14.28,
    "xyz": 14.28,
    "io": 43.98,
    "net": 16.48,
    "org": 16.48,
    "app": 21.98
  }
}
```

### Register Domain (Dynamic pricing via x402)

```bash
curl -X POST https://agntos.dev/domains/register \
  -H "X-Api-Key: aos_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"domain": "my-agent.com"}'
```

Returns 402 → pay the domain price from `/domains/check` → domain gets registered with Namecheap.

Response (after payment):
```json
{
  "domain": "my-agent.com",
  "status": "active",
  "expiresAt": "2027-02-11T23:45:00Z",
  "dnsManagement": true
}
```

### Get Domain Info (Free for owners)

```bash
curl https://agntos.dev/domains/my-agent.com \
  -H "X-Api-Key: aos_xxxxx"
```

### Get DNS Records (Free for owners)

```bash
curl https://agntos.dev/domains/my-agent.com/dns \
  -H "X-Api-Key: aos_xxxxx"
```

Response:
```json
[
  {"type": "A", "name": "@", "value": "1.2.3.4", "ttl": 1800},
  {"type": "CNAME", "name": "www", "value": "my-agent.com", "ttl": 1800}
]
```

### Set DNS Records (Free for owners)

```bash
curl -X POST https://agntos.dev/domains/my-agent.com/dns \
  -H "X-Api-Key: aos_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
      {"type": "A", "name": "@", "value": "1.2.3.4"},
      {"type": "CNAME", "name": "www", "value": "my-agent.com"}
    ]
  }'
```

Supported DNS record types: A, AAAA, CNAME, MX, TXT, URL, URL301

### Transfer Domain Out (Free for owners)

```bash
curl -X POST https://agntos.dev/domains/my-agent.com/transfer \
  -H "X-Api-Key: aos_xxxxx"
```

Returns the EPP/auth code to transfer the domain to another registrar.

**Domain Features:**
- Powered by Namecheap registrar
- 1-year registration (auto-renewal available)
- Full DNS management included
- Generic registrant info (agent@agntos.dev)
- Transfer out supported
- Prices include 10% markup

---

## Payment Details

- **Network:** Solana Mainnet
- **Token:** USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`)
- **Treasury:** `B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3`
- **x402 Version:** 2
- **Facilitator fee payer:** `4R67MWivvc52g9BSzQRvQyD8GshttW1QLbnj46usBrcQ`

Also accepts EVM payments on Base (`eip155:8453`).

## Hackathon Mode

Free tier for Colosseum hackathon agents until Feb 12, 2026:
```
X-Agent-Id: YOUR_COLOSSEUM_AGENT_ID
```
One free use per service. After that, pay via x402.
