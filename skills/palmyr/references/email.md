> Fetch this when creating or reading inboxes, sending mail, or decrypting E2E (`w:`) messages.

# Palmyr — Email & Inboxes

## CLI

```bash
palmyr email create --name agent --wallet SOL_PUBKEY   # Create inbox ($2); a SOL pubkey → E2E
palmyr email read --id INBOX_ID                        # Read messages ($0.02)
palmyr email send --id ID --to x@y.com --subject "Hi" --body "..."   # Send ($0.08)
palmyr email threads --id INBOX_ID                     # List threads ($0.02)
```

## API

| Action | Endpoint | Cost (USDC) |
|---|---|---|
| Provision inbox | `POST /email/inboxes` (or `POST /email/provision`) | 2.00 |
| List inboxes | `GET /email/inboxes` | 0.01 |
| Read inbox | `GET /email/inboxes/:id/messages` | 0.02 |
| Send email | `POST /email/inboxes/:id/send` | 0.08 |
| List threads | `GET /email/inboxes/:id/threads` | 0.02 |
| Thread messages | `GET /email/threads/:threadId/messages` | 0.02 |
| Download attachment | `GET /email/attachments/:id` | 0.02 |
| Register webhook | `POST /email/webhooks` | 0.02 |
| Register custom domain | `POST /email/domains/:domain/register` | 0.05 |
| Domain status | `GET /email/domains/:domain/status` | 0.01 |

## Encryption (two-tier; end-to-end is opt-in)

- **With a Solana key** (the CLI defaults to your vault wallet's Solana address): the inbox is **end-to-end encrypted** — messages are sealed to that key (NaCl `box`, X25519 + XSalsa20-Poly1305) and the server cannot read them. They come back as `w:` ciphertext you decrypt yourself.
- **Without a Solana key** (e.g. a Base/EVM owner): encrypted **server-side with AES-256-GCM** and decrypted on read once your x402 payment proves ownership — the operator holds that key.

### Decrypt E2E (`w:`) messages

Use `decrypt-email.mjs`, shipped in the skill folder next to `SKILL.md`:

```bash
node decrypt-email.mjs "w:..." ~/.config/solana/id.json
node decrypt-email.mjs --json '{"subject":"w:...","body":"w:..."}' ~/.config/solana/id.json
```

## Webhooks

Email inbound: mail to `*@palmyr.ai` (or your custom domain) is received via Mailgun inbound routes → POSTed to our webhook → stored encrypted.
