---
name: palmyr
version: 1.0.0
description: Infrastructure for AI Agents. Phone, email, X/Twitter + TikTok accounts, compute, domains, voice calling, and wallets for AI agents. Pay with USDC on Solana or Base via x402.
---

# Palmyr — Infrastructure for AI Agents

Everything an agent needs: phone, email, compute, domains, voice calling, wallets, and 3500+ skills. Pay with USDC on Solana or Base via x402.

**CLI:** `npm i -g @palmyr/cli` (or `npx @palmyr/cli`)
**API:** `https://palmyr.ai`
**Source:** https://github.com/0xArtex/Palmyr

## Setup

```bash
npm i -g @palmyr/cli

# Create a local HD wallet — both Solana + Base from one mnemonic, ready for x402 payments.
# Set PALMYR_WALLET_PASSPHRASE first so the wallet is recoverable across reboot / OS-keychain
# loss / host migration. Without it, `wallet create` errors (or prompts on TTY).
PALMYR_WALLET_PASSPHRASE="your-passphrase" palmyr wallet create

# Opt out (ephemeral wallets only — NOT recoverable from the JSON file alone):
palmyr wallet create --session-only

# Check everything works
palmyr status
palmyr doctor   # flags wallets that need PALMYR_WALLET_PASSPHRASE to decrypt
```

Keep `PALMYR_WALLET_PASSPHRASE` exported in the shell / systemd unit / agent env that runs `palmyr`. Then `pay`, `sign-message`, `export`, and `pay-preflight` decrypt automatically when the OS keychain is unavailable (different user, fresh OS, headless box without a keyring daemon).

The CLI creates `~/.palmyr/` to store config, credentials, data, logs, and memory. The wallet file at `~/.palmyr/wallet/wallets/<id>.json` is AES-256-GCM encrypted; the session key lives in your OS credential store (DPAPI / Keychain / `secret-tool`) and the passphrase blob is scrypt-sealed. Neither key ever lives on disk in plaintext.

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
palmyr domain list                       # Owned + shared
palmyr domain transfer-ownership --name example.dev --to <wallet>  # Hand domain to another wallet
palmyr domain share --name example.dev --with <wallet>             # Grant another wallet access (DNS edits)
palmyr domain unshare --name example.dev --from <wallet>

# Wallet
# `wallet create` REQUIRES a passphrase fallback OR explicit --session-only opt-out.
# The passphrase becomes a scrypt-sealed second decryption key so the wallet survives
# reboot / OS-keychain loss / host migration. Keep PALMYR_WALLET_PASSPHRASE exported
# (or in a systemd EnvironmentFile) on every machine that will use the wallet.
PALMYR_WALLET_PASSPHRASE="..." palmyr wallet create --name agent-prod       # recommended (free)
PALMYR_WALLET_PASSPHRASE="..." palmyr wallet create --solana                # Solana only (--base for Base/EVM only)
palmyr wallet create --session-only                                          # opt out — ephemeral wallets only
palmyr wallet list                                                            # All wallets in vault; --tag <name> filters to one folder

# Migrate an existing session-only wallet to passphrase-backed (run on the
# original machine while the OS session secret still works):
palmyr wallet rekey <WALLET_ID> --passphrase "..."

# Wallet foldering — group many wallets under one tag, cascade-delete together.
# Ideal for demo/cohort/test wallets. Bulk path is unmanaged-only, max 500/call,
# batched DPAPI seal on Windows (~7s for 100 wallets vs ~60s naive).
palmyr wallet create --tag palmyr-demo --count 100              # 100 wallets named palmyr-demo-001..-100
palmyr wallet create --tag agents --count 50 --name-prefix bot  # custom prefix → bot-01..bot-50
palmyr wallet tag <WALLET_ID> palmyr-demo                       # assign / change tag
palmyr wallet tag <WALLET_ID> --clear                           # untag
palmyr wallet tags                                              # list tags with counts + chains
palmyr wallet tag-delete palmyr-demo --confirm                  # nuke every wallet under the tag

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
palmyr wallet brief <CA> [--wallet <name>] [--chain X] [--evaluate]          # chain inferred from CA format; --evaluate needs ANTHROPIC_API_KEY env var
palmyr wallet doctor [--wallet <name>]                                        # deps + RPC + derivation health check
palmyr wallet smoke-test --wallet <name> [--chain solana|base|all]            # end-to-end dry-run validation
palmyr wallet readiness --wallet <name>                                       # go/no-go: sign, gas, quotes, daemon, open positions
palmyr wallet live-test --wallet <name> --budget 1usdc [--chain solana|base|all]  # tiny real round trips, verifies no leftover positions

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
palmyr twitter buy                                       # Buy a ready X account ($5 default; per-country pricing applies if --country is set)
palmyr twitter buy --country GB                          # Filter by RESIDENCY (X "Account based in"). Price = country_prices.GB.
palmyr twitter buy --country GB --registered-country GB  # Also require registration FROM that country (X "Connected via")
palmyr twitter buy --platform android                    # Require android-registered (also ios | web)
palmyr twitter buy --max-renames 0                       # Only never-renamed handles
palmyr twitter pool-prices                               # See all country prices + source multipliers (call first to know what's priced)
palmyr twitter dispute <account_id> --reason suspended   # 7-day dispute window — auto-replaces or refunds if X suspended the account ($0.01 ownership proof)
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

