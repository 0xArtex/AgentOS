# AgentOS — Infrastructure for AI Agents

Everything an agent needs: phone, email, compute, domains, voice calling, wallets, and 3500+ skills. Pay with USDC on Solana or Base via x402.

**Base URL:** `https://agntos.dev`
**Source:** https://github.com/0xArtex/AgentOS
**Wallet CLI:** `npx @agntos/agentwallet`

## Quick Reference

| Service | Endpoint | Cost (USDC) |
|---------|----------|-------------|
| **Phone** | | |
| Search numbers | `GET /phone/numbers/search?country=US` | Free |
| Provision number | `POST /phone/numbers` | 3.00 |
| Send SMS | `POST /phone/numbers/:id/send` | 0.05 |
| Read messages | `GET /phone/numbers/:id/messages` | 0.02 |
| **Voice Calls** | | |
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
| **Email** | | |
| Provision inbox | `POST /email/inboxes` | 2.00 |
| Read inbox | `GET /email/inboxes/:id/messages` | 0.02 |
| Send email | `POST /email/inboxes/:id/send` | 0.08 |
| **Compute** | | |
| List plans | `GET /compute/plans` | Free |
| Upload SSH key | `POST /compute/ssh-keys` | 0.10 |
| Create server | `POST /compute/servers` | 8.00-40.00 |
| List servers | `GET /compute/servers` | 0.01 |
| Server status | `GET /compute/servers/:id` | 0.01 |
| Server action | `POST /compute/servers/:id/actions` | 0.10 |
| Resize server | `POST /compute/servers/:id/resize` | 0.10 |
| Delete server | `DELETE /compute/servers/:id` | 0.10 |
| **Domains** | | |
| Check availability | `GET /domains/check?domain=example.com` | Free |
| TLD pricing | `GET /domains/pricing?domain=example` | Free |
| Register domain | `POST /domains/register` | dynamic (25% markup) |
| DNS records | `GET /domains/:domain/dns` | Free |
| Update DNS | `POST /domains/:domain/dns` | Free |
| Pricing | `GET /pricing` | Free |
| **Wallet** | | |
| Create wallet | `POST /wallet` | Free |
| Wallet status | `GET /wallet/:address` | Free |
| Generate keypair | `POST /wallet/keygen` | Free |
| Transfer (ERC20) | Via smart contract | Gas only |
| **Skills** | | |
| Browse catalog | `GET /compute/skills/catalog` | Free |
| Security scan | `GET /compute/skills/:slug/security` | Free |

All paid endpoints use **x402** — make the request, get a 402, pay with USDC, done.

## Authentication

**Your wallet is your identity.** No API keys. No signup.

Call any endpoint → pay with USDC via x402 → your wallet owns the resource.

Same wallet to access it later. That's it.

**Networks:** Solana mainnet + Base (EVM)

---

## 📱 Phone & SMS

### Search Available Numbers (Free)

```bash
curl "https://agntos.dev/phone/numbers/search?country=US&limit=5"
```

### Provision Number (2.00 USDC)

```bash
curl -X POST https://agntos.dev/phone/numbers \
  -H "Content-Type: application/json" \
  -d '{"country": "US"}'
```

Response:
```json
{
  "id": "uuid",
  "phoneNumber": "+14782058302",
  "country": "US",
  "owner": "your-agent",
  "active": true
}
```

### Send SMS (0.05 USDC)

```bash
curl -X POST https://agntos.dev/phone/numbers/PHONE_ID/send \
  -H "Content-Type: application/json" \
  -d '{"to": "+15551234567", "body": "Hello from my agent!"}'
```

### Read Messages (0.01 USDC)

```bash
curl https://agntos.dev/phone/numbers/PHONE_ID/messages
```

---

## 📞 Voice Calls

### Place Outbound Call (0.10 USDC)

```bash
curl -X POST https://agntos.dev/phone/numbers/PHONE_ID/call \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+15551234567",
    "tts": "Hello! I am an AI agent calling you.",
    "ttsVoice": "female",
    "record": true
  }'
```

Response:
```json
{
  "id": "uuid",
  "callControlId": "v3:xxxxx",
  "from": "+14782058302",
  "to": "+15551234567",
  "status": "initiated",
  "message": "Calling +15551234567 from +14782058302",
  "hint": "TTS will play when the call is answered"
}
```

**Parameters:**
- `to` (required) — phone number to call (E.164 format)
- `tts` — text-to-speech message to play when answered
- `ttsVoice` — voice: `male` or `female`
- `audioUrl` — URL of audio file to play when answered
- `record` — `true` to record the call
- `timeoutSecs` — ring timeout (default 30)

### In-Call Actions

Once a call is connected, use the `callControlId` from the dial response:

**Speak text (TTS) — 0.05 USDC:**
```bash
curl -X POST https://agntos.dev/phone/calls/CALL_CONTROL_ID/speak \
  -H "Content-Type: application/json" \
  -d '{"text": "Please press 1 for sales or 2 for support", "voice": "female", "language": "en-US"}'
```

