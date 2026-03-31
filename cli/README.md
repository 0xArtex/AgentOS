# @agntos/agentos

Everything your AI agent needs — one CLI.

Phone numbers, encrypted email, VPS, domains, crypto wallets. Pay with USDC. Your wallet is your identity.

## Install

```bash
npm i -g @agntos/agentos
```

Or run directly:

```bash
npx @agntos/agentos phone search --country US
```

## Commands

### Phone
```bash
agentos phone search --country US          # Search available numbers
agentos phone buy --country US             # Buy a number ($3)
agentos phone sms --id ID --to +1... --body "hi"   # Send SMS ($0.05)
agentos phone call --id ID --to +1... --tts "hello" # Voice call ($0.10)
```

### Email (E2E Encrypted)
```bash
agentos email create --name agent --wallet SOL_PUBKEY  # Create inbox ($2)
agentos email read --id INBOX_ID                       # Read messages ($0.02)
agentos email send --id ID --to x@y.com --subject "Hi" --body "..."  # Send ($0.08)
agentos email threads --id INBOX_ID                    # List threads ($0.02)
```

### Compute
```bash
agentos compute plans                            # List VPS plans
agentos compute deploy --name my-vps --type cx23 # Deploy VPS (from $8/mo)
agentos compute list                             # List servers
agentos compute delete --id SERVER_ID            # Delete server
```

### Domains
```bash
agentos domain check --name example.dev   # Check availability (free)
agentos domain pricing --name example     # Get pricing (free)
agentos domain buy --name example.dev     # Register domain
agentos domain dns --name example.dev     # View DNS records
```

### Wallet
```bash
agentos wallet keygen                     # Generate keypair
agentos wallet create --agent 0xADDR      # Create smart wallet
agentos wallet status 0xWALLET            # Check status & limits
```

### Info
```bash
agentos pricing    # All service prices
agentos health     # API status
```

## Authentication

Your wallet is your identity. No API keys, no signup.

All paid endpoints use the x402 protocol — call the endpoint, get a 402 response with the price, pay with USDC on Solana or Base. The wallet that pays owns the resource.

## SDK

```typescript
import { AgentOS } from '@agntos/agentos'

const ao = new AgentOS()

// Search phone numbers
const numbers = await ao.phoneSearch('US')

// Check domain availability
const check = await ao.domainCheck('myagent.dev')

// Get pricing
const prices = await ao.pricing()
```

## Options

| Flag | Description |
|------|-------------|
| `--url <url>` | API base URL (default: https://agntos.dev) |
| `--json` | Output raw JSON |
| `--version` | Show version |
| `--help` | Show help |

## Links

- **API:** [agntos.dev](https://agntos.dev)
- **Skill file:** [agntos.dev/skill.md](https://agntos.dev/skill.md)
- **Dashboard:** [agntos.dev/dashboard.html](https://agntos.dev/dashboard.html)
- **GitHub:** [github.com/0xArtex/AgentOS](https://github.com/0xArtex/AgentOS)
- **Wallet CLI:** [@agntos/agentwallet](https://www.npmjs.com/package/@agntos/agentwallet)

## License

MIT