# Hand off / share an X account between wallets — owner-only. Imported-only
# accounts are auto-registered with the server on the first transfer (~$0.01
# USDC, transparent), so the receiver wallet can claim them. No separate
# `register` step required.
palmyr twitter transfer <username> --to <wallet> --confirm       # Rotates password + revokes other sessions, then flips ownership. Auto-registers if not on server yet. Server returns transfer_id immediately; CLI polls /transfers/:id every 5s until completed (rotation runs ~30-90s in the background). Local copy is wiped on success.
palmyr twitter share <username> --with <wallet>                  # Grant shared access (same login, no rotation)
palmyr twitter unshare <username> --from <wallet> [--rotate]     # Revoke share. --rotate also rotates password so the revoked wallet's cached cookies stop working — runs async with polling like transfer (~30-90s).
palmyr twitter list [--local]                                    # Local vault PLUS server-only accounts the wallet owns or has shared with (with a hint to `claim`). --local skips the server check.
palmyr twitter claim                                             # Pull every server-side X account the wallet can access into the local vault.

# Auto-import on use: any of the commands above (post, like, info, totp, etc.) that target an account
# the wallet has access to server-side but doesn't yet have locally will auto-import on first call.
# So a wallet that was just transferred or shared an account can run `palmyr twitter post @h "gm"`
# directly — no separate `claim` step needed.

# TikTok — DIRECT browser automation (no paid upstream). Sessions come from a real browser login.
palmyr tiktok connect <username> [--tag <folder>]        # Log in once in your real browser; session auto-captured via CDP. --tag files it under a folder. Free, no server call.
palmyr tiktok connect <username> --qr                    # Human hand-off (QR): prints a clean /connect link INSTANTLY (also in qr_link) to send a human. Auto-refreshes the QR (never stale, ~15 min); captured the moment they scan + confirm. Needs the account in their TikTok phone app.
palmyr tiktok connect <username> --remote                # Human hand-off (live browser) for VPS/headless: streams the real server browser to a /connect link (in login_link) so a human does the FULL email/password/2FA/captcha login from any device. Best when QR isn't an option. Headed browser required (xvfb on headless).
palmyr tiktok import <username> --sessionid <s> --csrf <c> --webid <w> --country <iso2>   # BYO cookies from a logged-in browser (free)
palmyr tiktok import <username> --credentials-line "login:pw:email:email_pw" --country us # Marketplace line (free; local vault only)
palmyr tiktok login <username>                           # Validate cookies + cache the session ($0.02)
palmyr tiktok session <username>                         # Check the cached session — flags stale >12h (free)
palmyr tiktok post <username> --file video.mp4 --caption "..." [--privacy 0|1|2]           # Post a video; --privacy 0 public · 1 friends · 2 private (default public) ($0.01)
palmyr tiktok schedule <username> --at 2026-06-03T18:00:00Z --file v.mp4 --caption "..."  # TikTok's native scheduler, ~15 min–10 days out (same price as post)

# Human-in-the-loop: draft → approve → post → audit log (so an agent never publishes unreviewed)
palmyr tiktok draft <username> --file v.mp4 --caption "..." [--privacy 0|1|2] [--at <iso>]   # Stage a post for approval; does NOT publish (free). --at makes approve schedule it.
palmyr tiktok drafts [<username>] [--tag <folder>]       # List drafts awaiting approval (free)
palmyr tiktok approve <draft-id>                         # Publish a queued draft + record it in the post log (charges the post price)
palmyr tiktok reject <draft-id>                          # Discard a queued draft (free)
palmyr tiktok logs [<username>] [--tag <folder>] [--limit N]   # Audit log of what went out — approved drafts + direct posts (free)