**Play audio file — 0.05 USDC:**
```bash
curl -X POST https://agntos.dev/phone/calls/CALL_CONTROL_ID/play \
  -H "Content-Type: application/json" \
  -d '{"audioUrl": "https://example.com/greeting.mp3"}'
```

**Send DTMF tones — 0.02 USDC:**
```bash
curl -X POST https://agntos.dev/phone/calls/CALL_CONTROL_ID/dtmf \
  -H "Content-Type: application/json" \
  -d '{"digits": "1234#"}'
```

**Gather DTMF input — 0.05 USDC:**
```bash
curl -X POST https://agntos.dev/phone/calls/CALL_CONTROL_ID/gather \
  -H "Content-Type: application/json" \
  -d '{
    "maxDigits": 4,
    "terminatingDigit": "#",
    "prompt": "Please enter your PIN followed by the pound sign"
  }'
```

**Start recording — 0.05 USDC:**
```bash
curl -X POST https://agntos.dev/phone/calls/CALL_CONTROL_ID/record \
  -H "Content-Type: application/json" \
  -d '{"format": "mp3"}'
```

**Stop recording:**
```bash
curl -X POST https://agntos.dev/phone/calls/CALL_CONTROL_ID/record/stop \
```

**Transfer call — 0.10 USDC:**
```bash
curl -X POST https://agntos.dev/phone/calls/CALL_CONTROL_ID/transfer \
  -H "Content-Type: application/json" \
  -d '{"to": "+15559876543"}'
```

**Answer inbound call:**
```bash
curl -X POST https://agntos.dev/phone/calls/CALL_CONTROL_ID/answer \
```

**Hang up:**
```bash
curl -X POST https://agntos.dev/phone/calls/CALL_CONTROL_ID/hangup \
```

### Call History

**List calls for a number (0.01 USDC):**
```bash
curl https://agntos.dev/phone/numbers/PHONE_ID/calls \
```

**Get call details (0.01 USDC):**
```bash
curl https://agntos.dev/phone/calls/CALL_ID \
```

### Example: Agent calls a restaurant

```
1. POST /phone/numbers/PHONE_ID/call → {"to": "+15551234567", "tts": "Hi, I'd like to place an order"}
2. Wait for call.answered webhook
3. POST /phone/calls/CTRL_ID/gather → {"prompt": "Press 1 for English", "maxDigits": 1}
4. POST /phone/calls/CTRL_ID/dtmf → {"digits": "1"}
5. POST /phone/calls/CTRL_ID/speak → {"text": "I'd like to order two large pizzas for delivery"}
6. POST /phone/calls/CTRL_ID/hangup
```

---

## 📧 Email

### Provision Inbox (1.00 USDC)

```bash
curl -X POST https://agntos.dev/email/inboxes \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "walletAddress": "YOUR_SOLANA_PUBKEY"}'
```

Returns: `my-agent@agntos.dev`

### Read Inbox (0.01 USDC via x402)

```bash
curl https://agntos.dev/email/inboxes/INBOX_ID/messages
```

### Send Email (0.05 USDC via x402)

```bash
curl -X POST https://agntos.dev/email/inboxes/INBOX_ID/send \
  -H "Content-Type: application/json" \
  -d '{"to": "user@example.com", "subject": "Hello", "body": "Message from my agent"}'
```

---

## 💻 Compute (VPS)

### List Plans (Free)

```bash
curl https://agntos.dev/compute/plans \
```

Available plans:
| Type | vCPU | RAM | Disk | Price/mo |
|------|------|-----|------|----------|
| cx23 | 2 | 4GB | 40GB | $5 |
| cx33 | 4 | 8GB | 80GB | $9 |
| cx43 | 8 | 16GB | 160GB | $15 |
| cx53 | 16 | 32GB | 320GB | $28 |
| cpx11 | 2 | 2GB | 40GB | $7 |
| cpx21 | 3 | 4GB | 80GB | $15 |
| cpx31 | 4 | 8GB | 160GB | $26 |
| cpx41 | 8 | 16GB | 240GB | $48 |
| cpx51 | 16 | 32GB | 360GB | $95 |

### Upload SSH Key (0.10 USDC)

```bash
curl -X POST https://agntos.dev/compute/ssh-keys \
  -H "Content-Type: application/json" \
  -d '{"name": "my-key", "publicKey": "ssh-ed25519 AAAA..."}'
```

Returns `id` — use it when creating servers.

### Create Server (5.00-95.00 USDC)

```bash
curl -X POST https://agntos.dev/compute/servers \
  -H "Content-Type: application/json" \
  -d '{"name": "my-server", "serverType": "cx23", "sshKeyIds": [KEY_ID]}'
```

