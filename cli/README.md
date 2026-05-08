# @agntos/agentos

[![npm](https://img.shields.io/npm/v/@agntos/agentos?style=flat-square&logo=npm&logoColor=white&color=f54900)](https://www.npmjs.com/package/@agntos/agentos)
[![downloads](https://img.shields.io/npm/dm/@agntos/agentos?style=flat-square&color=333)](https://www.npmjs.com/package/@agntos/agentos)
[![license](https://img.shields.io/npm/l/@agntos/agentos?style=flat-square&color=333)](https://github.com/0xArtex/AgentOS/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@agntos/agentos?style=flat-square&color=333)](https://nodejs.org)

The agent-native CLI and SDK for AgentOS.

Phone numbers, end-to-end encrypted email, VPS, domains, and non-custodial crypto wallets — accessed over the [x402](https://github.com/coinbase/x402) HTTP payment protocol. Pay per call in USDC on Solana or Base. No accounts, no API keys, no monthly bills.

```
npm i -g @agntos/agentos
agentos wallet create
agentos phone search --country US
```

---

## Table of Contents

- [Overview](#overview)
- [Install](#install)
- [Quick Start](#quick-start)
- [Wallets](#wallets)
- [Command Reference](#command-reference)
  - [Phone & SMS](#phone--sms)
  - [Voice Calls](#voice-calls)
  - [Email](#email)
  - [Compute](#compute)
  - [Domains](#domains)
  - [Wallet](#wallet)
  - [Twitter / X](#twitter--x)
  - [Utility](#utility)
- [SDK](#sdk)
- [Output Modes](#output-modes)
- [Configuration](#configuration)
- [File Layout](#file-layout)
- [Exit Codes](#exit-codes)
- [Security Model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Links](#links)

---

## Overview

`@agntos/agentos` is the official client for the AgentOS API at `agntos.dev`. Two interfaces ship in one package:

- **`agentos` CLI** — works in interactive terminals (TUI) and in agent pipelines (raw JSON, auto-detected).
- **`AgentOS` SDK** — typed TypeScript/JavaScript class importable as `@agntos/agentos`.

**Identity model.** There are no user accounts. The wallet that signs each `x402` payment becomes the owner of the resource it just paid for (an inbox, a phone number, a VPS). Re-paying from the same wallet proves continued ownership.

**Payment chains.** USDC on Solana (mainnet-beta, SPL) and USDC on Base (EIP-3009, gasless via the AgentOS facilitator).

---

## Install

Global install (recommended):

```bash
npm i -g @agntos/agentos
```

One-off, no install:

```bash
npx @agntos/agentos phone search --country US
```

Requires Node.js 18 or later.

---

## Quick Start

```bash
# 1. Create a wallet (local, no signup, no server round-trip)
agentos wallet create --name "agent-prod"

# 2. Set it as the default payer and pick a chain
agentos wallet use <WALLET_ID> --chain solana

# 3. Fund it with a few USDC. Print the address you funded:
agentos wallet info <WALLET_ID>

# 4. Use a paid endpoint — payment is automatic
agentos phone buy --country US
```

The wallet file lives in `~/.agentos/wallet/wallets/<id>.json`, AES-256-GCM encrypted with a session secret stored in your operating system's credential store (DPAPI on Windows, Keychain on macOS, secret-tool on Linux).

---

## Wallets

AgentOS wallets are **standard BIP-39 HD wallets** that derive both:

- a **Solana** address (Ed25519, path `m/44'/501'/0'/0'`)
- a **Base / EVM** address (secp256k1, path `m/44'/60'/0'/0/0`)

from a single 12-word mnemonic. Wallets are created locally; the seed never leaves your machine.

### Two modes

| Mode | Custody | When to use |
|---|---|---|
| **Unmanaged** *(default)* | Agent has full custody. Signs instantly with no human in the loop. | Agents that you fully trust to manage a budget. |
| **Managed** | Agent holds the key for sub-limit signing, but transactions over a per-tx or daily USDC limit require human approval via passkey (FaceID, Touch ID, YubiKey). | Production agents where a human keeps a safety check. |

### Creating a wallet

```bash
# Unmanaged: one command, ready to sign
agentos wallet create --name agent-prod

# Managed: prints a setup link to send to a human
agentos wallet create --name treasury --managed
```

The managed flow returns a one-time URL. The recipient opens it in a browser, registers a WebAuthn passkey, and sets spending limits. From that point on, transactions inside the limit sign instantly; transactions over the limit emit an `approvalUrl` that the human visits to authenticate and approve.

### Importing an existing seed

```bash
agentos wallet import --mnemonic "twelve word seed phrase ..." --name imported
```

### Exporting a seed

```bash
agentos wallet export <WALLET_ID> --confirm
```

The `--confirm` flag is mandatory and is enforced by the CLI. The seed is decrypted in-process and printed once.

---

## Command Reference

Costs in the tables below are paid in **USDC** at request time via x402. Endpoints marked `free` require no payment.

### Phone & SMS

| Command | Cost | Notes |
|---|---|---|
| `agentos phone search --country US [--limit N]` | free | Search inventory by country (ISO-2). |
| `agentos phone buy --country US [--area 415]` | $3.00 | Provisions a real number. Local numbers preferred over toll-free. |
| `agentos phone messages --id <ID>` | $0.02 | Read inbound SMS history. |
| `agentos phone sms --id <ID> --to +1... --body "..."` | $0.05 | Send SMS. Pre-flight rejects malformed E.164 and unsupported destinations before charging. |
| `agentos phone delete --id <ID>` | $0.01 | Release the number. |

### Voice Calls

| Command | Cost | Notes |
|---|---|---|
| `agentos phone call --id <ID> --to +1... [--tts "..."]` | $0.10 | Outbound dial with optional text-to-speech on connect. |

Live-call control endpoints (speak, play, dtmf, gather, record, hangup, transfer) are exposed through the SDK and the REST API. See [agntos.dev/docs](https://agntos.dev) for the full call-control surface.

### Email

End-to-end encrypted inboxes at `<name>@agntos.dev`. Messages are encrypted at rest with the inbox's wallet public key (NaCl `box`, X25519 + XSalsa20-Poly1305) so the server cannot read them.

| Command | Cost | Notes |
|---|---|---|
| `agentos email create --name agent --wallet <SOL_PUBKEY>` | $2.00 | Wallet must be a base58 Solana pubkey (32 bytes). EVM addresses are rejected before payment. |
| `agentos email read --id <INBOX_ID>` | $0.02 | Wallet that paid must own the inbox. |
| `agentos email send --id <ID> --to a@b.com --subject "Hi" --body "..."` | $0.08 | |
| `agentos email threads --id <INBOX_ID>` | $0.02 | List conversation threads. |

### Compute

VPS instances on Hetzner-class hardware. Plans are listed live; the `cx23` plan is a 4 vCPU / 8 GB / 80 GB SSD baseline.

#### Golden path

The bare command is a one-liner: it auto-generates an ed25519 keypair, deploys, blocks until the server is reachable, verifies SSH actually works, and returns a usable shell command in the JSON response.

```bash
agentos compute deploy --type cx23 --json
```

That single call:
1. Generates `~/.agentos/ssh/<server-name>/id_ed25519{,.pub}` (chmod 600).
2. Inlines the public key into Hetzner's cloud-init so it's in `authorized_keys` at first boot.
3. Pays the $6 deploy fee via x402 (Solana or Base USDC).
4. Polls until Hetzner reports `status=running` (gate 1).
5. TCP-probes port 22 until sshd accepts (gate 2).
6. Runs `ssh -i <key> root@<ip> 'true'` to confirm authentication (gate 3).
7. Returns JSON with a top-level `sshCommand` and a `readiness` block.

Drop into the new VPS:

```bash
agentos compute ssh <name>
```

Names resolve from a local cache populated by `compute deploy`; `compute ssh` looks up the IP and path to the matching private key without a paid API round-trip.

#### Bootstrap an agent runtime (`--install`)

Pass `--install <recipe>` to bake an AI-agent runtime into the deploy. Cloud-init runs the recipe before SSH gets handed back to you, and the readiness chain gains a fourth gate that polls `/etc/agentos/install-status.json` until every requested recipe reports `status: ok`.

```bash
# Deploy with Hermes Agent (Nous Research) bootstrapped at first boot
agentos compute deploy --type cx23 --install hermes --json

# Multiple recipes — runs in order
agentos compute deploy --type cx23 --install hermes,openclaw --json

# Discover what's installable
agentos compute install-recipes --json

# Vanilla Ubuntu — no runtime, password auth stays enabled
agentos compute deploy --type cx23 --no-install --json
```

| Recipe | What lands on the box |
|---|---|
| `openclaw` *(default when `--install` is omitted)* | Node 22 + `openclaw` and `clawhub` global npm packages. Provisioning marker at `/etc/openclaw/provision.json`. |
| `hermes` | [Hermes Agent](https://github.com/NousResearch/hermes-agent) — Nous Research's self-improving AI agent. Installed via the official `scripts/install.sh --skip-setup`, lands at `/usr/local/bin/hermes`. Pulls Python 3.11 + a few hundred MB of pip packages — adds 2–4 minutes to the deploy. After the deploy, run `agentos compute exec <name> -- hermes setup` (or SSH in and run `hermes setup`) to pick a model provider. |

Recipe validation is **pre-payment**: passing `--install bogus` exits with `EXIT.BAD_INPUT` (2) before any USDC is charged. The CLI defaults `--wait-timeout` to 600s when `--install` is set; override with `--wait-timeout <seconds>` (clamped 30–900).

#### Failure recovery

When `--wait` reports `ready: false`, the JSON response includes a `readiness.diagnostics` block with the cloud-init status, the tail of `/var/log/cloud-init-output.log`, and per-recipe install logs — fetched automatically over SSH so you don't have to log in by hand to figure out what went wrong:

```jsonc
{
  "readiness": {
    "ready": false,
    "checks": { "hetznerStatus": "pass", "port22": "pass", "ssh": "pass", "installs": "fail" },
    "reason": "cloud-init aborted (status: error). The user_data script failed before writing the install marker.",
    "diagnostics": {
      "cloudInitStatus": "status: error\nboot_status_code: enabled-by-...\nlast_update: ...",
      "cloudInitLogTail": "...last 120 lines of /var/log/cloud-init-output.log...",
      "agentosLogTail": "...last 80 lines of /var/log/agentos/cloud-init.log...",
      "recipeLogs": [{ "name": "hermes", "tail": "...last 80 lines..." }]
    }
  }
}
```

The wait fast-fails when `cloud-init status` reports `error` instead of waiting the full timeout. Re-run the chain against the same server with:

```bash
agentos compute wait my-vps --install hermes --json
```

Cloud-init logs also live on the box if you want to look directly:

```bash
agentos compute exec my-vps -- tail -200 /var/log/cloud-init-output.log
agentos compute exec my-vps -- tail -200 /var/log/agentos/hermes-install.log
```

#### Streaming progress

In agent mode, `compute deploy --wait` and `compute wait` emit one NDJSON event per gate transition to **stderr** — by default. Stdout still gets one final JSON object so `jq` pipelines aren't disturbed; stderr is the live event stream you can `tail -f` while a long install runs.

```bash
agentos compute deploy --type cx23 --install hermes --json
```

Stderr stream (real-time):

```jsonc
{"event":"created","id":"12345","ipv4":"1.2.3.4","installs":["hermes"],"waitTimeoutSec":600}
{"event":"progress","stage":"status","message":"Waiting for Hetzner status=running…"}
{"event":"progress","stage":"port22","message":"Probing port 22…"}
{"event":"progress","stage":"ssh","message":"Verifying SSH login..."}
{"event":"progress","stage":"installs","message":"Waiting for installs to finish: hermes…"}
```

Stdout (at the end):

```jsonc
{ "id": "12345", "ipv4": "1.2.3.4", "sshCommand": "ssh -i ... root@1.2.3.4", "readiness": { ... } }
```

Add `--no-progress` to silence the stderr stream:

```bash
agentos compute deploy --type cx23 --install hermes --json --no-progress
```

Capture stderr for later analysis (POSIX shell redirection, not a CLI flag):

```bash
agentos compute deploy --type cx23 --install hermes --json 2>progress.ndjson
```

#### SSH-key management

| Command | Cost | Notes |
|---|---|---|
| `agentos compute ssh-key add <pubkey-file> [--name "label"]` | $0.10 | Upload an SSH public key to Hetzner. Returns numeric `id` you can pass to `--ssh-key`. Reusable across deploys. |
| `agentos compute ssh-key list` | $0.01 | List uploaded keys with fingerprints. |
| `agentos compute ssh-key delete <id>` | $0.01 | Remove a key from Hetzner. Existing servers keep the key in `authorized_keys`. |

#### Deploy

| Command | Cost | Notes |
|---|---|---|
| `agentos compute plans [--location fsn1]` | free | List server types and monthly pricing. With `--location`, filters to types deployable in that datacenter. Each row carries an `availableLocations[]` array so you can see where each type runs. |
| `agentos compute locations` | free | List Hetzner datacenters (fsn1 / nbg1 / hel1 / ash / hil / sin) with city, country, network zone, and the live deployable server-type list per location. |
| `agentos compute install-recipes` | free | List recipes you can pass to `--install`. |
| `agentos compute deploy [--type cx23] [--name N]` | $6.00 | Golden path (auto-key, auto-wait, verified). Deployment fee; monthly server cost is metered separately. |
| `agentos compute deploy --install hermes` | $6.00 | Bootstrap an agent runtime (Hermes Agent, OpenClaw) via cloud-init; deploy waits until `/etc/agentos/install-status.json` reports `ok`. |
| `agentos compute deploy --install hermes,openclaw` | $6.00 | Multiple recipes, run in order. |
| `agentos compute deploy --location fsn1` | $6.00 | Pick a Hetzner datacenter explicitly. Server pre-validates type+location compatibility before x402 settles, so `cax11 + ash` fails as 400 with `Try one of: fsn1` instead of 422 after payment. |
| `agentos compute deploy --no-install` | $6.00 | Skip cloud-init entirely → vanilla Ubuntu, password auth stays enabled, returned `rootPassword` works. |
| `agentos compute deploy --ssh-key <id>` | $6.00 | Use a pre-uploaded Hetzner key (numeric ID from `ssh-key list`). Preferred for repeatable deploys. |
| `agentos compute deploy --pubkey-file ~/.ssh/id_ed25519.pub` | $6.00 | Inline an existing key without uploading to Hetzner first. |
| `agentos compute deploy --pubkey "ssh-ed25519 AAAA..."` | $6.00 | Same, raw key string instead of a file. |
| `agentos compute deploy --no-generate-ssh-key` | $6.00 | Opt out of auto-generation. Server boots with the platform's temp key only — call `setup-ssh` later or you can't get in. |
| `agentos compute deploy --no-wait` | $6.00 | Fire-and-forget. Returns as soon as Hetzner accepts the create call. |
| `agentos compute deploy --wait-timeout 300` | $6.00 | Override the default 240s readiness budget (600s when `--install` is set). Clamped 30–900. |

**Server name rules.** Server names are lowercase RFC 1123 hostnames: 1–253 chars of `[a-z0-9.-]`, starting and ending alphanumeric, no uppercase, no underscores. The CLI validates client-side and the server validates pre-payment, so `--name Hermesbot` fails as 400 with no USDC charged.

The four key sources (`--ssh-key <id>`, `--pubkey-file`, `--pubkey`, `--generate-ssh-key`) are mutually exclusive — passing more than one returns exit 2 with a clear error.

#### Wait + SSH

| Command | Cost | Notes |
|---|---|---|
| `agentos compute wait <name|id> [--key <path>] [--wait-timeout <sec>]` | $0.01 | Run the readiness chain against an existing server. Useful when the original deploy ran without `--wait` or its wait timed out. Exits `4` (NOT_FOUND) when not ready, `0` when all gates pass. Stdout always carries the full readiness JSON. |
| `agentos compute ssh <name|id>` | free | Drop into the server (TTY mode) or print the equivalent `ssh -i <key> root@<ip>` command (agent mode). Resolves from local cache; no paid API call. |
| `agentos compute setup-ssh <id> --pubkey-file ~/.ssh/id.pub` | $0.01 | Inject your public key into a server you didn't supply a key for at deploy time. Locks the root password and removes the platform's temporary key — after this, only your key works. |

#### Lifecycle + actions

Each takes `<name|id>` from the local cache (or a numeric Hetzner id directly).

| Command | Cost | Notes |
|---|---|---|
| `agentos compute reboot <name|id>` | $0.10 | Graceful restart. |
| `agentos compute poweroff <name|id>` | $0.10 | Graceful shutdown — data preserved. |
| `agentos compute poweron <name|id>` | $0.10 | Power on a stopped server. |
| `agentos compute reset <name|id>` | $0.10 | Hard restart, no graceful shutdown. |
| `agentos compute rebuild <name|id> [--image ubuntu-24.04]` | $0.10 | Reinstall OS — wipes disk, re-runs cloud-init, keeps IP. |
| `agentos compute rename <name|id> <new-name>` | $0.01 | Rename a deployed VPS (metadata-only; no reboot). Updates the local cache so `compute ssh <new-name>` works immediately after. New name validated client-side and pre-payment server-side. |
| `agentos compute reset-password <name|id>` | $0.10 | Rotate the root password (Hetzner-side). On AgentOS-deployed boxes, password auth is disabled by cloud-init — the new password is for console use or after manually re-enabling password auth. Use `setup-ssh` for SSH access. |
| `agentos compute console <name|id>` | $0.10 | Get a noVNC console URL (`wssUrl` + `password`, expires ~1 minute). Break-glass when SSH is unreachable (cloud-init failed, sshd misconfigured). |
| `agentos compute exec <name|id> -- <command> [args...]` | $0.05 | Run a single command pre-handoff via the platform's temporary SSH key. Returns `{stdout, stderr, exitCode, durationMs}`. Returns `410 Gone` once `setup-ssh` has run (the platform key is removed at handoff). 30s default timeout. |
| `agentos compute list` | $0.01 | List your servers. |
| `agentos compute delete <name|id>` | $0.10 | Terminate and stop billing. |

The `--` separator (POSIX convention) tells the parser everything after it is for the remote shell, not local CLI flags. Useful when the remote command takes its own dash-prefixed args:

```bash
agentos compute exec my-vps -- systemctl status --no-pager openclaw
agentos compute exec my-vps -- bash -c 'cloud-init clean && cloud-init init --all'
```

### Domains

| Command | Cost | Notes |
|---|---|---|
| `agentos domain check --name example.dev` | free | Availability check. |
| `agentos domain pricing --name example.dev` | free | TLD pricing. |
| `agentos domain buy --name example.dev` | $20.00 | One-year registration. Renewals are charged annually. |
| `agentos domain dns --name example.dev` | free | View DNS records. |

### Wallet

All wallet operations except `addresses`, `api-key`, `config`, and `request-approval` run **locally** with zero server contact.

| Command | Network | Notes |
|---|---|---|
| `agentos wallet create [--name N] [--managed]` | local *(server only if `--managed`)* | New wallet. Stores session secret in OS credential store. |
| `agentos wallet import --mnemonic "..." [--name N] [--managed]` | local | Restore from BIP-39. |
| `agentos wallet list` | local | Lists wallets in the local vault. |
| `agentos wallet info <ID>` | local | Show one wallet (id, name, addresses, mode). |
| `agentos wallet addresses <ID>` | API | Server-side derived addresses (multi-chain). |
| `agentos wallet sign-message <ID> --chain solana\|evm --msg "..."` | local | Sign an arbitrary message offline. |
| `agentos wallet api-key <ID> [--name N]` | API | Mint an agent API key bound to the wallet. |
| `agentos wallet config <ID>` | API | Pull the agent's runtime config. |
| `agentos wallet use <ID> [--chain solana\|base]` | local | Set default payer and payment chain. |
| `agentos wallet request-approval <ID> [--action limits] [--daily N] [--per-tx N]` | API | Managed wallets only — generate an approval URL for a human. |
| `agentos wallet export <ID> --confirm` | local | Print mnemonic. Requires explicit `--confirm`. |

### Twitter / X

Buy, manage, and operate X accounts directly from the CLI. Each account is pinned to a sticky residential IP for its lifetime — login, posting, and every subsequent action route through the same exit IP, so X never sees a sudden geography change.

Local credentials are encrypted with AES-256-GCM (per-account session secret in your OS credential store). Cookies are cached for 12 hours after login; commands that need a session call `twitter login` automatically when stale.

| Command | Cost | Notes |
|---|---|---|
| `agentos twitter buy` | $5.00 | Pay $5 USDC, receive a ready X account from the pool. Auto-imports into the local vault and primes the session — you can post immediately. |
| `agentos twitter import <username> --credentials-line "login:pw:email:email_pw:2fa:ct0:auth_token"` | free | Bring your own account. Accepts the standard 4 / 5 / 7-field colon format common in marketplace exports. |
| `agentos twitter import <username> --login E --password P [--email-password X] [--totp-seed S] [--auth-token T --ct0 C]` | free | Same, with explicit flags. |
| `agentos twitter list` | free | List local accounts. |
| `agentos twitter info <username>` | free | Show one account (id, addresses, last action, source). |
| `agentos twitter rename <old> --to <new>` | free | Rename the local handle (does not change the X handle — use `twitter username` for that). |
| `agentos twitter remove <username> --confirm` | free | Delete the local copy. The X account itself is not deleted. |
| `agentos twitter totp <username>` | free | Print the current 2FA code derived from the stored seed. |
| `agentos twitter login <username>` | $0.005 | Open a Playwright stealth session, log in through the account's residential IP, cache cookies for 12h. |
| `agentos twitter session <username>` | free | Show whether a session is cached, age in hours, and staleness. |
| `agentos twitter post <username> --body "..."` | $0.001 | Post a text-only tweet. Returns `tweet_id` after server-side verification. |
| `agentos twitter post <username> --body "..." --image path[,path,path,path]` *(or `--video path.mp4`, or `--media-json '[...]'`)* | $0.005 | Post with attached media: 1-4 images OR 1 video (X allows one or the other, never both). Local files are base64-encoded; use `--media-json` to pass `image_url`/`video_url` for server-side fetch. |
| `agentos twitter thread <username> --texts '[...]'` *(or `--file thread.json`)* | $0.005 | Post a 2-25 tweet native X thread in one composed session. JSON array of strings, each ≤280 chars. Returns `tweet_ids[]` and `tweet_urls[]`. |
| Add `--community <id>` to any of the above | same | Scope the post / thread / media-post to an X community. `<id>` is the numeric community ID (15-30 digits) — find it in the URL when viewing the community on x.com. Account must be a member. |
| `agentos twitter reply <username> --to <tweet-url> --body "..."` | $0.001 | Reply to a tweet. |
| `agentos twitter like <username> --tweet <url>` | $0.001 | |
| `agentos twitter retweet <username> --tweet <url>` | $0.001 | |
| `agentos twitter follow <username> --user @handle` | $0.001 | |
| `agentos twitter unfollow <username> --user @handle` | $0.001 | Handles both confirm-modal and instant-unfollow paths. Returns a clear error if X blocks unfollow on a monetised account. |
| `agentos twitter delete <username> --tweet <url>` | $0.001 | |
| `agentos twitter bio <username> --text "..."` | $0.001 | Pass `--text ""` to clear. |
| `agentos twitter name <username> --display "..."` | $0.001 | |
| `agentos twitter location <username> --text "..."` | $0.001 | |
| `agentos twitter website <username> --url https://...` | $0.001 | |
| `agentos twitter pfp <username> --file path.png` *(or `--url https://...`)* | $0.005 | PNG / JPG / WebP / GIF. Local file is base64-encoded; URL is fetched server-side with SSRF guard. |
| `agentos twitter banner <username> --file path.png` *(or `--url ...`)* | $0.005 | |
| `agentos twitter username <username> --to <new-handle>` | $0.005 | Pre-flight validates handle (4–15 chars, `[A-Za-z0-9_]`) before payment. May trigger X's password re-auth modal — handled automatically. |

**Verification.** Operations are confirmed at the network layer — the server intercepts X's actual API responses (`CreateTweet`, `FavoriteTweet`, `update_profile`, etc.) before reporting success. No false positives.

### Server-side account registration (foundation for fire-and-forget scheduling)

Upload your X credentials to AgentOS once. The server encrypts them at rest with AES-256-GCM (key in `REGISTERED_ACCOUNTS_KEY` env var, never logged) and from then on can re-login on your wallet's behalf to refresh cookies whenever they go stale. This is what makes scheduled posts fire even when your machine is off.

**Security:** every read/write is wallet-scoped at the API layer — wallet A can never see or revoke wallet B's accounts. Per-row random IV + auth tag. DB leak alone reveals nothing without the env var. Server compromise (DB + env both leaked) = credentials decryptable; same trade-off every "we hold OAuth tokens" SaaS makes (Buffer / Hootsuite / Postiz).

| Command | Cost | Notes |
|---|---|---|
| `agentos twitter register <username>` *(if account already in local vault)* | $0.01 | Reads creds from local vault, sends to server, server runs a real test login through a fresh residential session, encrypts + stores on success. Returns `account_id` and `cookies_captured`. |
| `agentos twitter register <username> --password "..."` *(plus `--login`, `--totp-seed`, `--email`, `--email-password`, `--auth-token`, `--ct0`, `--country`)* | $0.01 | Same, but with explicit credentials instead of vault lookup. |
| `agentos twitter unregister <username-or-account-id>` | free | Wipes the encrypted credential + cookie blobs from the server (status flips to `revoked`). Looks up account by username if you don't pass the 32-char hex id. |
| `agentos twitter registered` | free | List all your wallet's registered accounts (id, username, country, status, last_login_at). |

Once registered, schedule fire-and-forget posts via the commands below. The AgentOS server's internal scheduler fires them at `post_at` automatically — nothing to run on your machine.

### Server-side scheduling (fire-and-forget)

Pay at schedule time; the AgentOS server fires posts at `post_at` whether your machine is on or off. The account must be registered first (see above). Failure handling: retryable errors (rate limits, transient browser issues) get re-tried with exponential backoff up to 3 attempts; terminal errors (session expired, bad input) move to `failed` for inspection via `--status failed`.

| Command | Cost | Notes |
|---|---|---|
| `agentos twitter schedule <username> --body "..." --at "2026-05-15T14:00:00Z"` *(or `--texts '[...]'`, plus optional `--image`/`--video`/`--media-json`/`--community`)* | $0.001 text / $0.005 thread or media | x402-paywalled at the post's full price; payment commits to the eventual fire (worker fires for free). Action inferred from flags. Returns `schedule_id`. |
| `agentos twitter queue [--status pending\|in_progress\|completed\|failed\|cancelled] [--account-id <id>] [--from <iso>] [--to <iso>] [--limit N]` | free | Server-backed list, wallet-scoped. |
| `agentos twitter cancel <schedule-id>` | free | Cancel a pending scheduled post. In-progress / completed / failed cannot be cancelled. No refund per Buffer/Hootsuite model. |

The previous local-queue + `agentos worker` daemon were deprecated when server-side scheduling shipped. `agentos worker` now prints a deprecation pointer.

### Utility

| Command | Cost | Notes |
|---|---|---|
| `agentos setup [--keyfile PATH] [--chain solana\|base]` | free | One-time bootstrap. Initialises `~/.agentos/`, optionally binds a Solana keyfile for legacy use. |
| `agentos status` | free | Show wallet config, default chain, and live API health. |
| `agentos config` | free | Print the resolved config (paths, defaults, env overrides). |
| `agentos doctor` | free | Diagnose vault, credential store, and connectivity. Non-zero exit if anything fails. |
| `agentos pricing` | free | Live price list from the API. |
| `agentos health` | free | API uptime, version, and chain status. |
| `agentos note "..."` | free | Append a timestamped note to `~/.agentos/memory/notes.md`. |

---

## SDK

The same package exports a typed `AgentOS` class for use in Node.js applications.

```typescript
import { AgentOS } from '@agntos/agentos'

const ao = new AgentOS({
  api: 'https://agntos.dev',           // optional, default
  autoPay: true,                        // sign x402 challenges automatically
  token: process.env.AGENTOS_TOKEN,     // optional API key
})

// Free, returns immediately
const numbers = await ao.phoneSearch('US', 5)

// Paid: triggers an x402 challenge that ao signs with the configured wallet
const inbox = await ao.emailCreate('agent', '6mqej25Y32ZWGk3VydUAU4iFr74ripzSURKzYH39SzLy')

// Paid + read
const messages = await ao.emailRead(inbox.id)
```

### Selected SDK methods

```typescript
// Phone
ao.phoneSearch(country: string, limit?: number)
ao.phoneBuy(country: string, areaCode?: string)
ao.phoneSms(phoneId: string, to: string, body: string)
ao.phoneCall(phoneId: string, to: string, tts?: string)

// Email
ao.emailCreate(name: string, walletAddress: string)
ao.emailRead(inboxId: string)
ao.emailSend(inboxId: string, to: string, subject: string, body: string)
ao.emailThreads(inboxId: string)

// Compute
ao.computePlans(opts?: { location?: string })                                  // optional ?location=fsn1 filter
ao.computeLocations()                                                           // free, list datacenters + per-location availability
ao.computeInstallRecipes()                                                      // discover --install names (free)
ao.computeDeploy(name: string, type: string, opts?: { sshPublicKey?: string; sshKeyIds?: number[]; installOpenClaw?: boolean; install?: string | string[]; location?: string })
ao.computeList()
ao.computeGet(serverId: string)
ao.computeDelete(serverId: string)
ao.computeRename(serverId: string, newName: string)                             // PUT /servers/:id, metadata-only
ao.computeAction(serverId: string, action: string, opts?: { image?: string })  // reboot | poweron | poweroff | reset | rebuild | reset_password | request_console
ao.computeExec(serverId: string, command: string, args?: string[], opts?: { timeoutSec?: number })  // pre-handoff only
ao.computeSetupSsh(serverId: string, publicKey: string)  // inject key, lock password, hand off
ao.computeSshKeyAdd(name: string, publicKey: string)
ao.computeSshKeyList()
ao.computeSshKeyDelete(id: number | string)

// Domains
ao.domainCheck(domain: string)
ao.domainPricing(domain: string)
ao.domainBuy(domain: string)
ao.domainDns(domain: string)

// Wallet (server-side metadata; key material stays local)
ao.walletList()
ao.walletAddresses(walletId: string)
ao.walletPolicy(walletId: string, policy: { per_tx_usdc?: number; daily_usdc?: number; allowed_chains?: string[] })
ao.walletSpending(walletId: string)
ao.walletApiKey(walletId: string, name: string, sessionSecret: string)
ao.walletRequestApproval(walletId: string, action: string, params: object)

// Twitter / X
ao.socialTwitterBuy()
ao.socialTwitterLogin(accountId, login, password, totpSeed?, cookies?, proxySessionId?)
ao.socialTwitterPost(accountId, cookies, text, proxySessionId?, communityId?)
ao.socialTwitterPostThread(accountId, cookies, texts, proxySessionId?, communityId?)
ao.socialTwitterPostWithMedia(accountId, cookies, text, media, proxySessionId?, communityId?)  // media: [{image_url|image_base64|video_url|video_base64}], 1-4 images OR 1 video
ao.socialTwitterReply(accountId, cookies, tweetUrl, text, proxySessionId?)
ao.socialTwitterLike(accountId, cookies, tweetUrl, proxySessionId?)
ao.socialTwitterRetweet(accountId, cookies, tweetUrl, proxySessionId?)
ao.socialTwitterFollow(accountId, cookies, targetUser, proxySessionId?)
ao.socialTwitterUnfollow(accountId, cookies, targetUser, proxySessionId?)
ao.socialTwitterDelete(accountId, cookies, tweetUrl, proxySessionId?)
ao.socialTwitterProfile(accountId, cookies, { bio?, display_name?, location?, website? }, proxySessionId?)
ao.socialTwitterAvatar(accountId, cookies, { image_base64? | image_url? }, proxySessionId?)
ao.socialTwitterBanner(accountId, cookies, { image_base64? | image_url? }, proxySessionId?)
ao.socialTwitterUsername(accountId, cookies, newUsername, proxySessionId?)

// Info
ao.pricing()
ao.health()
```

The full method list is exported from `@agntos/agentos` with `.d.ts` typings.

---

## Output Modes

The CLI auto-switches between a human TUI and an agent-friendly JSON contract.

- **TTY (default)** → interactive Ink screens for menus, status, wallet create, etc., plus key-coloured JSON for data commands.
- **Agent mode** → raw JSON on stdout, NDJSON for streaming commands, structured `{error, exitCode, hint}` on stderr for failures, no spinners, no ANSI escape codes, no Ink screens.

Agent mode is **on** when any of these are true:

- stdout is not a TTY (you piped, redirected, or you're running inside a non-interactive runner like `cron`, `docker run`, CI),
- you pass `--json`,
- `AGENTOS_JSON=1` is set in the environment.

```bash
# Interactive — nice menus, spinners, the whole TUI
agentos wallet list

# Agent mode (auto, because of the pipe)
agentos wallet list | jq '.wallets[].id'

# Agent mode (explicit, even on a TTY)
agentos compute deploy --name my-vps --type cx23 --json

# Agent mode via env var (good for shell scripts that need predictable output)
AGENTOS_JSON=1 agentos status
```

### Streaming commands (`agentos chat run`)

In agent mode, `chat run` emits **NDJSON** — one JSON object per line — so you can `for await` over stdout in a pipeline:

```bash
agentos chat run "deploy a wordpress vps and an inbox" --budget 50 --execute --json \
  | jq -c 'select(.event == "step_result" or .event == "summary")'
```

Event shapes match the SDK's `chatExecute` generator: `plan`, `step_start`, `step_result`, `step_error`, `summary`, etc.

### Errors in agent mode

Errors go to **stderr** as a single-line JSON object so they don't pollute the stdout data stream:

```bash
$ agentos compute deploy --type cx23 --json 2>err.log
$ echo $?
2
$ cat err.log
{"error":"--name and --type required","exitCode":2}
```

---

## Configuration

Config is stored in `~/.agentos/config.json`. Environment variables override file values.

```jsonc
{
  "api": "https://agntos.dev",
  "wallets": {
    "solana": { "keyfile": "/Users/x/.config/solana/id.json" },
    "base":   { "keyfile": "/Users/x/.config/base/id.json"   }
  },
  "defaultChain": "solana",
  "defaultPayWalletId": "11111111-1111-1111-1111-111111111111",
  "defaultPayChain": "solana",
  "vaultEnabled": true,
  "setupDone": true
}
```

### Environment variables

| Variable | Purpose |
|---|---|
| `AGENTOS_API` | Override API endpoint. |
| `AGENTOS_TOKEN`, `AGENTOS_API_KEY` | Bearer token for authenticated routes. |
| `AGENTOS_PAY_WALLET` | Force a specific wallet ID for x402 payment. |
| `AGENTOS_WALLET_PATH` | Override vault directory (default `~/.agentos/wallet`). |
| `AGENTOS_KEYFILE` | Solana keyfile path (legacy single-key flow). |
| `AGENTOS_WALLET_PASSPHRASE` | Optional BIP-39 passphrase for legacy import/export. |

### Chain selection during payment

The payment chain is resolved in this order:

1. The `--chain` flag passed to `wallet use`, persisted as `defaultPayChain`.
2. `AGENTOS_PAY_CHAIN` environment variable.
3. `defaultChain` in config.
4. `solana` as the final default.

If the server doesn't offer the chosen chain for an endpoint, the CLI errors loudly. There is no silent fallback — the assumption is that an agent should know which chain it pays from.

---

## File Layout

```
~/.agentos/
├── config.json              # Resolved config (chains, defaults, vault path)
├── wallet/
│   ├── wallets/             # Encrypted wallet files (AES-256-GCM)
│   ├── keys/                # API key metadata
│   ├── policies/            # Spending policies for managed wallets
│   └── spends/              # Per-day spend ledgers
├── secrets/                 # Windows DPAPI fallback (macOS/Linux use OS keychain)
├── data/                    # Local cache of phones, inboxes, servers, domains
├── logs/                    # Daily logs, pruned after 30 days
├── drafts/                  # Long-form draft storage
└── memory/notes.md          # `agentos note` output
```

Wallet files contain only ciphertext. The decryption key (the session secret) lives in your OS credential store, never on disk in plaintext.

---

## Exit Codes

The CLI uses distinct exit codes so scripts and agents can branch on failure mode.

| Code | Constant | Meaning |
|---|---|---|
| `0` | `OK` | Success. |
| `1` | `GENERAL` | Generic failure (uncategorised). |
| `2` | `BAD_INPUT` | Invalid command, flag, or argument. |
| `3` | `AUTH_FAIL` | 401 from the API or missing token. |
| `4` | `NOT_FOUND` | 404, or a local resource (wallet ID, server ID) that does not exist. |
| `5` | `NETWORK` | DNS, connection refused, or transport failure. |
| `6` | `PAYMENT` | 402 returned by the API or x402 signing rejected. |
| `7` | `SECURITY` | Wallet integrity check failed. The vault has detected tampering or corruption. |

---

## Security Model

- **Keys never leave the machine.** `wallet create` and `wallet import` never transmit seed material to the server. Even managed wallets register only the wallet ID and the derived public addresses with the server.
- **Encryption at rest.** The wallet file is AES-256-GCM with the session secret as the key. The session secret is generated on wallet creation and never stored on disk in plaintext.
- **OS credential store.** Session secrets live in DPAPI (Windows), Keychain (macOS), or `secret-tool` (libsecret on Linux). If none is available the CLI errors rather than falling back to plaintext.
- **Bidirectional vault integrity.** On every load, the CLI checks that every account stored in the wallet file is still derivable from the seed, **and** that every account derivable from the seed is still in the file. Either direction failing returns exit code `7`.
- **Pre-flight validation.** Endpoints that are easy to fail (bad pubkey for an inbox, malformed E.164 for SMS, unsupported destination country) are validated **before** the x402 paywall, so you don't pay for requests that were never going to succeed.
- **No `--no-verify`.** Hooks, signatures, and webhooks are always verified.

---

## Troubleshooting

```bash
agentos doctor
```

`doctor` walks every subsystem (config, vault, credential store, API, default wallet) and prints a pass/fail line per check. Exits non-zero if any check fails — usable in CI.

Common issues:

- **`SECURITY` exit code on any wallet command.** The vault file or its derived accounts have drifted. Restore the wallet file from backup, or re-import from the mnemonic.
- **`Server did not offer <chain> as option`.** Either the endpoint only supports the other chain, or your `defaultPayChain` is misconfigured. Use `agentos wallet use <ID> --chain <other>` and retry.
- **`No session secret found`.** The wallet was created on a different machine, or the OS credential store is unavailable. Re-import the wallet and let the CLI store the secret again.
- **Managed wallet, `REQUIRES_APPROVAL`.** The transaction exceeded a per-tx or daily limit. Run `agentos wallet request-approval <ID>` and forward the URL to the human reviewer.

---

## Links

- API and dashboard — [agntos.dev](https://agntos.dev)
- Source — [github.com/0xArtex/AgentOS](https://github.com/0xArtex/AgentOS)
- Issues — [github.com/0xArtex/AgentOS/issues](https://github.com/0xArtex/AgentOS/issues)
- Skill manifest — [agntos.dev/skill.md](https://agntos.dev/skill.md)

## License

MIT
