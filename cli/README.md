# Palmyr CLI

[![npm](https://img.shields.io/npm/v/@palmyr/cli?style=flat-square&logo=npm&logoColor=white&color=f54900)](https://www.npmjs.com/package/@palmyr/cli)
[![downloads](https://img.shields.io/npm/dm/@palmyr/cli?style=flat-square&color=333)](https://www.npmjs.com/package/@palmyr/cli)
[![license](https://img.shields.io/npm/l/@palmyr/cli?style=flat-square&color=333)](https://github.com/0xArtex/Palmyr/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@palmyr/cli?style=flat-square&color=333)](https://nodejs.org)

The agent-native CLI and SDK for [Palmyr](https://palmyr.ai).

Phone numbers, end-to-end encrypted email, VPS, domains, and non-custodial crypto wallets — accessed over the [x402](https://github.com/coinbase/x402) HTTP payment protocol. Pay per call in USDC on Solana or Base. No accounts, no API keys, no monthly bills.

```
npm i -g @palmyr/cli
palmyr wallet create
palmyr phone search --country US
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
  - [TikTok](#tiktok)
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

`@palmyr/cli` is the official client for the Palmyr API at `palmyr.ai`. Two interfaces ship in one package:

- **`palmyr` CLI** — works in interactive terminals (TUI) and in agent pipelines (raw JSON, auto-detected).
- **SDK** — typed TypeScript/JavaScript class importable as `@palmyr/cli`.

**Identity model.** There are no user accounts. The wallet that signs each `x402` payment becomes the owner of the resource it just paid for (an inbox, a phone number, a VPS). Re-paying from the same wallet proves continued ownership.

**Payment chains.** USDC on Solana (mainnet-beta, SPL) and USDC on Base (EIP-3009, gasless via the Palmyr facilitator).

---

## Install

Global install (recommended):

```bash
npm i -g @palmyr/cli
```

One-off, no install:

```bash
npx @palmyr/cli phone search --country US
```

Requires Node.js 18 or later.

---

## Quick Start

```bash
# 1. Create a wallet (local, no signup, no server round-trip)
palmyr wallet create --name "agent-prod"

# 2. Set it as the default payer and pick a chain
palmyr wallet use <WALLET_ID> --chain solana

# 3. Fund it with a few USDC. Print the address you funded:
palmyr wallet info <WALLET_ID>

# 4. Use a paid endpoint — payment is automatic
palmyr phone buy --country US
```

The wallet file lives in `~/.palmyr/wallet/wallets/<id>.json`, AES-256-GCM encrypted with a session secret stored in your operating system's credential store (DPAPI on Windows, Keychain on macOS, secret-tool on Linux).

---

## Wallets

Palmyr wallets are **standard BIP-39 HD wallets** that derive both:

- a **Solana** address (Ed25519, path `m/44'/501'/0'/0'`)
- a **Base / EVM** address (secp256k1, path `m/44'/60'/0'/0/0`)

from a single 12-word mnemonic. Wallets are created locally; the seed never leaves your machine.

### Two modes

| Mode | Custody | When to use |
|---|---|---|
| **Unmanaged** *(default)* | Agent has full custody. Signs instantly with no human in the loop. | Agents that you fully trust to manage a budget. |
| **Managed** | Agent holds the key for sub-limit signing, but transactions over a per-tx or daily USDC limit require human approval via passkey (FaceID, Touch ID, YubiKey). | Production agents where a human keeps a safety check. |

### Creating a wallet

Wallet creation **requires** a recoverable passphrase fallback (the env var keeps the phrase out of shell history) — or an explicit `--session-only` opt-out for ephemeral wallets you're OK losing on reboot / keyring change / host migration.

```bash
# Recommended — env-var passphrase fallback (durable across reboots and machines)
PALMYR_WALLET_PASSPHRASE="your-passphrase" palmyr wallet create --name agent-prod

# Equivalent — flag form (less safe, ends up in shell history)
palmyr wallet create --name agent-prod --passphrase "your-passphrase"

# Single-chain: skip the other chain's account
PALMYR_WALLET_PASSPHRASE="..." palmyr wallet create --name sol-only --solana
PALMYR_WALLET_PASSPHRASE="..." palmyr wallet create --name base-only --base

# OPT OUT — bound to this machine's OS keychain, NOT recoverable from the JSON file alone
palmyr wallet create --name throwaway --session-only
```

On a TTY without env or flag, the CLI prompts twice with confirmation; non-TTY callers (CI, agents) must provide one of the three knobs above or get a clear error.

By default a wallet derives both Solana and Base/EVM accounts. Pass `--solana` or `--base` (not both) to materialize only one side. The mnemonic always derives both — `--solana` / `--base` controls *which addresses are surfaced and stored*, not which keys exist cryptographically.

### Bulk creation with tags

Group many wallets under one folder-like tag, then cascade-delete them together when done — ideal for spinning up demo, agent-cohort, or test wallets:

```bash
# Create 100 unmanaged wallets sharing one tag (~7s on Windows, batched DPAPI seal)
palmyr wallet create --tag palmyr-demo --count 100

# Custom name prefix; defaults to the tag if omitted → wallets named bot-001..bot-050
palmyr wallet create --tag agents --count 50 --name-prefix bot

# List, retag, untag
palmyr wallet list --tag palmyr-demo
palmyr wallet tag <WALLET_ID> palmyr-demo       # assign / change
palmyr wallet tag <WALLET_ID> --clear           # remove
palmyr wallet tags                              # all tags + counts + chains

# Cascade-delete every wallet under a tag (vault file + OS-credential-store secret)
palmyr wallet tag-delete palmyr-demo --confirm
```

Bulk-create caps at 500 per call. Names auto-suffix `-001..-N` with zero-padding based on count width.

### Importing an existing seed

```bash
palmyr wallet import --mnemonic "twelve word seed phrase ..." --name imported

# Same chain / tag flags as create
palmyr wallet import --mnemonic "..." --name from-backup --tag restored --solana
```

### Durable recovery — passphrase fallback

Wallets created with a passphrase store **two** decryption blobs: one keyed by the OS-keychain session secret (fast, local), one keyed by scrypt(passphrase, salt) (durable). Decryption tries the keychain first, then falls back to `PALMYR_WALLET_PASSPHRASE`. That second blob is what lets the wallet survive a reboot, OS-keychain password change, fresh OS install, or copy to another machine.

Session-only wallets (`--session-only`) **only** have the keychain blob and are NOT recoverable from the JSON file alone. If you have legacy session-only wallets and still have access to the original machine, add a fallback retroactively:

```bash
# At create time — env var preferred (keeps the phrase out of shell history)
PALMYR_WALLET_PASSPHRASE="your-passphrase" palmyr wallet create --name agent-prod

# Migrate an existing wallet — run on the original machine while the OS session secret still works
palmyr wallet rekey <WALLET_ID> --passphrase "your-passphrase"

# Recover on a new machine — copy ~/.palmyr/wallet/wallets/<id>.json over, then:
PALMYR_WALLET_PASSPHRASE="your-passphrase" palmyr wallet info <WALLET_ID>
```

When set, the wallet file gets a second AES-256-GCM blob (`owner_crypto`, scrypt KDF on the passphrase + random salt). Decryption tries the OS session secret first, then falls back to `PALMYR_WALLET_PASSPHRASE` / `--passphrase`. Minimum length 8 chars. Re-running `wallet rekey` rotates — old passphrase stops working.

### Exporting a seed

```bash
palmyr wallet export <WALLET_ID> --confirm
```

The `--confirm` flag is mandatory and is enforced by the CLI. The seed is decrypted in-process and printed once.

---

## Command Reference

Costs in the tables below are paid in **USDC** at request time via x402. Endpoints marked `free` require no payment.

### Phone & SMS

| Command | Cost | Notes |
|---|---|---|
| `palmyr phone search --country US [--limit N]` | free | Search inventory by country (ISO-2). |
| `palmyr phone buy --country US [--area 415]` | $3.00 | Provisions a real number. Local numbers preferred over toll-free. |
| `palmyr phone messages --id <ID>` | $0.02 | Read inbound SMS history. |
| `palmyr phone sms --id <ID> --to +1... --body "..."` | $0.05 | Send SMS. Pre-flight rejects malformed E.164 and unsupported destinations before charging. |
| `palmyr phone delete --id <ID>` | $0.01 | Release the number. |

### Voice Calls

| Command | Cost | Notes |
|---|---|---|
| `palmyr phone call --id <ID> --to +1... [--tts "..."]` | $0.10 | Outbound dial with optional text-to-speech on connect. |

Live-call control endpoints (speak, play, dtmf, gather, record, hangup, transfer) are exposed through the SDK and the REST API. See [palmyr.ai/docs](https://palmyr.ai) for the full call-control surface.

### Email

End-to-end encrypted inboxes at `<name>@palmyr.ai`. Messages are encrypted at rest with the inbox's wallet public key (NaCl `box`, X25519 + XSalsa20-Poly1305) so the server cannot read them.

| Command | Cost | Notes |
|---|---|---|
| `palmyr email create --name agent --wallet <SOL_PUBKEY>` | $2.00 | Wallet must be a base58 Solana pubkey (32 bytes). EVM addresses are rejected before payment. |
| `palmyr email read --id <INBOX_ID>` | $0.02 | Wallet that paid must own the inbox. |
| `palmyr email send --id <ID> --to a@b.com --subject "Hi" --body "..."` | $0.08 | |
| `palmyr email threads --id <INBOX_ID>` | $0.02 | List conversation threads. |

### Compute

VPS instances on Hetzner-class hardware. Plans are listed live; the `cx23` plan is a 4 vCPU / 8 GB / 80 GB SSD baseline.

#### Golden path

The bare command is a one-liner: it auto-generates an ed25519 keypair, deploys, blocks until the server is reachable, verifies SSH actually works, and returns a usable shell command in the JSON response.

```bash
palmyr compute deploy --type cx23 --json
```

That single call:
1. Generates `~/.palmyr/ssh/<server-name>/id_ed25519{,.pub}` (chmod 600).
2. Inlines the public key into Hetzner's cloud-init so it's in `authorized_keys` at first boot.
3. Pays the $6 deploy fee via x402 (Solana or Base USDC).
4. Polls until Hetzner reports `status=running` (gate 1).
5. TCP-probes port 22 until sshd accepts (gate 2).
6. Runs `ssh -i <key> root@<ip> 'true'` to confirm authentication (gate 3).
7. Returns JSON with a top-level `sshCommand` and a `readiness` block.

Drop into the new VPS:

```bash
palmyr compute ssh <name>
```

Names resolve from a local cache populated by `compute deploy`; `compute ssh` looks up the IP and path to the matching private key without a paid API round-trip.

#### Bootstrap an agent runtime (`--install`)

Pass `--install <recipe>` to bake an AI-agent runtime into the deploy. Cloud-init runs the recipe before SSH gets handed back to you, and the readiness chain gains a fourth gate that polls `/etc/palmyr/install-status.json` until every requested recipe reports `status: ok`.

```bash
# Deploy with Hermes Agent (Nous Research) bootstrapped at first boot
palmyr compute deploy --type cx23 --install hermes --json

# Multiple recipes — runs in order
palmyr compute deploy --type cx23 --install hermes,openclaw --json

# Discover what's installable
palmyr compute install-recipes --json

# Vanilla Ubuntu — no runtime, password auth stays enabled
palmyr compute deploy --type cx23 --no-install --json
```

| Recipe | What lands on the box |
|---|---|
| `openclaw` *(default when `--install` is omitted)* | Node 22 + `openclaw` and `clawhub` global npm packages. Provisioning marker at `/etc/openclaw/provision.json`. |
| `hermes` | [Hermes Agent](https://github.com/NousResearch/hermes-agent) — Nous Research's self-improving AI agent. Installed via the official `scripts/install.sh --skip-setup`, lands at `/usr/local/bin/hermes`. Pulls Python 3.11 + a few hundred MB of pip packages — adds 2–4 minutes to the deploy. After the deploy, run `palmyr compute exec <name> -- hermes setup` (or SSH in and run `hermes setup`) to pick a model provider. |

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
      "palmyrLogTail": "...last 80 lines of /var/log/palmyr/cloud-init.log...",
      "recipeLogs": [{ "name": "hermes", "tail": "...last 80 lines..." }]
    }
  }
}
```

The wait fast-fails when `cloud-init status` reports `error` instead of waiting the full timeout. Re-run the chain against the same server with:

```bash
palmyr compute wait my-vps --install hermes --json
```

Cloud-init logs also live on the box if you want to look directly:

```bash
palmyr compute exec my-vps -- tail -200 /var/log/cloud-init-output.log
palmyr compute exec my-vps -- tail -200 /var/log/palmyr/hermes-install.log
```

#### Streaming progress

In agent mode, `compute deploy --wait` and `compute wait` emit one NDJSON event per gate transition to **stderr** — by default. Stdout still gets one final JSON object so `jq` pipelines aren't disturbed; stderr is the live event stream you can `tail -f` while a long install runs.

```bash
palmyr compute deploy --type cx23 --install hermes --json
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
palmyr compute deploy --type cx23 --install hermes --json --no-progress
```

Capture stderr for later analysis (POSIX shell redirection, not a CLI flag):

```bash
palmyr compute deploy --type cx23 --install hermes --json 2>progress.ndjson
```

#### SSH-key management

| Command | Cost | Notes |
|---|---|---|
| `palmyr compute ssh-key add <pubkey-file> [--name "label"]` | $0.10 | Upload an SSH public key to Hetzner. Returns numeric `id` you can pass to `--ssh-key`. Reusable across deploys. |
| `palmyr compute ssh-key list` | $0.01 | List uploaded keys with fingerprints. |
| `palmyr compute ssh-key delete <id>` | $0.01 | Remove a key from Hetzner. Existing servers keep the key in `authorized_keys`. |

#### Deploy

| Command | Cost | Notes |
|---|---|---|
| `palmyr compute plans [--location fsn1]` | free | List server types and monthly pricing. With `--location`, filters to types deployable in that datacenter. Each row carries an `availableLocations[]` array so you can see where each type runs. |
| `palmyr compute locations` | free | List Hetzner datacenters (fsn1 / nbg1 / hel1 / ash / hil / sin) with city, country, network zone, and the live deployable server-type list per location. |
| `palmyr compute install-recipes` | free | List recipes you can pass to `--install`. |
| `palmyr compute deploy [--type cx23] [--name N]` | $6.00 | Golden path (auto-key, auto-wait, verified). Deployment fee; monthly server cost is metered separately. |
| `palmyr compute deploy --install hermes` | $6.00 | Bootstrap an agent runtime (Hermes Agent, OpenClaw) via cloud-init; deploy waits until `/etc/palmyr/install-status.json` reports `ok`. |
| `palmyr compute deploy --install hermes,openclaw` | $6.00 | Multiple recipes, run in order. |
| `palmyr compute deploy --location fsn1` | $6.00 | Pick a Hetzner datacenter explicitly. Server pre-validates type+location compatibility before x402 settles, so `cax11 + ash` fails as 400 with `Try one of: fsn1` instead of 422 after payment. |
| `palmyr compute deploy --no-install` | $6.00 | Skip cloud-init entirely → vanilla Ubuntu, password auth stays enabled, returned `rootPassword` works. |
| `palmyr compute deploy --ssh-key <id>` | $6.00 | Use a pre-uploaded Hetzner key (numeric ID from `ssh-key list`). Preferred for repeatable deploys. |
| `palmyr compute deploy --pubkey-file ~/.ssh/id_ed25519.pub` | $6.00 | Inline an existing key without uploading to Hetzner first. |
| `palmyr compute deploy --pubkey "ssh-ed25519 AAAA..."` | $6.00 | Same, raw key string instead of a file. |
| `palmyr compute deploy --no-generate-ssh-key` | $6.00 | Opt out of auto-generation. Server boots with the platform's temp key only — call `setup-ssh` later or you can't get in. |
| `palmyr compute deploy --no-wait` | $6.00 | Fire-and-forget. Returns as soon as Hetzner accepts the create call. |
| `palmyr compute deploy --wait-timeout 300` | $6.00 | Override the default 240s readiness budget (600s when `--install` is set). Clamped 30–900. |

**Server name rules.** Server names are lowercase RFC 1123 hostnames: 1–253 chars of `[a-z0-9.-]`, starting and ending alphanumeric, no uppercase, no underscores. The CLI validates client-side and the server validates pre-payment, so `--name Hermesbot` fails as 400 with no USDC charged.

The four key sources (`--ssh-key <id>`, `--pubkey-file`, `--pubkey`, `--generate-ssh-key`) are mutually exclusive — passing more than one returns exit 2 with a clear error.

#### Wait + SSH

| Command | Cost | Notes |
|---|---|---|
| `palmyr compute wait <name|id> [--key <path>] [--wait-timeout <sec>]` | $0.01 | Run the readiness chain against an existing server. Useful when the original deploy ran without `--wait` or its wait timed out. Exits `4` (NOT_FOUND) when not ready, `0` when all gates pass. Stdout always carries the full readiness JSON. |
| `palmyr compute ssh <name|id>` | free | Drop into the server (TTY mode) or print the equivalent `ssh -i <key> root@<ip>` command (agent mode). Resolves from local cache; no paid API call. |
| `palmyr compute setup-ssh <id> --pubkey-file ~/.ssh/id.pub` | $0.01 | Inject your public key into a server you didn't supply a key for at deploy time. Locks the root password and removes the platform's temporary key — after this, only your key works. |

#### Lifecycle + actions

Each takes `<name|id>` from the local cache (or a numeric Hetzner id directly).

| Command | Cost | Notes |
|---|---|---|
| `palmyr compute reboot <name|id>` | $0.10 | Graceful restart. |
| `palmyr compute poweroff <name|id>` | $0.10 | Graceful shutdown — data preserved. |
| `palmyr compute poweron <name|id>` | $0.10 | Power on a stopped server. |
| `palmyr compute reset <name|id>` | $0.10 | Hard restart, no graceful shutdown. |
| `palmyr compute rebuild <name|id> [--image ubuntu-24.04]` | $0.10 | Reinstall OS — wipes disk, re-runs cloud-init, keeps IP. |
| `palmyr compute rename <name|id> <new-name>` | $0.01 | Rename a deployed VPS (metadata-only; no reboot). Updates the local cache so `compute ssh <new-name>` works immediately after. New name validated client-side and pre-payment server-side. |
| `palmyr compute reset-password <name|id>` | $0.10 | Rotate the root password (Hetzner-side). On Palmyr-deployed boxes, password auth is disabled by cloud-init — the new password is for console use or after manually re-enabling password auth. Use `setup-ssh` for SSH access. |
| `palmyr compute console <name|id>` | $0.10 | Get a noVNC console URL (`wssUrl` + `password`, expires ~1 minute). Break-glass when SSH is unreachable (cloud-init failed, sshd misconfigured). |
| `palmyr compute exec <name|id> -- <command> [args...]` | $0.05 | Run a single command pre-handoff via the platform's temporary SSH key. Returns `{stdout, stderr, exitCode, durationMs}`. Returns `410 Gone` once `setup-ssh` has run (the platform key is removed at handoff). 30s default timeout. |
| `palmyr compute list` | $0.01 | List your servers. |
| `palmyr compute delete <name|id>` | $0.10 | Terminate and stop billing. |

The `--` separator (POSIX convention) tells the parser everything after it is for the remote shell, not local CLI flags. Useful when the remote command takes its own dash-prefixed args:

```bash
palmyr compute exec my-vps -- systemctl status --no-pager openclaw
palmyr compute exec my-vps -- bash -c 'cloud-init clean && cloud-init init --all'
```

### Domains

| Command | Cost | Notes |
|---|---|---|
| `palmyr domain check --name example.dev` | free | Availability check. |
| `palmyr domain pricing --name example.dev` | free | TLD pricing. |
| `palmyr domain buy --name example.dev` | $20.00 | One-year registration. Renewals are charged annually. |
| `palmyr domain list` | $0.01 *(ownership proof)* | List domains your wallet owns plus any shared with you. Each row tagged `access: owner | shared`. |
| `palmyr domain dns --name example.dev` | $0.01 *(ownership proof)* | View DNS records. Owners and shared wallets allowed. |
| `palmyr domain transfer-ownership --name example.dev --to <wallet>` | $0.01 *(ownership proof)* | Hand the domain to another wallet. Clears `shared_with` — the prior owner's collaborators don't travel with the domain. |
| `palmyr domain share --name example.dev --with <wallet>` | $0.01 *(ownership proof)* | Grant another wallet shared access (visible in `domain list`, can edit DNS). Owner-only. |
| `palmyr domain unshare --name example.dev --from <wallet>` | $0.01 *(ownership proof)* | Revoke a shared wallet's access. Owner-only. |

### Wallet

All wallet operations except `addresses`, `api-key`, `config`, and `request-approval` run **locally** with zero server contact.

| Command | Network | Notes |
|---|---|---|
| `palmyr wallet create [--name N] [--solana\|--base] [--tag T] [--count N] [--name-prefix P] (--passphrase P \| PALMYR_WALLET_PASSPHRASE env \| --session-only)` | local | New wallet. **Requires** either a passphrase (recoverable across reboot / OS-keychain loss / host migration) or explicit `--session-only` opt-out. On TTY without env/flag, prompts twice. Stores keychain secret + (with passphrase) a scrypt-sealed `owner_crypto` blob. `--count > 1` bulk-creates N wallets under a required `--tag` (max 500/call, batched DPAPI seal on Windows). |
| `palmyr wallet import --mnemonic "..." [--name N] [--solana\|--base] [--tag T] (--passphrase P \| PALMYR_WALLET_PASSPHRASE env \| --session-only)` | local | Restore from BIP-39. Same passphrase rules as `create` — re-importing on a new machine to recover from keychain loss should always set a passphrase so you don't get trapped again. |
| `palmyr wallet rekey <ID> --passphrase P` | local | Add (or rotate) the scrypt passphrase fallback on an existing wallet. Wallet must be decryptable right now (session secret still works, or `--current-passphrase` provided). Run on the original machine, then `PALMYR_WALLET_PASSPHRASE` decrypts the wallet anywhere. |
| `palmyr wallet list [--tag T]` | local | Lists wallets in the local vault. `--tag` filters to one folder. |
| `palmyr wallet info <ID>` | local | Show one wallet (id, name, addresses, mode, tag). |
| `palmyr wallet tags` | local | List all tags with wallet count, chains, and date range. |
| `palmyr wallet tag <ID> <TAG>` / `palmyr wallet tag <ID> --clear` | local | Assign, change, or clear a wallet's tag. |
| `palmyr wallet tag-delete <TAG> --confirm` | local | Cascade-delete every wallet under the tag (vault file + OS-credential-store secret). Requires explicit `--confirm`. |
| `palmyr wallet addresses <ID>` | API | Server-side derived addresses (multi-chain). |
| `palmyr wallet sign-message <ID> --chain solana\|evm --msg "..."` | local | Sign an arbitrary message offline. |
| `palmyr wallet api-key <ID> [--name N]` | API | Mint an agent API key bound to the wallet. |
| `palmyr wallet config <ID>` | API | Pull the agent's runtime config. |
| `palmyr wallet use <ID> [--chain solana\|base]` | local | Set default payer and payment chain. |
| `palmyr wallet export <ID> --confirm` | local | Print mnemonic. Requires explicit `--confirm`. |

**Trading.** Thesis-tracked positions on Solana + Base persist at `~/.palmyr/trading/` (overridable via `PALMYR_TRADING_PATH`). Swaps route through Jupiter v6 on Solana and ParaSwap on Base. Positions, sells, journal, and watchlist live as JSON / JSONL.

**Any wallet you create with `palmyr wallet create` can trade.** Vault wallets are BIP39 mnemonics with both Solana (`m/44'/501'`) and EVM (`m/44'/60'/0'/0/0`) derivations out of the box — pass `--wallet <name|id>` to any trading command. The session secret cached in your OS keychain (from `wallet create` / `wallet import`) makes the daemon and one-off commands work without re-prompting. The optional `trading-keystore` is still available for power users who want one mnemonic that HD-derives many trading wallets at consecutive indices — see "Trading keystore" below.

**Fund trades with native asset or USDC.** The `--amount` suffix picks the input asset: `0.5sol` and `0.01eth` spend native, `10usdc` spends USDC (same `EPjFW…Dt1v` on Solana and `0x8335…2913` on Base). Sells exit back to whatever the position was entered in (exit symmetry — buy with USDC, sell back to USDC). PnL is tracked per-asset: a USDC-funded position's realized/unrealized are USDC, not SOL. `palmyr wallet pnl` shows separate SOL / ETH / USDC buckets and a cross-asset USD total (Jupiter SOL/USD + Coinbase ETH/USD + USDC@1.00).

**MEV protection (Phase 2).** Pass `--protected` on `buy` / `sell` to route through Jito Block Engine with a tip (default 10000 lamports, override via `--tip <lamports>`). Automatically switches to dynamic slippage from DexScreener 5m volatility (`3× vol`, clamped to [0.5%, 15%]) unless `--slippage <bps>` is explicit. Realized PnL is fee-and-tip-aware. Each fill gets a post-trade forensics flag (`ok` / `suspect-mev`) based on how much of the slippage budget the realized fill consumed.

| Command | Network | Notes |
|---|---|---|
| `palmyr wallet buy solana <CA> --amount 0.5sol --thesis "..."` | RPC + Jupiter | Open a position with a plain-string thesis. Optional `--cut`, `--tp`, `--trail <pct>`, `--time-limit <dur>`, `--hold-if`, `--wallet <id\|name>`, `--slippage <bps>`, `--auto-slippage`, `--protected`, `--tip <lamports>`, `--dry-run`. |
| `palmyr wallet sell solana <CA> --percent 50 --reason "..."` | RPC + Jupiter | Sell N% of remaining tokens. FIFO realized PnL (post-fee, post-tip). Auto-closes the position when fully exited. Same `--protected` / `--auto-slippage` / `--tip` flags as `buy`. |
| `palmyr wallet positions [--chain X] [--wallet Y] [--all]` | local | List positions. `--all` includes closed. |
| `palmyr wallet position <CA>` | local | Full detail view: thesis verbatim, exit plan, sells, PnL. |
| `palmyr wallet sync [--wallet Y]` | RPC + Jupiter | Reconcile on-chain balances against book; refresh unrealized PnL. Read-only — flags drift, never auto-corrects. |
| `palmyr wallet pnl [--by wallet\|chain] [--since DATE]` | local | Aggregate realized + unrealized across positions. |
| `palmyr wallet journal add <CA> --note "..."` | local | Append a note (omit CA for general). |
| `palmyr wallet journal show [--ca <CA>] [--date YYYY-MM-DD]` | local | List entries or read a day's full markdown. |
| `palmyr wallet watch add <CA> --trigger "..."` | local | Append a watch entry to the watchlist. |
| `palmyr wallet watch list` | local | Show the watchlist. |
| `palmyr wallet brief <CA> [--evaluate]` | local *(plus Anthropic API when `--evaluate`)* | Position brief: thesis + PnL + last sync time. With `--evaluate`, asks Claude Haiku whether the thesis still holds (requires `ANTHROPIC_API_KEY`). |

**Auto-monitor daemon (Phase 3 / 3.5 / 7).** Long-running background process (or one-shot `tick`) that periodically syncs all open positions and evaluates five trigger types from `exitPlan`: `cut` (stop-loss), `takeProfit` (target), `trailingStop` (drop from peak in pct points; armed only after position has been in profit), `timeLimit` (sell after N hours/days regardless of PnL), and `thesisCheck` (Phase 7 — periodic LLM thesis-health check via `evaluateBriefWithLLM`; fires `thesis_falsified` when the LLM returns `thesis_holds: "no"`, rate-limited to one fire per new verdict). The daemon maintains per-position `monitorState` (peak watermark, last LLM check + verdict + fire timestamps). Fires append to `~/.palmyr/trading/triggers/pending.jsonl` and to `trades.jsonl` (kind `monitor_fire`). With `--auto`, the daemon sells 100% on each fire and links the resulting tx back to the fire record. The `thesis_falsified` trigger needs `ANTHROPIC_API_KEY`; failures are non-fatal (logged to `daemon.log` and skipped).

| Command | Network | Notes |
|---|---|---|
| `palmyr wallet daemon tick [--auto]` | RPC + Jupiter | One-shot: sync + evaluate triggers + exit. Useful for cron-driven setups. |
| `palmyr wallet daemon start [--interval N] [--auto] [--wallet <id\|name>]` | local | Spawn detached daemon. Default interval 30s. PID lives at `~/.palmyr/trading/daemon/daemon.pid`. |
| `palmyr wallet daemon stop` | local | SIGTERM the running daemon, clean up PID + status files. |
| `palmyr wallet daemon status` | local | Liveness check + last tick timestamp + current opts. |
| `palmyr wallet triggers [--ca <CA>] [--since <iso>] [--clear]` | local | List pending trigger fires; `--clear` truncates `pending.jsonl` after listing. |

**Trading keystore — optional power-user setup.** Most users never need this: a regular `palmyr wallet create` wallet already trades on both chains. The trading keystore is a separate seed that HD-derives many wallets at consecutive indices from one mnemonic — useful when you want to run cohort buys across 10+ wallets and back them up with a single 24-word phrase. Stored at `~/.palmyr/trading/keystore.json`, encrypted with scrypt (N=131072, r=8, p=1) + AES-256-GCM. Derives Solana at `m/44'/501'/<index>'/0'` and EVM at `m/44'/60'/<index>'/0/0`. Pass `--wallet trading:N` to route through the Nth derived wallet.

| Command | Network | Notes |
|---|---|---|
| `palmyr wallet trading-keystore init [--count N] [--mnemonic "..."]` | local | Create the keystore. Default `--count 5`. Pass `--mnemonic` to import an existing seed; otherwise a fresh 24-word mnemonic is generated. Passphrase via env or interactive prompt. Auto-caches the seed in OS keychain on success. |
| `palmyr wallet trading-keystore unlock` | local | Prompt for passphrase (or use env), decrypt seed, cache it in OS keychain. Required before the daemon or any non-env CLI call can use `--wallet trading:N`. |
| `palmyr wallet trading-keystore lock` | local | Clear the cached seed from OS keychain. |
| `palmyr wallet trading-keystore list` | local | List `[index]` → derived address. No unlock needed. |
| `palmyr wallet trading-keystore status` | local | Show exists / path / wallet count / locked vs unlocked. |
| `palmyr wallet trading-keystore derive --count N` | local | Append N more HD-derived wallets. Uses cached seed if unlocked. |
| `palmyr wallet trading-keystore export --confirm` | local | Print the mnemonic. Always requires the passphrase (never falls back to cache); `--confirm` guard prevents accidental exposure. |

Auth fallback for `--wallet trading:N` and the daemon: explicit `passphrase` arg → `PALMYR_TRADING_KEYSTORE_PASSPHRASE` env var → cached seed in OS keychain. Once unlocked, the daemon and subsequent CLI commands work without re-entering the passphrase.

**Base / EVM.** Any vault wallet (`palmyr wallet create`) trades on Base via its EVM derivation; the optional trading-keystore works too. ParaSwap free aggregator handles routing — no API key needed. Position files for Base live at `~/.palmyr/trading/positions/<wallet-addr>/base/<token-address>.json` with a chain-specific shape (`amountInRawWei: string` for u256 safety, vs Solana's `amountInRawSol: number`). The `PositionFile` TypeScript type is a discriminated union of `SolanaPositionFile | BasePositionFile`.

| Command | Network | Notes |
|---|---|---|
| `palmyr wallet evm-quote <SRC> <DST> --amount <raw> [--chain base]` | ParaSwap | Get a swap quote without signing. `<SRC>`/`<DST>` accept `eth` for native or a `0x...` address. `--amount` is the raw integer in src smallest unit. |
| `palmyr wallet buy base <0xToken> --amount 0.01eth --thesis "..." --wallet <vault-name>` | ParaSwap + Base RPC | Open a Base position. Amount accepts `Neth` / `Ngwei` / `Nwei`. `--wallet` accepts any vault wallet (by name or id) or `trading:N`. Standard exit-plan flags (`--cut`, `--tp`, `--trail`, `--time-limit`, `--thesis-check`) all work. |

**Phase 5c additions:**

| Command | Network | Notes |
|---|---|---|
| `palmyr wallet sell base <0xToken> --percent N --reason "..." --wallet <vault-name>` | ParaSwap + Base RPC | Sell N% of remaining tokens. **Auto-handles ERC20 approval** (sends max approval to the ParaSwap router on first sell of a given token; subsequent sells skip the approval step). FIFO realized PnL in ETH = (gross proceeds - sell gas) - proportional (entry cost + entry gas). Auto-closes when 100% sold. The CLI output shows the approval tx hash separately from the swap tx hash when an approval was issued. |
| `palmyr wallet sync --chain base --wallet <vault-name>` | Base RPC + ParaSwap | Reconcile open Base positions: ERC20 balance vs book, refresh unrealized ETH via ParaSwap quote token→ETH at 50bps. Read-only — flags drift, never auto-corrects. |

**Phase 5d additions — protected Base, daemon on both chains, cross-chain PnL:**

| Command | Network | Notes |
|---|---|---|
| `palmyr wallet buy base <0xToken> --protected [--rpc <url>] [--tip <gwei>]` | ParaSwap + protected RPC | MEV-protected Base buy: routes through `PALMYR_BASE_PROTECTED_RPC` (env var, no public default) and sends an EIP-1559 tx with `maxPriorityFeePerGas` bumped (default 0.001 gwei tip). Falls back to the public Base RPC if the env var isn't set. `--rpc` overrides everything; `--tip <gwei>` overrides the priority fee. Stored as `protectedExec: true` on the position record. |
| `palmyr wallet sell base ... --protected [--rpc <url>] [--tip <gwei>]` | ParaSwap + protected RPC | Same flags work for sell — protected execution, custom RPC, custom tip. |
| `palmyr wallet daemon tick \| start --wallet <vault-name>` | Solana RPC + Base RPC | Daemon syncs **both chains per tick**: Solana via Jupiter, Base via ParaSwap quote. Trigger types (cut/takeProfit/trailingStop/timeLimit/thesis_falsified) all work on Base positions. With `--auto`, auto-execute calls `sellBase` for Base fires. Base sync errors are non-fatal (logged + reported in `tick.errors[]`). Base sync runs whenever any wallet ref is set (vault or trading:N) since both have EVM derivation. |
| `palmyr wallet pnl [--by chain\|wallet] [--no-usd]` | Jupiter price v3 + Coinbase spot | **Cross-chain PnL.** Per-chain breakdown in native units (SOL for Solana, ETH for Base) + a USD total computed from live SOL/USD (Jupiter) and ETH/USD (Coinbase) prices. `--by chain` groups by chain in native units; `--by wallet` groups by wallet address (Solana base58 wallets are distinct from EVM 0x wallets). `--no-usd` skips the price-API calls. Falls back gracefully if any price lookup fails. |
| `palmyr wallet positions [--chain base\|solana]` | local | Lists positions across both chains by default. CHAIN column shows which chain each position belongs to. |
| `palmyr wallet position <CA> [--chain base\|solana]` | local | Auto-detects chain when `--chain` is omitted (tries Solana first, then Base). Displays native unit (SOL or ETH) in the PnL section. |

**Phase 4c additions — cohort strategies, per-wallet position scoping, cache TTL:**

| Command | Notes |
|---|---|
| `palmyr wallet cohort buy <CHAIN> <CA> --total <amt> --wallets trading:0,trading:1,...` | Split a single trade decision across N derived wallets. Each leg becomes its own position file under that wallet's directory. Sequential by design (parallel risks pool-impact penalties on the second-into-the-block leg); `--jitter <ms>` adds a random delay between legs sampled from `[0, jitterMs]`. Partial-success report: successes and failures are captured per-leg, never rolled back. Each position carries a shared `cohortId` field. All `buy` flags (`--protected`, `--tip`, `--rpc`, `--slippage`, `--cut`, `--tp`, `--trail`, etc.) pass through. |
| `palmyr wallet cohort buy <CHAIN> <CA> --total <amt> --wallets alice,bob,carol` | Cohort across vault wallets. Each leg uses one wallet — list them by name/id. Per-leg failure isolation; all share a generated `cohortId`. |
| `palmyr wallet cohort buy <CHAIN> <CA> --total <amt> --from trading:N --split K` | Power-user form: derive `K` consecutive trading-keystore wallets starting at index `N`. EVM derivations are on-the-fly (any non-negative index works); Solana indices must be pre-derived via `trading-keystore init/derive`. |
| **Per-wallet position scoping** | Position files moved from `positions/<chain>/<mint>.json` to `positions/<wallet-addr>/<chain>/<mint>.json`. EVM wallet directory names are lowercased (Windows case-insensitive FS protection). Legacy positions migrate lazily on the next `ensureTradingDirs()` call (idempotent — first invocation moves them, subsequent calls scan-and-skip). `readPosition(chain, mint, walletAddr)` is O(1); the no-wallet form (used by `wallet position <CA>` and `brief`) scans the tree. |
| **Duplicate-position check is per-wallet** | Different cohort wallets can each open simultaneous positions in the same token. The "Position already open" error now mentions the specific wallet address. |
| `palmyr wallet positions` shows a `WALLET` column | New column makes cohort positions visually distinct in the table. |
| `palmyr wallet trading-keystore unlock [--ttl <dur>]` | **Hard TTL on the OS-keychain seed cache.** Default 24h. `--ttl 30m / --ttl 4h / --ttl 7d` for shorter/longer sessions. After expiry, the first command that touches the keystore auto-wipes the keychain entry. `trading-keystore status` shows the `expiresAt` ISO timestamp and an `expired` flag distinct from `never unlocked`. Phase 4b caches without a meta file are adopted with the default TTL on first read (back-compat). |

**YAML strategy templates:**

| Command | Notes |
|---|---|
| `palmyr wallet template list` | Lists installed templates; auto-installs 3 bundled examples (`sol-pumpfun-quick`, `sol-scout-cohort`, `base-eth-swing`) on first call. Stored at `~/.palmyr/trading/templates/<name>.yml`. |
| `palmyr wallet template show <name>` | Prints metadata + raw YAML body. |
| `palmyr wallet template path <name>` | Prints absolute path — `$(palmyr wallet template path X) | xargs -o $EDITOR` to edit. |
| `palmyr wallet template delete <name>` | Removes the file (idempotent — no-op if missing). |
| `palmyr wallet buy <chain> <CA> --template <name> --thesis "..."` | Loads template's defaults for `amount` / `exitPlan` (cut, tp, trail, time-limit, thesis-check) / slippage / `protectedExec` / `riskFlags`. **CLI flags win on conflict.** Each layer is opt-in: template can supply just an exit plan, or be a complete trade-plan with amount. |
| `palmyr wallet cohort buy [<CHAIN> <CA>] --template <name> --thesis "..."` | Template can also supply `cohort.split` / `cohort.from` / `cohort.jitterMs` so a single template captures a complete cohort strategy. `chain` / `total` / wallet list all default from the template; CLI flags override. The thesis and the CA are always required at trade time — templates are about HOW, the thesis + CA are WHY + WHAT. |

Schema is strictly validated — unknown keys are rejected at load time to surface typos like `cutt: -25%`. The validator catches `chain != 'solana'|'base'`, malformed `slippageBps`, non-array `riskFlags`, and any unknown top-level / `exitPlan` / `cohort` keys. Cohort wallet resolution priority for `cohort buy --template ...`: `--wallets` > `--from + --split` > template's `cohort.split` > error.

**Still deferred to future phases:** `event_based` triggers (LP pull / dev dump / tweet delete via external feeds). Post-entry `exitPlan` editing. Funding orchestration (Phase 6 — needs threat-model conversation first). Chain scope is final at Solana + Base.

### Twitter / X

Buy, manage, and operate X accounts directly from the CLI. Each account is pinned to a sticky residential IP for its lifetime — login, posting, and every subsequent action route through the same exit IP, so X never sees a sudden geography change.

Local credentials are encrypted with AES-256-GCM (per-account session secret in your OS credential store). Cookies are cached for 12 hours after login; commands that need a session call `twitter login` automatically when stale.

| Command | Cost | Notes |
|---|---|---|
| `palmyr twitter buy` | $5.00 | Pay $5 USDC, receive a ready X account from the pool. Auto-imports into the local vault and primes the session — you can post immediately. |
| `palmyr twitter import <username> --credentials-line "login:pw:email:email_pw:2fa:ct0:auth_token"` | free | Bring your own account. Accepts the standard 4 / 5 / 7-field colon format common in marketplace exports. |
| `palmyr twitter import <username> --login E --password P [--email-password X] [--totp-seed S] [--auth-token T --ct0 C]` | free | Same, with explicit flags. |
| `palmyr twitter list [--local]` | $0.0011 *(ownership proof on `/x/accounts/mine` + `/social/twitter/registered/mine`)* — `--local` skips the server check for free | Local vault PLUS server-side accounts the wallet owns or has been shared with. Server-only accounts appear with a `server-only — run 'palmyr twitter claim' to import` hint. Default behavior queries the server so a wallet that just received a transfer sees the account without an extra `claim` step. |
| `palmyr twitter info <username>` | free | Show one account (id, addresses, last action, source). |
| `palmyr twitter rename <old> --to <new>` | free | Rename the local handle (does not change the X handle — use `twitter username` for that). |
| `palmyr twitter remove <username> --confirm` | free | Delete the local copy. The X account itself is not deleted. |
| `palmyr twitter totp <username>` | free | Print the current 2FA code derived from the stored seed. |
| `palmyr twitter login <username>` | $0.005 | Open a Playwright stealth session, log in through the account's residential IP, cache cookies for 12h. |
| `palmyr twitter session <username>` | free | Show whether a session is cached, age in hours, and staleness. |
| `palmyr twitter post <username> --body "..."` | $0.001 | Post a text-only tweet. Returns `tweet_id` after server-side verification. |
| `palmyr twitter post <username> --body "..." --image path[,path,path,path]` *(or `--video path.mp4`, or `--media-json '[...]'`)* | $0.005 | Post with attached media: 1-4 images OR 1 video (X allows one or the other, never both). Local files are base64-encoded; use `--media-json` to pass `image_url`/`video_url` for server-side fetch. |
| `palmyr twitter thread <username> --texts '[...]'` *(or `--file thread.json`)* | $0.005 | Post a 2-25 tweet native X thread in one composed session. JSON array of strings, each ≤280 chars. Returns `tweet_ids[]` and `tweet_urls[]`. |
| Add `--community <id>` to any of the above | same | Scope the post / thread / media-post to an X community. `<id>` is the numeric community ID (15-30 digits) — find it in the URL when viewing the community on x.com. Account must be a member. |
| `palmyr twitter reply <username> --to <tweet-url> --body "..."` | $0.001 | Reply to a tweet. |
| `palmyr twitter like <username> --tweet <url>` | $0.001 | |
| `palmyr twitter retweet <username> --tweet <url>` | $0.001 | |
| `palmyr twitter follow <username> --user @handle` | $0.001 | |
| `palmyr twitter unfollow <username> --user @handle` | $0.001 | Handles both confirm-modal and instant-unfollow paths. Returns a clear error if X blocks unfollow on a monetised account. |
| `palmyr twitter delete <username> --tweet <url>` | $0.001 | |
| `palmyr twitter bio <username> --text "..."` | $0.001 | Pass `--text ""` to clear. |
| `palmyr twitter name <username> --display "..."` | $0.001 | |
| `palmyr twitter location <username> --text "..."` | $0.001 | |
| `palmyr twitter website <username> --url https://...` | $0.001 | |
| `palmyr twitter pfp <username> --file path.png` *(or `--url https://...`)* | $0.005 | PNG / JPG / WebP / GIF. Local file is base64-encoded; URL is fetched server-side with SSRF guard. |
| `palmyr twitter banner <username> --file path.png` *(or `--url ...`)* | $0.005 | |
| `palmyr twitter username <username> --to <new-handle>` | $0.005 | Pre-flight validates handle (4–15 chars, `[A-Za-z0-9_]`) before payment. May trigger X's password re-auth modal — handled automatically. |
| `palmyr twitter transfer <username> --to <wallet> --confirm` | $0.0001 ownership proof + $0.0011 lookup; **adds $0.01 if auto-register runs**; **plus ~$0.001 in poll fees** ($0.0001 × ~10 polls) | Atomically hand the X account to another wallet. End-to-end one-command: looks up the account in both server tables (`x_accounts` + `social_registered_accounts`), auto-registers if only in local vault, then kicks off an async rotation job. Server returns `{ transfer_id }` immediately and the CLI polls `/transfers/:id` every 5s until `completed` or `failed` (rotation takes 30-90s in the background — async so it survives Cloudflare's HTTP timeout). Password is rotated and other sessions revoked before ownership flips, so the local copy of credentials becomes useless. Requires `--confirm`. Local vault entry is removed on success — receiver picks up fresh creds with `palmyr twitter list` (which shows server-only accounts) and/or `palmyr twitter claim`. |
| `palmyr twitter share <username> --with <wallet>` | $0.01 *(ownership proof)* | Grant another wallet shared access — same login, no credential rotation. Both wallets see the account via `palmyr twitter claim`. Owner-only. Same pool / registered dispatch as transfer. |
| `palmyr twitter unshare <username> --from <wallet> [--rotate]` | $0.0001 ownership proof + $0.0011 lookup; **with `--rotate`: kicks off async rotation, ~$0.001 in poll fees plus another lookup to sync local vault** | Revoke a wallet's shared access. Without `--rotate`, the wallet is removed from `shared_with` immediately but their previously exported cookies / password remain valid until X-side expiry. With `--rotate`, the unshare is immediate AND the server kicks off an async password rotation (same machinery as transfer — Playwright + polling so it survives Cloudflare's HTTP timeout). On completion, the CLI fetches the new credentials from the appropriate `/mine` endpoint and updates the local vault in place. Owner-only. Same pool / registered dispatch. |
| `palmyr twitter claim` | $0.0011 *(ownership proof on both `/x/accounts/mine` and `/social/twitter/registered/mine`)* | Pull every X account on the server bound to your wallet (owner or shared) into the local vault, with session cookies pre-warmed. Queries both server tables in parallel. The fast path for a wallet that just received a transferred account. |

**Verification.** Operations are confirmed at the network layer — the server intercepts X's actual API responses (`CreateTweet`, `FavoriteTweet`, `update_profile`, etc.) before reporting success. No false positives.

### Server-side account registration (foundation for fire-and-forget scheduling)

Upload your X credentials to Palmyr once. The server encrypts them at rest with AES-256-GCM (key in `REGISTERED_ACCOUNTS_KEY` env var, never logged) and from then on can re-login on your wallet's behalf to refresh cookies whenever they go stale. This is what makes scheduled posts fire even when your machine is off.

**Security:** every read/write is wallet-scoped at the API layer — wallet A can never see or revoke wallet B's accounts. Per-row random IV + auth tag. DB leak alone reveals nothing without the env var. Server compromise (DB + env both leaked) = credentials decryptable; same trade-off every "we hold OAuth tokens" SaaS makes (Buffer / Hootsuite / Postiz).

| Command | Cost | Notes |
|---|---|---|
| `palmyr twitter register <username>` *(if account already in local vault)* | $0.01 | Reads creds from local vault, sends to server, server runs a real test login through a fresh residential session, encrypts + stores on success. Returns `account_id` and `cookies_captured`. |
| `palmyr twitter register <username> --password "..."` *(plus `--login`, `--totp-seed`, `--email`, `--email-password`, `--auth-token`, `--ct0`, `--country`)* | $0.01 | Same, but with explicit credentials instead of vault lookup. |
| `palmyr twitter unregister <username-or-account-id>` | $0.001 | Wipes the encrypted credential + cookie blobs from the server (status flips to `revoked`). Looks up account by username if you don't pass the 32-char hex id. |
| `palmyr twitter registered` | $0.001 | List all your wallet's registered accounts (id, username, country, status, last_login_at). |

Once registered, schedule fire-and-forget posts via the commands below. The Palmyr server's internal scheduler fires them at `post_at` automatically — nothing to run on your machine.

### Server-side scheduling (fire-and-forget)

Pay at schedule time; the Palmyr server fires posts at `post_at` whether your machine is on or off. The account must be registered first (see above). Failure handling: retryable errors (rate limits, transient browser issues) get re-tried with exponential backoff up to 3 attempts; terminal errors (session expired, bad input) move to `failed` for inspection via `--status failed`.

| Command | Cost | Notes |
|---|---|---|
| `palmyr twitter schedule <username> --body "..." --at "2026-05-15T14:00:00Z"` *(or `--texts '[...]'`, plus optional `--image`/`--video`/`--media-json`/`--community`)* | $0.001 text / $0.005 thread or media | x402-paywalled at the post's full price; payment commits to the eventual fire (worker fires for free). Action inferred from flags. Returns `schedule_id`. |
| `palmyr twitter queue [--status pending\|in_progress\|completed\|failed\|cancelled] [--account-id <id>] [--from <iso>] [--to <iso>] [--limit N]` | $0.001 | Server-backed list, wallet-scoped. |
| `palmyr twitter cancel <schedule-id>` | $0.001 | Cancel a pending scheduled post. In-progress / completed / failed cannot be cancelled. No refund per Buffer/Hootsuite model. |

The previous local-queue + `palmyr worker` daemon were deprecated when server-side scheduling shipped. `palmyr worker` now prints a deprecation pointer.

### TikTok

Direct browser automation — no marketplace or paid upstream. A TikTok session comes from a real-browser login (`connect`), not a password the server stores. Account-management commands are local-vault only (free); the action ops run server-side through the account's residential IP.

| Command | Cost | Notes |
|---------|------|-------|
| `palmyr tiktok connect <username>` | free | One-shot real-browser login — opens Chrome/Edge/Brave, you log in once, and the session is auto-captured via CDP and cached locally. No server call. |
| `palmyr tiktok connect <username> --qr` | free | QR login — opens a window showing TikTok's login QR for a human to scan with the TikTok app (no password / captcha). Also hosts the QR server-side and prints a `/connect/<token>` link to forward. Runs headed (TikTok rejects headless QR-auth). |
| `palmyr tiktok import <username> --sessionid <s> --csrf <c> --webid <w> --country <iso2>` | free | Bring your own cookies from a logged-in TikTok browser. |
| `palmyr tiktok import <username> --credentials-line "login:pw:email:email_pw" --country <iso2>` | free | Marketplace colon format. Local vault only; `--country` drives proxy exit + browser locale. |
| `palmyr tiktok list` | free | List local TikTok accounts. |
| `palmyr tiktok info <username>` | free | Show one account (id, source, country, last action). |
| `palmyr tiktok session <username>` | free | Whether a session is cached, its age in hours, and staleness (>12h). |
| `palmyr tiktok rename <old> --to <new>` | free | Rename the local alias (does not change the TikTok handle). |
| `palmyr tiktok remove <username> --confirm` | free | Delete the local copy. The TikTok account itself is not deleted. |
| `palmyr tiktok totp <username>` | free | Print the current 2FA code from the stored seed (if one was imported). |
| `palmyr tiktok login <username>` | $0.02 | Validate stored cookies/credentials via a stealth browser and cache the session. |
| `palmyr tiktok post <username> --file video.mp4 --caption "..."` *(or `--url <https>`; `--privacy 0\|1\|2` = public / friends / private, default public)* | $0.01 | Post a video. Returns success after server-side verification. |
| `palmyr tiktok schedule <username> --at <iso8601> --file video.mp4 --caption "..."` *(or `--url <https>`)* | $0.01 | Schedule via TikTok's own native scheduler — ~15 min to ~10 days out. Aborts before submit if the schedule can't be set, so it never posts "now" by mistake. |
| `palmyr tiktok follow <username> --user @handle` | $0.001 | |
| `palmyr tiktok like <username> --video <url>` | $0.001 | |
| `palmyr tiktok delete <username> --video <url>` | $0.001 | Deletes via TikTok Studio's content manager. |
| `palmyr tiktok bio <username> --text "..."` | $0.001 | New bio, ≤80 chars. Pass `--text ""` to clear. |
| `palmyr tiktok name <username> --display "..."` | $0.001 | New display name, ≤30 chars. TikTok rate-limits nickname changes to ~once/week — returns `RATE_LIMITED` if the change didn't take. |
| `palmyr tiktok pfp <username> --file pic.png` *(or `--url https://...`)* | $0.005 | PNG / JPG / WebP avatar. |

### Utility

| Command | Cost | Notes |
|---|---|---|
| `palmyr setup [--keyfile PATH] [--chain solana\|base]` | free | One-time bootstrap. Initialises `~/.palmyr/`, optionally binds a Solana keyfile for legacy use. |
| `palmyr status` | free | Show wallet config, default chain, and live API health. |
| `palmyr config` | free | Print the resolved config (paths, defaults, env overrides). |
| `palmyr doctor` | free | Diagnose vault, credential store, and connectivity. Non-zero exit if anything fails. |
| `palmyr pricing` | free | Live price list from the API. |
| `palmyr health` | free | API uptime, version, and chain status. |
| `palmyr note "..."` | free | Append a timestamped note to `~/.palmyr/memory/notes.md`. |

---

## SDK

The same package exports a typed `Palmyr` class for use in Node.js applications.

```typescript
import { Palmyr } from '@palmyr/cli'

const ao = new Palmyr({
  api: 'https://palmyr.ai',           // optional, default
  autoPay: true,                        // sign x402 challenges automatically
  token: process.env.PALMYR_TOKEN,     // optional API key
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

// TikTok (account connect/list/info/rename/remove/totp/session are local CLI-only — not SDK calls)
ao.socialTiktokHostQr(qrDataUrl)                                  // host a login QR → { token }; link is `${api}/connect/<token>`
ao.socialTiktokLogin(accountId, { sessionid?, ttCsrfToken?, ttWebidV2?, extraCookies?, login?, password?, email?, emailPassword?, proxySessionId?, country? })
ao.socialTiktokPost(accountId, cookies, caption, { video_base64? | video_url? }, { privacy?: 0|1|2, allow_comments?, allow_duet?, allow_stitch?, schedule_at? }?, proxySessionId?, country?)
ao.socialTiktokFollow(accountId, cookies, targetUser, proxySessionId?, country?)
ao.socialTiktokLike(accountId, cookies, videoUrl, proxySessionId?, country?)
ao.socialTiktokDelete(accountId, cookies, videoUrl, proxySessionId?, country?)
ao.socialTiktokProfile(accountId, cookies, { bio?, display_name? }, proxySessionId?, country?)
ao.socialTiktokAvatar(accountId, cookies, { image_base64? | image_url? }, proxySessionId?, country?)

// Info
ao.pricing()
ao.health()
```

The full method list is exported from `@palmyr/cli` with `.d.ts` typings.

---

## Output Modes

The CLI auto-switches between a human TUI and an agent-friendly JSON contract.

- **TTY (default)** → interactive Ink screens for menus, status, wallet create, etc., plus key-coloured JSON for data commands.
- **Agent mode** → raw JSON on stdout, NDJSON for streaming commands, structured `{error, exitCode, hint}` on stderr for failures, no spinners, no ANSI escape codes, no Ink screens.

Agent mode is **on** when any of these are true:

- stdout is not a TTY (you piped, redirected, or you're running inside a non-interactive runner like `cron`, `docker run`, CI),
- you pass `--json`,
- `PALMYR_JSON=1` is set in the environment.

```bash
# Interactive — nice menus, spinners, the whole TUI
palmyr wallet list

# Agent mode (auto, because of the pipe)
palmyr wallet list | jq '.wallets[].id'

# Agent mode (explicit, even on a TTY)
palmyr compute deploy --name my-vps --type cx23 --json

# Agent mode via env var (good for shell scripts that need predictable output)
PALMYR_JSON=1 palmyr status
```

### Streaming commands (`palmyr chat run`)

In agent mode, `chat run` emits **NDJSON** — one JSON object per line — so you can `for await` over stdout in a pipeline:

```bash
palmyr chat run "deploy a wordpress vps and an inbox" --budget 50 --execute --json \
  | jq -c 'select(.event == "step_result" or .event == "summary")'
```

Event shapes match the SDK's `chatExecute` generator: `plan`, `step_start`, `step_result`, `step_error`, `summary`, etc.

### Errors in agent mode

Errors go to **stderr** as a single-line JSON object so they don't pollute the stdout data stream:

```bash
$ palmyr compute deploy --type cx23 --json 2>err.log
$ echo $?
2
$ cat err.log
{"error":"--name and --type required","exitCode":2}
```

---

## Configuration

Config is stored in `~/.palmyr/config.json`. Environment variables override file values.

```jsonc
{
  "api": "https://palmyr.ai",
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
| `PALMYR_API` | Override API endpoint. |
| `PALMYR_TOKEN`, `PALMYR_API_KEY` | Bearer token for authenticated routes. |
| `PALMYR_PAY_WALLET` | Force a specific wallet ID for x402 payment. |
| `PALMYR_WALLET_PATH` | Override vault directory (default `~/.palmyr/wallet`). |
| `PALMYR_KEYFILE` | Solana keyfile path (legacy single-key flow). |
| `PALMYR_WALLET_PASSPHRASE` | Vault decryption passphrase. Used when the wallet was created with `--passphrase` (or env) or migrated via `wallet rekey`. Falls back to the OS-keychain session secret when unset. |

### Chain selection during payment

The payment chain is resolved in this order:

1. `--chain` flag on the command itself (e.g. `wallet pay-preflight --chain base`).
2. `defaultPayChain` in `~/.palmyr/config.json` — set by `palmyr wallet use <ID> --chain <chain>`.
3. `solana` as the final default.

(Earlier versions of this doc listed `PALMYR_PAY_CHAIN` and `defaultChain` as fallbacks — neither is read by the current pay path. `defaultChain` is legacy keyfile-flow state and `saveConfig` strips it from vault-only configs.)

If the server doesn't offer the chosen chain for an endpoint, the CLI errors loudly. There is no silent fallback — the assumption is that an agent should know which chain it pays from.

---

## File Layout

```
~/.palmyr/
├── config.json              # Resolved config (chains, defaults, vault path)
├── wallet/
│   ├── wallets/             # Encrypted wallet files (AES-256-GCM)
│   ├── keys/                # API key metadata
│   └── spends/              # Per-day spend ledgers
├── secrets/                 # Windows DPAPI fallback (macOS/Linux use OS keychain)
├── data/                    # Local cache of phones, inboxes, servers, domains
├── logs/                    # Daily logs, pruned after 30 days
├── drafts/                  # Long-form draft storage
├── trading/                 # Phase 1 trading state (positions, trades.jsonl, journal/, watchlist.jsonl, config.json)
└── memory/notes.md          # `palmyr note` output
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

- **Keys never leave the machine.** `wallet create` and `wallet import` never transmit seed material to the server.
- **Encryption at rest.** The wallet file is AES-256-GCM with the session secret as the key. The session secret is generated on wallet creation and never stored on disk in plaintext.
- **OS credential store.** Session secrets live in DPAPI (Windows), Keychain (macOS), or `secret-tool` (libsecret on Linux). If none is available the CLI errors rather than falling back to plaintext.
- **Recoverable by default.** `wallet create` and `wallet import` require a scrypt passphrase fallback (via `--passphrase` or `PALMYR_WALLET_PASSPHRASE`) or an explicit `--session-only` opt-out. The passphrase blob is a second AES-256-GCM ciphertext keyed by scrypt(passphrase, random salt) and lets the wallet decrypt on a different machine / user / headless box where the OS keychain isn't reachable. Decryption tries the OS session secret first, then falls back to the env/flag passphrase. Session-only wallets are bound to this machine's OS keychain — explicit opt-in for ephemeral use only.
- **Bidirectional vault integrity.** On every load, the CLI checks that every account stored in the wallet file is still derivable from the seed, **and** that every account derivable from the seed is still in the file. Either direction failing returns exit code `7`.
- **Pre-flight validation.** Endpoints that are easy to fail (bad pubkey for an inbox, malformed E.164 for SMS, unsupported destination country) are validated **before** the x402 paywall, so you don't pay for requests that were never going to succeed.
- **No `--no-verify`.** Hooks, signatures, and webhooks are always verified.

---

## Troubleshooting

```bash
palmyr doctor
```

`doctor` walks every subsystem (config, vault, credential store, API, default wallet) and prints a pass/fail line per check. Exits non-zero if any check fails — usable in CI.

Common issues:

- **`SECURITY` exit code on any wallet command.** The vault file or its derived accounts have drifted. Restore the wallet file from backup, or re-import from the mnemonic.
- **`Server did not offer <chain> as option`.** Either the endpoint only supports the other chain, or your `defaultPayChain` is misconfigured. Use `palmyr wallet use <ID> --chain <other>` and retry.
- **`No session secret found`.** The wallet was created on a different machine, or the OS credential store is unavailable. Re-import the wallet and let the CLI store the secret again.

---

## Links

- API and dashboard — [palmyr.ai](https://palmyr.ai)
- Source — [github.com/0xArtex/Palmyr](https://github.com/0xArtex/Palmyr)
- Issues — [github.com/0xArtex/Palmyr/issues](https://github.com/0xArtex/Palmyr/issues)
- Skill manifest — [palmyr.ai/skill.md](https://palmyr.ai/skill.md)

## License

MIT