Response:
```json
{
  "id": "12345",
  "name": "my-server",
  "serverType": "cx23",
  "status": "running",
  "ipv4": "89.167.36.207",
  "message": "Server created. SSH in with: ssh root@89.167.36.207"
}
```

**Zero-access design:** You provide your SSH public key. We never see your private key. We can't access your server.

### Server Actions (0.05 USDC)

```bash
curl -X POST https://agntos.dev/compute/servers/SERVER_ID/actions \
  -H "Content-Type: application/json" \
  -d '{"action": "reboot"}'
```

Actions: `reboot`, `poweron`, `poweroff`, `rebuild`, `reset`

### Resize Server (0.10 USDC)

```bash
curl -X POST https://agntos.dev/compute/servers/SERVER_ID/resize \
  -H "Content-Type: application/json" \
  -d '{"serverType": "cx33"}'
```

Note: Server must be powered off to resize.

### Delete Server (0.05 USDC)

```bash
curl -X DELETE https://agntos.dev/compute/servers/SERVER_ID \
```

---

## 🌐 Domains

### Check Availability (Free)

```bash
curl "https://agntos.dev/domains/check?domain=example.com" \
```

### Get Pricing (Free)

```bash
curl "https://agntos.dev/domains/pricing?domain=example" \
```

### Register Domain (dynamic pricing via x402)

```bash
curl -X POST https://agntos.dev/domains/register \
  -H "Content-Type: application/json" \
  -d '{"domain": "my-agent.dev"}'
```

### DNS Management (Free for owners)

```bash
# Get records

# Set records
curl -X POST https://agntos.dev/domains/my-agent.dev/dns \
  -H "Content-Type: application/json" \
  -d '{"records": [{"type": "A", "name": "@", "value": "1.2.3.4"}]}'
```

---

## Payment Details

- **Solana:** USDC to `B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3`
- **Base (EVM):** USDC to `0x7fA8aC4b42fd0C97ca983Bc73135EdbeA5bD6ab2`
- **x402 Version:** 2
- **Facilitator:** `4R67MWivvc52g9BSzQRvQyD8GshttW1QLbnj46usBrcQ`

---

## 💼 AgentWallet — Non-Custodial Smart Wallets

Give your agent a wallet with on-chain spending limits, secured by your passkey (FaceID/fingerprint).

### CLI (recommended)

```bash
npx @agntos/agentwallet create          # Deploy wallets on Base + Solana
npx @agntos/agentwallet status 0xABC    # Check balances and limits
npx @agntos/agentwallet send \
  --wallet 0xWALLET --to 0xRECIPIENT \
  --amount 10 --key 0xPRIVATE_KEY       # Send tokens
npx @agntos/agentwallet execute \
  --wallet 0xW --program 0xCONTRACT \
  --data 0xCALLDATA --key 0xK           # Call any contract
```

### API

```bash
# Create managed wallet (with passkey owner)
curl -X POST https://agntos.dev/wallet \
  -H "Content-Type: application/json" \
  -d '{"agent": "0xAGENT_ADDRESS", "mode": "managed", "chain": "base"}'

# Check wallet status
curl https://agntos.dev/wallet/0xWALLET_ADDRESS \
```

**Security model:**
- Agent's private key generated on its machine — never leaves
- Your passkey (FaceID/fingerprint) is the on-chain owner
- Smart contract enforces daily + per-tx + per-token limits
- Agent cannot change its own limits — mathematically impossible

**Chains:** Base mainnet (live), Solana (devnet)
**Source:** https://github.com/0xArtex/agentwallet-aos

---

## 🧰 Skills Catalog (3500+)

Browse and install skills from ClawHub:

```bash
# Browse catalog (sorted by popularity)
curl https://agntos.dev/compute/skills/catalog \

# Security scan for a skill
curl https://agntos.dev/compute/skills/self-improving-agent/security \
```

Skills can be installed on your agent's VPS via the dashboard or CLI (`clawhub install <slug>`).

---

## 🖥️ Dashboard

Visual node-based dashboard for managing agents: `https://agntos.dev/dashboard.html`

- Drop an **Agent** node → auto-creates Model, Channel, VPS nodes
- Configure **AI Model** (Anthropic/OpenRouter/OpenAI) → pushes to VPS
- Configure **Channel** (Telegram/Discord) → pushes to VPS
- Deploy **VPS** → auto-installs OpenClaw with cloud-init hardening
- Connect **Skills** → bulk-installs from ClawHub
- Connect **Wallet** → installs agentwallet skill + pushes keys to VPS
- All config pushes independently — no waiting for everything

---

## Webhooks

Set up webhooks to receive events:
- **SMS inbound:** Messages to your number arrive via Telnyx webhook → stored, readable via API
- **Voice events:** `call.initiated`, `call.answered`, `call.hangup`, `call.recording.saved`, `call.gather.ended`
- **Email inbound:** Emails to `*@agntos.dev` processed via Cloudflare worker → stored encrypted
