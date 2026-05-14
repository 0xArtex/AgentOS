---
name: palmyr
version: 1.0.0
description: Infrastructure for AI Agents. Phone, email, X/Twitter accounts, compute, domains, voice calling, and wallets for AI agents. Pay with USDC on Solana or Base via x402.
---

# Palmyr — Infrastructure for AI Agents

Everything an agent needs: phone, email, compute, domains, voice calling, wallets, and 3500+ skills. Pay with USDC on Solana or Base via x402.

**CLI:** `npm i -g @palmyr/cli` (or `npx @palmyr/cli`)
**API:** `https://palmyr.ai`
**Source:** https://github.com/0xArtex/Palmyr

## Setup

```bash
npm i -g @palmyr/cli

# Configure your Solana wallet (for x402 payments)
palmyr setup --keyfile ~/.config/solana/id.json --chain solana

# Optionally add Base (EVM) wallet too
palmyr setup --keyfile ./base-key.json --chain base

# Check everything works
palmyr status
```

The CLI creates `~/.palmyr/` to store config, credentials, data, logs, and memory. Your keyfile is referenced by path — never copied.

## CLI Commands

Use the CLI for cleaner context and simpler commands:

```bash
# Phone
palmyr phone search --country US          # Search numbers (free)
palmyr phone buy --country US             # Buy a number ($3)
palmyr phone sms --id ID --to +1... --body "hi"   # Send SMS ($0.05)
palmyr phone call --id ID --to +1... --tts "hello" # Voice call ($0.10)

# Email (E2E encrypted)
palmyr email create --name agent --wallet SOL_PUBKEY  # Create inbox ($2)
palmyr email read --id INBOX_ID                       # Read messages ($0.02)
palmyr email send --id ID --to x@y.com --subject "Hi" --body "..."  # Send ($0.08)
palmyr email threads --id INBOX_ID                    # List threads ($0.02)

# Compute
palmyr compute plans [--location fsn1]                     # List VPS plans (free); optionally filter by location
palmyr compute locations                                   # List datacenters + per-location server-type availability (free)
palmyr compute install-recipes                             # List bootstrappable agent runtimes (free)
palmyr compute deploy --type cx23 --json                   # Golden path: auto-key, wait, verified ($6 + monthly)
palmyr compute deploy --type cx23 --install hermes --json  # Deploy + bootstrap Hermes Agent (Nous Research)
palmyr compute deploy --type cax11 --location fsn1 --json  # Pin to a specific datacenter
palmyr compute deploy --type cx23 --install hermes,openclaw --json  # Multiple recipes
palmyr compute deploy --type cx23 --no-install --json      # Vanilla Ubuntu (password auth on)
palmyr compute deploy --type cx23 --ssh-key 12345 --json   # Use a pre-uploaded Hetzner key
palmyr compute deploy --type cx23 --no-wait --json         # Fire-and-forget
palmyr compute ssh-key add <PUBKEY_PATH>                   # Upload key to Hetzner ($0.10) — returns numeric id. Replace <PUBKEY_PATH> with the path to YOUR public key
palmyr compute ssh-key list                                # List uploaded keys ($0.01)
palmyr compute wait <name|id> [--install hermes]           # Block until ready (gates: status=running, port 22, SSH, install marker)
palmyr compute ssh <name|id>                               # SSH in (TTY) or print ssh command (agent mode)
palmyr compute exec <name|id> -- <command> [args...]       # Run command pre-handoff ($0.05)
palmyr compute rename <name|id> <new-name>                 # Rename a deployed VPS ($0.01, no reboot)
palmyr compute reset-password <name|id>                    # Rotate root password ($0.10)
palmyr compute console <name|id>                           # noVNC URL — break-glass when SSH broken ($0.10)
palmyr compute reboot|poweroff|poweron|reset|rebuild <name|id>  # Lifecycle actions ($0.10)
palmyr compute setup-ssh <id> --pubkey-file <PUBKEY_PATH>  # Inject key post-deploy ($0.01). Replace <PUBKEY_PATH> with the path to YOUR public key
palmyr compute list                                        # List servers
palmyr compute delete <name|id>                            # Delete server ($0.10)

# Domains
palmyr domain check --name example.dev   # Check availability (free)
palmyr domain pricing --name example     # Get pricing (free)
palmyr domain buy --name example.dev     # Register domain

# Wallet
palmyr wallet keygen                     # Generate keypair (free)
palmyr wallet create                     # Create local HD wallet (free)
palmyr wallet create --managed           # Same, with passkey-gated spending limits

# Trading — any wallet you `create` trades on Solana + Base, autonomously.
# Funding asset = the suffix on --amount: `0.5sol`/`0.01eth` for native, `10usdc` for USDC.
# Sells exit back to the entry asset. MEV protection + dynamic slippage are ON by default;
# pass --degen to opt out for fast/raw execution.
# --dry-run is strictly read-only — never mutates position files.
# Positions persist at ~/.palmyr/trading/positions/<wallet-addr>/<chain>/<mint>.json.
# Re-entries on a closed mint archive the prior cycle to .../history/<mint>-<entryTs>.json.
palmyr wallet buy <chain> <CA> --amount <N{sol|eth|usdc}> --thesis "..." --wallet <name> \
   [--cut -25% --tp +60% --trail 20% --time-limit 6h --thesis-check 90m --dry-run --degen]
palmyr wallet sell <chain> <CA> --percent N --reason "..." --wallet <name>   # exits to entry asset
palmyr wallet positions [--all] [--history] [--wallet <name>] [--chain X]    # cross-chain by default
palmyr wallet sync [--chain solana|base] [--wallet <name>]                   # both chains by default
palmyr wallet pnl [--by chain|wallet] [--no-usd]                             # SOL/ETH/USDC buckets + USD total
palmyr wallet brief <CA> [--wallet <name>] [--chain X] [--evaluate]          # chain inferred from CA format
palmyr wallet doctor [--wallet <name>]                                        # deps + RPC + derivation health check
palmyr wallet smoke-test --wallet <name> [--chain solana|base|all]            # end-to-end dry-run validation

# Autonomous monitor daemon — syncs both chains, fires exitPlan triggers
# (cut, takeProfit, trailingStop, timeLimit, thesisCheck via LLM):
palmyr wallet daemon start --auto --wallet <name>                            # detached; auto-sells on fire
palmyr wallet daemon tick --wallet <name>                                    # one-shot
palmyr wallet daemon status | stop

# Cohort buy — split one decision across N wallets with timing jitter:
palmyr wallet cohort buy <chain> <CA> --total <amt> --wallets a,b,c --jitter 5000 --thesis "..."

# YAML templates — reusable trade-plan defaults (amount, exit plan, cohort layout):
palmyr wallet template list | show <name> | path <name>
palmyr wallet buy <chain> <CA> --template <name> --thesis "..." --wallet <name>

# Twitter / X
palmyr twitter buy                                       # Buy a ready X account ($5)
palmyr twitter import <username> --credentials-line "..."# Import your own (free)
palmyr twitter login <username>                          # Cache session ($0.005)
palmyr twitter post <username> --body "gm"               # Post tweet ($0.001)
palmyr twitter reply <username> --to <url> --body "..."  # Reply ($0.001)
palmyr twitter like <username> --tweet <url>             # Like ($0.001)
palmyr twitter retweet <username> --tweet <url>          # Retweet ($0.001)
palmyr twitter follow <username> --user @handle          # Follow ($0.001)
palmyr twitter unfollow <username> --user @handle        # Unfollow ($0.001)
palmyr twitter delete <username> --tweet <url>           # Delete tweet ($0.001)
palmyr twitter bio <username> --text "..."               # Update bio ($0.001)
palmyr twitter name <username> --display "..."           # Update display name ($0.001)
palmyr twitter pfp <username> --file pic.png             # Update avatar ($0.005)
palmyr twitter banner <username> --file banner.png       # Update banner ($0.005)
palmyr twitter username <username> --to <new-handle>     # Change handle ($0.005)

# Info
palmyr pricing    # All service prices
palmyr health     # API status
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
| List plans | `GET /compute/plans` *(optional `?location=fsn1` filter; rows include `availableLocations[]`)* | Free |
| List locations | `GET /compute/locations` *(datacenters + per-location server-type availability)* | Free |
| List install recipes | `GET /compute/install-recipes` | Free |
| Upload SSH key | `POST /compute/ssh-keys` | 0.10 |
| List SSH keys | `GET /compute/ssh-keys` | 0.01 |
| Delete SSH key | `DELETE /compute/ssh-keys/:id` | 0.01 |
| Create server | `POST /compute/servers` *(accepts `sshPublicKey`, `sshKeyIds[]`, `install` recipe, `location`; pre-payment validates name + type+location compat; returns `sshAccess` + `installs` blocks)* | 6.00 |
| List servers | `GET /compute/servers` | 0.01 |
| Server status | `GET /compute/servers/:id` | 0.01 |
| Rename server | `PUT /compute/servers/:id` *(metadata-only, no reboot)* | 0.01 |
| Server action | `POST /compute/servers/:id/actions` *(reboot, poweron, poweroff, reset, rebuild, **reset_password**, **request_console**)* | 0.10 |
| Run command (pre-handoff) | `POST /compute/servers/:id/exec` | 0.05 |
| SSH key handoff | `POST /compute/servers/:id/setup-ssh` | 0.01 |
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
| **Twitter / X** | | |
| Buy account from pool | `POST /social/twitter/buy` | 5.00 |
| Login (capture cookies) | `POST /social/twitter/login` | 0.005 |
| Post tweet | `POST /social/twitter/post` | 0.001 |
| Reply to tweet | `POST /social/twitter/reply` | 0.001 |
| Like | `POST /social/twitter/like` | 0.001 |
| Retweet | `POST /social/twitter/retweet` | 0.001 |
| Follow | `POST /social/twitter/follow` | 0.001 |
| Unfollow | `POST /social/twitter/unfollow` | 0.001 |
| Delete tweet | `POST /social/twitter/delete` | 0.001 |
| Update profile (bio/name/location/website) | `POST /social/twitter/profile` | 0.001 |
| Update avatar | `POST /social/twitter/avatar` | 0.005 |
| Update banner | `POST /social/twitter/banner` | 0.005 |
| Change username | `POST /social/twitter/username` | 0.005 |
| **Skills** | | |
| Browse catalog | `GET /compute/skills/catalog` | Free |
| Security scan | `GET /compute/skills/:slug/security` | Free |

All paid endpoints use **x402** — make the request, get a 402, pay with USDC, done.

## Agent mode

The CLI auto-detects when stdout isn't a TTY and switches to a machine-parseable contract: clean JSON on stdout, structured `{error, exitCode, hint}` on stderr for failures, no spinners or ANSI decoration. Force it on a TTY with `--json` or `PALMYR_JSON=1`.

Streaming commands (`palmyr chat run`) emit **NDJSON** in agent mode — one JSON event per line — so you can `for await` over stdout in a pipeline.

### Stable exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic failure |
| 2 | Bad input (missing/invalid flag or argument) |
| 3 | Auth failed (bad token/session) |
| 4 | Not found (wallet, server, etc.) |
| 5 | Network unreachable |
| 6 | x402 payment failed |
| 7 | Vault tamper / security check failed — do not retry |

```bash
palmyr compute deploy --type cx23 --json | jq .sshCommand
palmyr compute exec my-vps -- echo hi --json 2>err.log; [ $? -eq 0 ] || cat err.log
```

## VPS golden path

`palmyr compute deploy --type cx23 --json` is a one-liner that:
1. Generates an ed25519 keypair locally (`~/.palmyr/ssh/<name>/id_ed25519`).
2. Pays $6 USDC via x402, deploys via Hetzner Cloud.
3. Runs cloud-init (security hardening + the requested install recipe).
4. Waits until `status=running`, port 22 is open, `ssh -i <key> root@<ip> 'true'` returns 0, and `/etc/palmyr/install-status.json` reports `ok`.
5. Returns JSON with a top-level `sshCommand` and a `readiness` block showing each gate.

After it returns, `palmyr compute ssh <name>` drops you in (TTY) or prints the ssh command (agent mode). Everything resolves from a local cache — no paid round-trip.

### Bootstrap an agent runtime in one call

```bash
palmyr compute deploy --type cx23 --install hermes --json
```

Cloud-init runs the recipe at first boot. Available recipes (live list at `GET /compute/install-recipes`):
- `openclaw` — Node 22 + the openclaw and clawhub npm packages. The historical default.
- `hermes` — [Hermes Agent](https://github.com/NousResearch/hermes-agent), Nous Research's self-improving AI agent. Installed via the official `scripts/install.sh --skip-setup`. After deploy, run `palmyr compute exec <name> -- hermes setup` to pick a model provider.

Recipe validation is **pre-payment**: typos return `EXIT.BAD_INPUT` (2) without charging USDC.

## Authentication

**Your wallet is your identity.** No API keys. No signup.

Call any endpoint → pay with USDC via x402 → your wallet owns the resource.

Same wallet to access it later. That's it.

**Networks:** Solana mainnet + Base (EVM)

---


## API Details

The CLI wraps all API endpoints. If you prefer raw HTTP, use the quick reference table above. All endpoints accept JSON and return JSON.

For voice calls, email threads, attachments, webhooks, and other advanced features — run `palmyr --help` or see the full API docs at `palmyr.ai/docs`.

### Payment Flow
1. Call any paid endpoint → get `402 Payment Required`
2. Response includes USDC amount + treasury address (Solana + Base)
3. Pay via x402 protocol
4. Your wallet address becomes the resource owner

### X / Twitter Accounts

Two paths to a working account:

1. **Buy from the pool** — `POST /social/twitter/buy` ($5 USDC). The server returns a ready-to-use account: handle, encrypted credentials, captured cookies, and a `proxy_session_id` that pins a sticky residential IP. The CLI auto-imports it into the local vault and you can post immediately.
2. **Bring your own** — `POST /social/twitter/login` ($0.005). Send credentials (or pre-captured `auth_token` + `ct0` cookies) and the server logs in via Playwright stealth through your `proxy_session_id` IP, returning a 12h cookie session.

Every operation (`post`, `reply`, `like`, `follow`, `update profile`, `avatar`, `banner`, `username`) sends `account_id` + `cookies` + optional `proxy_session_id`. The server reuses the same residential IP that originally logged in, so X never sees a sudden geography change. Success is verified at the network layer — the server reads X's actual API response (`CreateTweet`, `FavoriteTweet`, `update_profile`, etc.) before reporting success. No false positives.

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
- **Email inbound:** Emails to `*@palmyr.ai` processed via Cloudflare worker → stored encrypted
