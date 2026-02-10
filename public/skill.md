# AgentOS — Infrastructure for Autonomous AI Agents

Autonomous infrastructure services for AI agents on Solana. Phone numbers, email, compute, domains — all paid with USDC via x402.

**Source Code:** https://github.com/0xArtex/AgentOS (fully open source — verify every line)

## Base URL
```
https://agntos.dev
```

## Authentication

### Hackathon Mode (Free until Feb 12, 2026)
```
X-Agent-Id: <your-colosseum-agent-id>
```

### x402 Payment (Always Available)
```
X-Payment: <solana-usdc-transaction-signature>
```

---

## 📧 E2E Encrypted Email (Wallet-Secured)

Your Solana wallet IS your email key. Zero-knowledge — we literally cannot read your emails.

**How it works:**
1. Provision with your Solana wallet address
2. Inbound emails are encrypted with your wallet's derived X25519 key
3. Pay with x402 (tiny USDC payment) to access — payment proves wallet ownership
4. Decrypt client-side — plaintext never touches our servers

**Encryption:** X25519 + XSalsa20-Poly1305 (NaCl box), Ed25519 → X25519 key derivation

### Provision Inbox
```http
POST /email/provision
Content-Type: application/json
X-Agent-Id: <agent-id>

{
  "name": "my-agent",
  "walletAddress": "<solana-public-key-base58>"
}
```
Response: `{ inbox: { id, address, walletAddress }, encryption: { ... } }`

Your email will be `my-agent@agntos.dev`

### Read Messages
```http
GET /email/inboxes/{id}/messages
X-Agent-Id: <agent-id>
```
Cost: 0.001 USDC (or free during hackathon). Returns encrypted blobs.

Decrypt client-side using your Solana private key:
```javascript
import nacl from 'tweetnacl';

// Convert Solana Ed25519 secret → X25519
const hash = nacl.hash(solanaSecretKey.slice(0, 32));
const x25519Secret = hash.slice(0, 32);
x25519Secret[0] &= 248; x25519Secret[31] &= 127; x25519Secret[31] |= 64;

// Decrypt message blob
const packed = Buffer.from(message.subject, 'base64');
const decrypted = nacl.box.open(
  packed.slice(56),      // ciphertext
  packed.slice(32, 56),  // nonce
  packed.slice(0, 32),   // ephemeral public key
  x25519Secret
);
const plaintext = new TextDecoder().decode(decrypted);
```

### Send Email
```http
POST /email/inboxes/{id}/send
Content-Type: application/json
X-Agent-Id: <agent-id>

{
  "to": "recipient@example.com",
  "subject": "Hello",
  "body": "Message content"
}
```
Cost: 0.05 USDC (or free during hackathon).

### Email Info & SDK
```
GET /email/info     — security model and API overview
GET /email/sdk      — client-side decryption helper code
```

### Email Pricing
| Action | Cost |
|--------|------|
| Provision inbox | 1.00 USDC |
| Read messages | 0.001 USDC |
| Send email | 0.05 USDC |

---

## 📱 Phone Numbers

### Provision Number
```http
POST /phone/numbers
Content-Type: application/json
X-Agent-Id: <agent-id>

{ "country": "US", "areaCode": "415" }
```

### Get Messages
```http
GET /phone/numbers/{id}/messages
X-Agent-Id: <agent-id>
```

### Send SMS
```http
POST /phone/numbers/{id}/send
Content-Type: application/json
X-Agent-Id: <agent-id>

{ "to": "+1234567890", "body": "Hello from AgentOS!" }
```

---

## 🖥️ Compute Servers

### Create Server
```http
POST /compute/servers
Content-Type: application/json
X-Agent-Id: <agent-id>

{ "name": "my-server", "serverType": "cx22", "image": "ubuntu-24.04" }
```

### List / Get / Delete
```http
GET /compute/servers
GET /compute/servers/{id}
DELETE /compute/servers/{id}
```

---

## 🌐 Domain Management

### Register Domain
```http
POST /domains
Content-Type: application/json
X-Agent-Id: <agent-id>

{ "name": "myagent", "tld": "dev" }
```

---

## 🔍 Discovery Endpoints (Free)

```
GET /health          — health check
GET /email/info      — email encryption details
GET /email/sdk       — client decryption code
GET /docs            — Swagger API documentation
GET /pricing         — full pricing table
GET /hackathon/status — hackathon mode info
```

## Security Model

- **Open source**: https://github.com/0xArtex/AgentOS — audit every line
- **E2E encryption**: Email content encrypted before touching disk
- **Zero-knowledge**: Private keys never stored on our servers
- **Wallet-native**: Solana Ed25519 → X25519 key derivation
- **Self-custody**: Lose your wallet, lose your email (like crypto)
- **Challenge-response**: Wallet signatures for authentication (no passwords)

## Hackathon Limits (Free Tier)
- 📱 Phone numbers: 1
- 📧 Email inboxes: 1
- 🖥️ Servers: 1

## Links
- **Website**: https://agntos.dev
- **GitHub**: https://github.com/0xArtex/AgentOS
- **Blog**: https://agntos.dev/blog/e2e-email.html
- **X**: https://x.com/zoltyagent
