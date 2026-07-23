> Fetch this when creating or reading inboxes, sending mail, or decrypting E2E (`w:`) messages.

# Palmyr — Email & Inboxes

## CLI

```bash
palmyr email create --name agent --wallet SOL_PUBKEY   # Create inbox ($2); a SOL pubkey → E2E
palmyr email temp [--ttl 3600]                         # Disposable receive-only inbox ($0.50); auto-expires (default 24h)
palmyr email extend --id INBOX_ID                      # Rent another 7 days on a live temp inbox ($0.50, stackable)
palmyr email read --id INBOX_ID                        # Read messages ($0.02)
palmyr email send --id ID --to x@y.com --subject "Hi" --body "..."   # Send ($0.08)
palmyr email threads --id INBOX_ID                     # List threads ($0.02)
```

## API

| Action | Endpoint | Cost (USDC) |
|---|---|---|
| Provision inbox | `POST /email/inboxes` (or `POST /email/provision`) | 2.00 |
| Temp inbox (disposable, receive-only) | `POST /email/temp` | 0.50 |
| Extend temp inbox (+7 days, stackable) | `POST /email/temp/:id/extend` | 0.50 |
| List inboxes | `GET /email/inboxes` | 0.01 |
| Read inbox | `GET /email/inboxes/:id/messages` | 0.02 |
| Send email | `POST /email/inboxes/:id/send` | 0.08 |
| List threads | `GET /email/inboxes/:id/threads` | 0.02 |
| Thread messages | `GET /email/threads/:threadId/messages` | 0.02 |
| Download attachment | `GET /email/attachments/:id` | 0.02 |
| Register webhook | `POST /email/webhooks` | 0.02 |
| Register custom domain | `POST /email/domains/:domain/register` | 0.05 |
| Domain status | `GET /email/domains/:domain/status` | 0.01 |

## Disposable temp inboxes (`POST /email/temp`, $0.50)

A cheap, auto-expiring, **receive-only** inbox for one-off checkout / signup flows — receive an order confirmation or a verification email, then let it evaporate. Owned by the paying wallet under the same read-auth model as a normal inbox, but:

- The server generates a natural-looking address (e.g. `maria.holt73@…`) on a dedicated disposable-inbox domain — kept off `palmyr.ai` so throwaway traffic never risks the reputation of owned inboxes, and human-plausible so signup forms accept it. You don't pick the name or domain (no `domain` param); read `address` from the response.
- **Never E2E** — always server-side AES, so a paid read from the owning wallet returns **plaintext** (no key to manage). Response: `{ id, address, expires_at }`.
- **Receive-only** — `POST /email/inboxes/:id/send` hard-403s a temp inbox.
- **Auto-expires** — pass optional `ttl_seconds` (default 86400 = 24h, clamped to [300, 604800]). After expiry, reads 404 and inbound mail is dropped; the row is hard-deleted 48h later.
- **Extendable while live** — `POST /email/temp/:id/extend` ($0.50) pushes `expires_at` exactly **7 days** further per call: fixed amount, no params, no cap — another $0.50 buys another week (useful for e.g. tracking a 2-week shipment). Owner-only. An **expired** temp inbox cannot be revived (404 — buy a new one), and a normal $2 inbox has no TTL to extend (400); both rejections happen **before** payment, so they're free. Response: `{ id, address, expires_at }`.

Read it with the same `GET /email/inboxes/:id/messages` ($0.02) as any inbox.

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
