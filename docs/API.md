# AgentOS API Reference

> **Base URL:** `https://api.agentos.dev` (or your self-hosted instance)
>
> **Protocol:** x402 — Pay-per-call with USDC on Solana
>
> **Version:** 0.1.0

---

## Table of Contents

- [Authentication (x402 Payment Protocol)](#authentication-x402-payment-protocol)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Endpoints](#endpoints)
  - [Health & Info](#health--info)
  - [Phone](#phone)
  - [Email](#email)
  - [Domains](#domains)
  - [Compute](#compute)
  - [API Keys](#api-keys)

---

## Authentication (x402 Payment Protocol)

AgentOS uses the **x402** payment protocol. Instead of API keys, you pay per request with USDC on Solana.

### How It Works

1. **Send USDC** to the AgentOS treasury wallet on Solana
2. **Include the transaction signature** in the `X-Payment` header
3. **AgentOS verifies** the transaction on-chain and processes your request

### Payment Header

```
X-Payment: <solana-transaction-signature>
```

### Payment Flow Example

```bash
# Step 1: Send USDC to treasury (use Solana CLI, SDK, or wallet)
# Treasury: (check GET /api for current address)
# Amount: depends on endpoint (see pricing)

# Step 2: Get the transaction signature from Step 1
TX_SIG="5UfDuX...your_solana_tx_signature"

# Step 3: Call the API with the signature
curl -X POST https://api.agentos.dev/phone/numbers \
  -H "Content-Type: application/json" \
  -H "X-Payment: $TX_SIG" \
  -d '{"country": "US"}'
```

### Payment Verification

AgentOS verifies that:
- The transaction exists and is **confirmed** on Solana
- It contains a **USDC SPL token transfer** to the treasury wallet
- The transfer amount **meets or exceeds** the endpoint's minimum cost

If verification fails, you'll receive a `402 Payment Required` response with details.

### 402 Response (No Payment)

```json
{
  "error": "Payment Required",
  "message": "Include a Solana USDC transaction signature in the X-Payment header",
  "protocol": "x402",
  "treasury": "<treasury-wallet-address>",
  "currency": "USDC",
  "network": "solana"
}
```

---

## Error Handling

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created (resource provisioned) |
| `400` | Bad Request — missing or invalid parameters |
| `402` | Payment Required — no/invalid/insufficient payment |
| `404` | Not Found — resource doesn't exist |
| `429` | Too Many Requests — rate limit exceeded |
| `500` | Internal Server Error |

### Error Response Format

All errors return JSON:

```json
{
  "error": "Short error title",
  "message": "Human-readable explanation of what went wrong"
}
```

### Payment-Specific Errors

**Transaction not found:**
```json
{
  "error": "Transaction not found",
  "message": "Could not find transaction on Solana. It may not be confirmed yet.",
  "signature": "5UfDuX..."
}
```

**Transaction failed on-chain:**
```json
{
  "error": "Transaction failed",
  "message": "The referenced transaction failed on-chain.",
  "signature": "5UfDuX..."
}
```

**No USDC transfer detected:**
```json
{
  "error": "No valid USDC transfer found",
  "message": "Transaction must include a USDC transfer to <treasury>"
}
```

**Insufficient payment:**
```json
{
  "error": "Insufficient payment",
  "message": "This endpoint requires 5.00 USDC, but transaction contains 1.00 USDC",
  "required": 5.0,
  "received": 1.0
}
```

---

## Rate Limiting

Rate limiting is applied per payer wallet address (or IP if no payment).

**Headers included in every response:**

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Max requests in current window |
| `X-RateLimit-Remaining` | Requests remaining |
| `X-RateLimit-Reset` | Unix timestamp when window resets |

**Rate-limited endpoints:**
- `POST /phone/numbers` — 10 requests per 60 seconds
- `POST /compute/servers` — 5 requests per 60 seconds
- `POST /apikeys` — 10 requests per 60 seconds

**429 Response:**
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Max 10 requests per 60s.",
  "retryAfter": 45
}
```

---

## Endpoints

### Health & Info

#### `GET /api`

Service info (no payment required).

**Response:**
```json
{
  "service": "AgentOS",
  "version": "0.1.0",
  "status": "operational",
  "docs": "https://github.com/0xArtex/AgentOS",
  "services": ["phone", "email", "domains", "compute", "apikeys"]
}
```

#### `GET /health`

Health check (no payment required).

**Response:**
```json
{
  "status": "ok",
  "uptime": 3600.123
}
```

#### `GET /pricing`

Full pricing table (no payment required).

**Response:**
```json
{
  "currency": "USDC",
  "network": "solana",
  "services": {
    "phone": {
      "provision_number": "2.00",
      "get_messages": "0.01",
      "send_sms": "0.05"
    },
    "email": {
      "create_inbox": "1.00",
      "get_messages": "0.01",
      "send_email": "0.05"
    },
    "domains": {
      "register_domain": "10.00",
      "get_status": "0.01",
      "update_dns": "0.10"
    },
    "compute": {
      "create_server": "5.00",
      "list_servers": "0.01",
      "get_server": "0.01",
      "delete_server": "0.10",
      "upload_ssh_key": "0.10"
    },
    "apikeys": {
      "provision_key": "1.00",
      "list_keys": "0.01",
      "revoke_key": "0.01"
    }
  }
}
```

---

### Phone

#### `POST /phone/numbers`

Provision a new phone number via Twilio.

| Field | Details |
|-------|---------|
| **Cost** | 2.00 USDC |
| **Rate Limit** | 10 req / 60s |

**Request:**
```bash
curl -X POST https://api.agentos.dev/phone/numbers \
  -H "Content-Type: application/json" \
  -H "X-Payment: <tx-signature>" \
  -d '{
    "country": "US",
    "areaCode": "415"
  }'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `country` | string | ✅ | ISO country code (e.g., "US", "GB") |
| `areaCode` | string | ❌ | Preferred area code |

**Response (201):**
```json
{
  "id": "phn_abc123",
  "phoneNumber": "+14155551234",
  "country": "US",
  "owner": "7xKXt...payer-wallet",
  "provisionedAt": "2025-01-15T10:30:00Z",
  "active": true
}
```

---

#### `GET /phone/numbers/:id/messages`

Retrieve SMS messages for a phone number.

| Field | Details |
|-------|---------|
| **Cost** | 0.01 USDC |

**Request:**
```bash
curl https://api.agentos.dev/phone/numbers/phn_abc123/messages \
  -H "X-Payment: <tx-signature>"
```

**Response (200):**
```json
{
  "messages": [
    {
      "id": "msg_xyz789",
      "phoneNumberId": "phn_abc123",
      "direction": "inbound",
      "from": "+14155559876",
      "to": "+14155551234",
      "body": "Hello from an AI agent!",
      "timestamp": "2025-01-15T11:00:00Z"
    }
  ]
}
```

---

#### `POST /phone/numbers/:id/send`

Send an SMS message.

| Field | Details |
|-------|---------|
| **Cost** | 0.05 USDC |

**Request:**
```bash
curl -X POST https://api.agentos.dev/phone/numbers/phn_abc123/send \
  -H "Content-Type: application/json" \
  -H "X-Payment: <tx-signature>" \
  -d '{
    "to": "+14155559876",
    "body": "Hello from AgentOS!"
  }'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | ✅ | Destination phone number (E.164 format) |
| `body` | string | ✅ | Message text |

**Response (201):**
```json
{
  "id": "msg_out456",
  "phoneNumberId": "phn_abc123",
  "direction": "outbound",
  "from": "+14155551234",
  "to": "+14155559876",
  "body": "Hello from AgentOS!",
  "timestamp": "2025-01-15T11:05:00Z"
}
```

---

### Email

#### `POST /email/inboxes`

Create a new email inbox.

| Field | Details |
|-------|---------|
| **Cost** | 1.00 USDC |

**Request:**
```bash
curl -X POST https://api.agentos.dev/email/inboxes \
  -H "Content-Type: application/json" \
  -H "X-Payment: <tx-signature>" \
  -d '{"name": "my-agent"}'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | ✅ | Local part — becomes `{name}@mail.agentos.dev` |

**Response (201):**
```json
{
  "id": "inbox_def456",
  "address": "my-agent@mail.agentos.dev",
  "localPart": "my-agent",
  "owner": "7xKXt...payer-wallet",
  "createdAt": "2025-01-15T10:30:00Z",
  "active": true
}
```

---

#### `GET /email/inboxes/:id/messages`

Get messages for an inbox.

| Field | Details |
|-------|---------|
| **Cost** | 0.01 USDC |

**Request:**
```bash
curl https://api.agentos.dev/email/inboxes/inbox_def456/messages \
  -H "X-Payment: <tx-signature>"
```

**Response (200):**
```json
{
  "messages": [
    {
      "id": "eml_abc123",
      "inboxId": "inbox_def456",
      "direction": "inbound",
      "from": "user@example.com",
      "to": "my-agent@mail.agentos.dev",
      "subject": "Hello Agent",
      "body": "Can you help me?",
      "html": "<p>Can you help me?</p>",
      "timestamp": "2025-01-15T11:00:00Z"
    }
  ]
}
```

---

#### `POST /email/inboxes/:id/send`

Send an email from an inbox.

| Field | Details |
|-------|---------|
| **Cost** | 0.05 USDC |

**Request:**
```bash
curl -X POST https://api.agentos.dev/email/inboxes/inbox_def456/send \
  -H "Content-Type: application/json" \
  -H "X-Payment: <tx-signature>" \
  -d '{
    "to": "user@example.com",
    "subject": "Re: Hello Agent",
    "body": "Sure, I can help!",
    "html": "<p>Sure, I can help!</p>"
  }'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | ✅ | Recipient email address |
| `subject` | string | ✅ | Email subject |
| `body` | string | ✅ | Plain text body |
| `html` | string | ❌ | HTML body (optional) |

**Response (201):**
```json
{
  "id": "eml_out789",
  "inboxId": "inbox_def456",
  "direction": "outbound",
  "from": "my-agent@mail.agentos.dev",
  "to": "user@example.com",
  "subject": "Re: Hello Agent",
  "body": "Sure, I can help!",
  "timestamp": "2025-01-15T11:10:00Z"
}
```

---

#### `POST /email/inbound`

Webhook for inbound emails (Mailgun/SendGrid). **No payment required** — called by the email provider.

**Request:**
```json
{
  "to": "my-agent@mail.agentos.dev",
  "from": "user@example.com",
  "subject": "Hello",
  "body": "Message text",
  "html": "<p>Message text</p>"
}
```

**Response (200):**
```json
{
  "received": true,
  "messageId": "eml_in123"
}
```

---

### Domains

#### `POST /domains`

Register a new domain.

| Field | Details |
|-------|---------|
| **Cost** | 10.00 USDC |

**Request:**
```bash
curl -X POST https://api.agentos.dev/domains \
  -H "Content-Type: application/json" \
  -H "X-Payment: <tx-signature>" \
  -d '{
    "name": "myagent",
    "tld": "dev"
  }'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | ✅ | Domain name (without TLD) |
| `tld` | string | ✅ | Top-level domain (e.g., "com", "dev", "ai") |

**Response (201):**
```json
{
  "id": "dom_ghi789",
  "domain": "myagent.dev",
  "tld": "dev",
  "owner": "7xKXt...payer-wallet",
  "status": "pending",
  "registrar": "namecheap",
  "dnsRecords": [],
  "registeredAt": "2025-01-15T10:30:00Z",
  "expiresAt": "2026-01-15T10:30:00Z"
}
```

---

#### `GET /domains/:id`

Get domain status and DNS records.

| Field | Details |
|-------|---------|
| **Cost** | 0.01 USDC |

**Request:**
```bash
curl https://api.agentos.dev/domains/dom_ghi789 \
  -H "X-Payment: <tx-signature>"
```

**Response (200):**
```json
{
  "id": "dom_ghi789",
  "domain": "myagent.dev",
  "tld": "dev",
  "owner": "7xKXt...",
  "status": "active",
  "registrar": "namecheap",
  "dnsRecords": [
    { "type": "A", "name": "@", "value": "1.2.3.4", "ttl": 3600 }
  ],
  "registeredAt": "2025-01-15T10:30:00Z",
  "expiresAt": "2026-01-15T10:30:00Z"
}
```

---

#### `PUT /domains/:id/dns`

Update DNS records for a domain.

| Field | Details |
|-------|---------|
| **Cost** | 0.10 USDC |

**Request:**
```bash
curl -X PUT https://api.agentos.dev/domains/dom_ghi789/dns \
  -H "Content-Type: application/json" \
  -H "X-Payment: <tx-signature>" \
  -d '{
    "records": [
      { "type": "A", "name": "@", "value": "1.2.3.4", "ttl": 3600 },
      { "type": "CNAME", "name": "www", "value": "myagent.dev", "ttl": 3600 },
      { "type": "MX", "name": "@", "value": "mail.myagent.dev", "ttl": 3600, "priority": 10 }
    ]
  }'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `records` | array | ✅ | Array of DNS records |
| `records[].type` | string | ✅ | Record type: A, AAAA, CNAME, MX, TXT, NS, SRV |
| `records[].name` | string | ✅ | Record name (e.g., "@", "www") |
| `records[].value` | string | ✅ | Record value |
| `records[].ttl` | number | ✅ | Time to live (seconds) |
| `records[].priority` | number | ❌ | Priority (for MX/SRV records) |

**Response (200):**
```json
{
  "id": "dom_ghi789",
  "domain": "myagent.dev",
  "dnsRecords": [
    { "type": "A", "name": "@", "value": "1.2.3.4", "ttl": 3600 },
    { "type": "CNAME", "name": "www", "value": "myagent.dev", "ttl": 3600 }
  ]
}
```

---

### Compute

#### `POST /compute/servers`

Create a new cloud server (Hetzner Cloud).

| Field | Details |
|-------|---------|
| **Cost** | 5.00 USDC |
| **Rate Limit** | 5 req / 60s |

**Request:**
```bash
curl -X POST https://api.agentos.dev/compute/servers \
  -H "Content-Type: application/json" \
  -H "X-Payment: <tx-signature>" \
  -d '{
    "name": "my-agent-server",
    "serverType": "cx22",
    "image": "ubuntu-24.04",
    "sshKeyIds": [12345]
  }'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | ✅ | Server name |
| `serverType` | string | ✅ | Server tier: `cx22`, `cx32`, `cx42`, `cx52` |
| `image` | string | ❌ | OS image (default: `ubuntu-24.04`) |
| `sshKeyIds` | number[] | ❌ | SSH key IDs to install |

**Server Types:**

| Type | vCPU | RAM | Monthly |
|------|------|-----|---------|
| `cx22` | 2 | 4 GB | $5.00 |
| `cx32` | 4 | 8 GB | $10.00 |
| `cx42` | 8 | 16 GB | $20.00 |
| `cx52` | 16 | 32 GB | $40.00 |

**Response (201):**
```json
{
  "id": "srv_jkl012",
  "name": "my-agent-server",
  "serverType": "cx22",
  "image": "ubuntu-24.04",
  "status": "initializing",
  "ipv4": "203.0.113.50",
  "ipv6": "2001:db8::1",
  "owner": "7xKXt...",
  "priceMonthly": "5.00",
  "createdAt": "2025-01-15T10:30:00Z",
  "rootPassword": "auto-generated-password"
}
```

---

#### `GET /compute/servers`

List all servers owned by the payer.

| Field | Details |
|-------|---------|
| **Cost** | 0.01 USDC |

**Request:**
```bash
curl https://api.agentos.dev/compute/servers \
  -H "X-Payment: <tx-signature>"
```

**Response (200):**
```json
{
  "servers": [
    {
      "id": "srv_jkl012",
      "name": "my-agent-server",
      "serverType": "cx22",
      "status": "running",
      "ipv4": "203.0.113.50"
    }
  ]
}
```

---

#### `GET /compute/servers/:id`

Get detailed server status.

| Field | Details |
|-------|---------|
| **Cost** | 0.01 USDC |

**Request:**
```bash
curl https://api.agentos.dev/compute/servers/srv_jkl012 \
  -H "X-Payment: <tx-signature>"
```

---

#### `DELETE /compute/servers/:id`

Terminate a server.

| Field | Details |
|-------|---------|
| **Cost** | 0.10 USDC |

**Request:**
```bash
curl -X DELETE https://api.agentos.dev/compute/servers/srv_jkl012 \
  -H "X-Payment: <tx-signature>"
```

**Response (200):**
```json
{
  "deleted": true,
  "id": "srv_jkl012"
}
```

---

#### `POST /compute/ssh-keys`

Upload an SSH public key for use when creating servers.

| Field | Details |
|-------|---------|
| **Cost** | 0.10 USDC |

**Request:**
```bash
curl -X POST https://api.agentos.dev/compute/ssh-keys \
  -H "Content-Type: application/json" \
  -H "X-Payment: <tx-signature>" \
  -d '{
    "name": "my-key",
    "publicKey": "ssh-ed25519 AAAAC3..."
  }'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | ✅ | Key label |
| `publicKey` | string | ✅ | SSH public key content |

**Response (201):**
```json
{
  "id": 12345,
  "name": "my-key"
}
```

---

### API Keys

#### `POST /apikeys`

Provision a new API key for a third-party service.

| Field | Details |
|-------|---------|
| **Cost** | 1.00 USDC |
| **Rate Limit** | 10 req / 60s |

**Request:**
```bash
curl -X POST https://api.agentos.dev/apikeys \
  -H "Content-Type: application/json" \
  -H "X-Payment: <tx-signature>" \
  -d '{
    "provider": "openai",
    "label": "my-agent-key"
  }'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | string | ✅ | Provider: `brave_search`, `helius`, `openai`, `anthropic`, `elevenlabs`, `custom` |
| `label` | string | ❌ | Human-readable label |

**Provider Pricing:**

| Provider | Cost |
|----------|------|
| `brave_search` | 1.00 USDC |
| `helius` | 2.00 USDC |
| `openai` | 1.00 USDC |
| `anthropic` | 1.00 USDC |
| `elevenlabs` | 1.00 USDC |
| `custom` | 0.50 USDC |

**Response (201):**
```json
{
  "id": "key_mno345",
  "provider": "openai",
  "label": "my-agent-key",
  "secret": "sk-...",
  "owner": "7xKXt...",
  "priceUsdc": "1.00",
  "active": true,
  "createdAt": "2025-01-15T10:30:00Z"
}
```

---

#### `GET /apikeys`

List all active API keys for the payer.

| Field | Details |
|-------|---------|
| **Cost** | 0.01 USDC |

**Request:**
```bash
curl https://api.agentos.dev/apikeys \
  -H "X-Payment: <tx-signature>"
```

**Response (200):**
```json
{
  "keys": [
    {
      "id": "key_mno345",
      "provider": "openai",
      "label": "my-agent-key",
      "active": true,
      "createdAt": "2025-01-15T10:30:00Z"
    }
  ]
}
```

---

#### `DELETE /apikeys/:id`

Revoke an API key.

| Field | Details |
|-------|---------|
| **Cost** | 0.01 USDC |

**Request:**
```bash
curl -X DELETE https://api.agentos.dev/apikeys/key_mno345 \
  -H "X-Payment: <tx-signature>"
```

**Response (200):**
```json
{
  "revoked": true,
  "id": "key_mno345"
}
```

---

## Quick Start: Full Example

```bash
# 1. Check pricing (free)
curl https://api.agentos.dev/pricing

# 2. Send 1.00 USDC to the treasury wallet on Solana
#    (use solana CLI, @solana/web3.js, or any wallet)

# 3. Use the transaction signature to create an email inbox
curl -X POST https://api.agentos.dev/email/inboxes \
  -H "Content-Type: application/json" \
  -H "X-Payment: 5UfDuX7hJ3Rg...your-tx-sig" \
  -d '{"name": "my-ai-agent"}'

# 4. Your agent now has: my-ai-agent@mail.agentos.dev ✅
```

---

Built by **Zolty** ⚡ for the [Colosseum Agent Hackathon](https://www.colosseum.org/)