# Self-learning loop: monitor → track analytics → categorize → review (so agents see what performs)
palmyr tiktok analytics <username>                       # Scrape per-post views/likes/comments, tier them vs the account's OWN posts, snapshot the time-series ($0.005; free self-hosted)
palmyr tiktok review <username>                          # Performance review — best/worst, tier mix, avg engagement, trend vs last snapshot (free, reads local store)
palmyr tiktok monitor start --every 6h [--account a,b]   # Unattended: periodic analytics snapshots. Also: tick (one-shot) | stop | status (free locally)
palmyr tiktok follow <username> --user @handle           # Follow ($0.001)
palmyr tiktok like <username> --video <url>              # Like a video ($0.001)
palmyr tiktok delete <username> --video <url>            # Delete a post — via TikTok Studio's content manager ($0.001)
palmyr tiktok bio <username> --text "..."                # Update bio, <=80 chars ($0.001)
palmyr tiktok name <username> --display "..."            # Update display name, <=30 chars ($0.001). NB: TikTok rate-limits nickname changes to ~once/week.
palmyr tiktok pfp <username> --file pic.png              # Update avatar ($0.005)
palmyr tiktok list [--tag <folder>]                      # All local TikTok accounts; --tag filters to one folder (free)
palmyr tiktok tag <username> <folder>                    # File an account under a folder-like tag to organize 30+ accounts; `--clear` removes it (free)
palmyr tiktok info <username> | rename <old> --to <new> | remove <username> --confirm | totp <username>   # Local account management (free)

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
| List your domains *(owner + shared)* | `GET /domains` | 0.01 *(ownership proof)* |
| DNS records | `GET /domains/:domain/dns` | 0.01 *(ownership proof)* |
| Update DNS | `POST /domains/:domain/dns` | 0.01 *(ownership proof; shared wallets allowed)* |
| Transfer ownership | `POST /domains/:domain/transfer-ownership` | 0.01 *(ownership proof; clears shared_with)* |
| Share with another wallet | `POST /domains/:domain/share` | 0.01 *(ownership proof; owner-only)* |
| Revoke a shared wallet | `POST /domains/:domain/unshare` | 0.01 *(ownership proof; owner-only)* |
| Pricing | `GET /pricing` | Free |
| **Wallet** | | |
| Create wallet | `POST /wallet` | Free |
| Wallet status | `GET /wallet/:address` | Free |
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
| Transfer pool account | `POST /x/accounts/:id/transfer` *(202 with `{ transfer_id }`; poll `GET /transfers/:transfer_id`)* | 0.01 *(ownership proof; rotation runs in background, atomic when it completes)* |
| Poll transfer status | `GET /transfers/:id` | 0.01 *(ownership proof; expected ~6-18 polls per transfer at 5s interval)* |
| Share pool account | `POST /x/accounts/:id/share` | 0.01 *(ownership proof; owner-only)* |
| Revoke shared wallet (pool) | `POST /x/accounts/:id/unshare` *(body: `{ wallet, rotate? }`)* | 0.01 *(ownership proof; owner-only; `rotate: true` also rotates password)* |
| List pool accounts owned/shared with you | `GET /x/accounts/mine` | 0.01 *(ownership proof)* |
| Transfer registered (BYO) account | `POST /social/twitter/registered/:id/transfer` *(202 with `{ transfer_id }`; poll `GET /transfers/:transfer_id`)* | 0.01 *(ownership proof; rotation runs in background, atomic when it completes)* |
| Share registered (BYO) account | `POST /social/twitter/registered/:id/share` | 0.01 *(ownership proof; owner-only)* |
| Revoke shared wallet (registered) | `POST /social/twitter/registered/:id/unshare` *(body: `{ wallet, rotate? }`)* | 0.01 *(ownership proof; owner-only)* |
| List registered accounts owned/shared with you | `GET /social/twitter/registered/mine` | 0.001 *(ownership proof; returns decrypted creds)* |
| Share pool-bought account *(from `palmyr twitter buy`)* | `POST /social/twitter/pool/:id/share` | 0.01 *(ownership proof; owner-only)* |
| Revoke shared wallet (pool-bought) | `POST /social/twitter/pool/:id/unshare` | 0.01 *(ownership proof; owner-only; rotate not yet wired)* |
| List pool-bought accounts owned/shared with you | `GET /social/twitter/pool/mine` | 0.001 *(ownership proof; returns decrypted creds)* |
| **TikTok** | | |
| Host login QR | `POST /social/tiktok/qr` | Free |
| Login (validate + cache cookies) | `POST /social/tiktok/login` | 0.02 |
| Post video *(add `schedule_at` to use TikTok's native scheduler)* | `POST /social/tiktok/post` | 0.01 |
| Follow | `POST /social/tiktok/follow` | 0.001 |
| Like | `POST /social/tiktok/like` | 0.001 |
| Delete post | `POST /social/tiktok/delete` | 0.001 |
| Update profile (bio / display name) | `POST /social/tiktok/profile` | 0.001 |
| Update avatar | `POST /social/tiktok/avatar` | 0.005 |
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
