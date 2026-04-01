# AgentOS — Infrastructure for AI Agents

Everything an agent needs: phone, email, compute, domains, voice calling, wallets, and 3500+ skills. Pay with USDC on Solana or Base via x402.

**CLI:** `npm i -g @agntos/agentos` (or `npx @agntos/agentos`)
**API:** `https://agntos.dev`
**Source:** https://github.com/0xArtex/AgentOS

## Setup

```bash
npm i -g @agntos/agentos

# Configure your Solana wallet (for x402 payments)
agentos setup --keyfile ~/.config/solana/id.json --chain solana

# Optionally add Base (EVM) wallet too
agentos setup --keyfile ./base-key.json --chain base

# Check everything works
agentos status
```

The CLI creates `~/.agentos/` to store config, credentials, data, logs, and memory. Your keyfile is referenced by path — never copied.

## CLI Commands

Use the CLI for cleaner context and simpler commands:

```bash
# Phone
agentos phone search --country US          # Search numbers (free)
agentos phone buy --country US             # Buy a number ($3)
agentos phone sms --id ID --to +1... --body "hi"   # Send SMS ($0.05)
agentos phone call --id ID --to +1... --tts "hello" # Voice call ($0.10)

# Email (E2E encrypted)
agentos email create --name agent --wallet SOL_PUBKEY  # Create inbox ($2)
agentos email read --id INBOX_ID                       # Read messages ($0.02)
agentos email send --id ID --to x@y.com --subject "Hi" --body "..."  # Send ($0.08)
agentos email threads --id INBOX_ID                    # List threads ($0.02)

# Compute
agentos compute plans                            # List VPS plans (free)
agentos compute deploy --name my-vps --type cx23 # Deploy VPS (from $8/mo)
agentos compute list                             # List servers
agentos compute delete --id SERVER_ID            # Delete server

# Domains
agentos domain check --name example.dev   # Check availability (free)
agentos domain pricing --name example     # Get pricing (free)
agentos domain buy --name example.dev     # Register domain

# Wallet
agentos wallet keygen                     # Generate keypair (free)
agentos wallet create --agent 0xADDR      # Create smart wallet (free)
agentos wallet status 0xWALLET            # Check status (free)

# Info
agentos pricing    # All service prices
agentos health     # API status
```

## API Quick Reference

All endpoints also available as direct HTTP calls. CLI is recommended — less tokens, cleaner output.

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
| List threads | `GET /email/inboxes/:id/threads` | 0.02 |
| Thread messages | `GET /email/threads/:threadId/messages` | 0.02 |
| Download attachment | `GET /email/attachments/:id` | 0.02 |
| Register webhook | `POST /email/webhooks` | 0.02 |
| **Compute** | | |
| List plans | `GET /compute/plans` | Free |
| Upload SSH key | `POST /compute/ssh-keys` | 0.10 |
| Create server | `POST /compute/servers` | 8.00-40.00 |
| List servers | `GET /compute/servers` | 0.02 |
| Server status | `GET /compute/servers/:id` | 0.02 |
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


## API Details

The CLI wraps all API endpoints. If you prefer raw HTTP, use the quick reference table above. All endpoints accept JSON and return JSON.

For voice calls, email threads, attachments, webhooks, and other advanced features — run `agentos --help` or see the full API docs at `agntos.dev/docs`.

### Payment Flow
1. Call any paid endpoint → get `402 Payment Required`
2. Response includes USDC amount + treasury address (Solana + Base)
3. Pay via x402 protocol
4. Your wallet address becomes the resource owner

### E2E Email Encryption
Emails are encrypted with your wallet's public key (NaCl box). We cannot read them.

To decrypt, use the helper script in this skill folder:
```bash
node decrypt-email.mjs "w:..." ~/.config/solana/id.json
node decrypt-email.mjs --json '{"subject":"w:...","body":"w:..."}' ~/.config/solana/id.json
```

## Webhooks

Set up webhooks to receive events:
- **SMS inbound:** Messages to your number arrive via Telnyx webhook → stored, readable via API
- **Voice events:** `call.initiated`, `call.answered`, `call.hangup`, `call.recording.saved`, `call.gather.ended`
- **Email inbound:** Emails to `*@agntos.dev` processed via Cloudflare worker → stored encrypted
