> Fetch this when creating wallets in bulk, buying/selling tokens, or running the monitor daemon.

# Palmyr — Wallets & Trading

**Any wallet you `create` trades on Solana + Base, autonomously.** Wallet creation is free; trades pay gas/USDC per the funding asset.

## Wallet lifecycle

`wallet create` REQUIRES a passphrase fallback OR explicit `--session-only`. The passphrase becomes a scrypt-sealed second decryption key so the wallet survives reboot / OS-keychain loss / host migration. Keep `PALMYR_WALLET_PASSPHRASE` exported (or in a systemd `EnvironmentFile`) on every machine that uses the wallet.

```bash
PALMYR_WALLET_PASSPHRASE="..." palmyr wallet create --name agent-prod   # recommended (free)
PALMYR_WALLET_PASSPHRASE="..." palmyr wallet create --solana            # Solana only (--base for Base/EVM only)
palmyr wallet create --session-only                                      # opt out — ephemeral wallets only
palmyr wallet list [--tag <name>]                                        # all wallets; --tag filters to one folder
palmyr wallet rekey <WALLET_ID> --passphrase "..."                       # migrate a session-only wallet to passphrase-backed (run on the ORIGINAL machine)
```

### Wallet foldering (group + cascade-delete)

Ideal for demo/cohort/test wallets. Bulk path is unmanaged-only, max 500/call, batched DPAPI seal on Windows (~7s for 100 vs ~60s naive).

```bash
palmyr wallet create --tag palmyr-demo --count 100              # palmyr-demo-001..-100
palmyr wallet create --tag agents --count 50 --name-prefix bot  # bot-01..bot-50
palmyr wallet tag <WALLET_ID> palmyr-demo | --clear             # assign/change/untag
palmyr wallet tags                                              # list tags with counts + chains
palmyr wallet tag-delete palmyr-demo --confirm                  # nuke every wallet under the tag
```

## Trading

Funding asset = the suffix on `--amount`: `0.5sol` / `0.01eth` for native, `10usdc` for USDC. Sells exit back to the entry asset. MEV protection + dynamic slippage are ON by default; `--degen` opts out for fast/raw execution. `--dry-run` is strictly read-only (never mutates position files). Positions persist at `~/.palmyr/trading/positions/<wallet-addr>/<chain>/<mint>.json`; re-entries on a closed mint archive the prior cycle to `.../history/<mint>-<entryTs>.json`.

```bash
palmyr wallet buy <chain> <CA> --amount <N{sol|eth|usdc}> --thesis "..." --wallet <name> \
   [--cut -25% --tp +60% --trail 20% --time-limit 6h --thesis-check 90m --dry-run --degen]
palmyr wallet sell <chain> <CA> --percent N --reason "..." --wallet <name>   # exits to entry asset
palmyr wallet positions [--all] [--history] [--wallet <name>] [--chain X]    # cross-chain by default
palmyr wallet sync [--chain solana|base] [--wallet <name>]                   # both chains by default
palmyr wallet pnl [--by chain|wallet] [--no-usd]                             # SOL/ETH/USDC buckets + USD total
palmyr wallet brief <CA> [--wallet <name>] [--chain X] [--evaluate]          # chain inferred from CA; --evaluate needs ANTHROPIC_API_KEY
palmyr wallet doctor [--wallet <name>]                                        # deps + RPC + derivation health
palmyr wallet smoke-test --wallet <name> [--chain solana|base|all]            # end-to-end dry-run validation
palmyr wallet readiness --wallet <name>                                       # go/no-go: sign, gas, quotes, daemon, open positions
palmyr wallet live-test --wallet <name> --budget 1usdc [--chain solana|base|all]  # tiny real round trips; verifies no leftover positions
```

### Autonomous monitor daemon

Syncs both chains, fires exitPlan triggers (cut, takeProfit, trailingStop, timeLimit, thesisCheck via LLM):

```bash
palmyr wallet daemon start --auto --wallet <name>   # detached; auto-sells on fire
palmyr wallet daemon tick --wallet <name>           # one-shot
palmyr wallet daemon status | stop
```

### Cohort buy + YAML templates

```bash
palmyr wallet cohort buy <chain> <CA> --total <amt> --wallets a,b,c --jitter 5000 --thesis "..."   # split one decision across N wallets with timing jitter
palmyr wallet template list | show <name> | path <name>
palmyr wallet buy <chain> <CA> --template <name> --thesis "..." --wallet <name>
```

## Vault storage

The CLI creates `~/.palmyr/` for config, credentials, data, logs, and memory. The wallet file at `~/.palmyr/wallet/wallets/<id>.json` is AES-256-GCM encrypted; the session key lives in your OS credential store (DPAPI / Keychain / `secret-tool`) and the passphrase blob is scrypt-sealed. Neither key ever lives on disk in plaintext.

## API

| Action | Endpoint | Cost (USDC) |
|---|---|---|
| Create wallet | `POST /wallet` | Free |
| Wallet status | `GET /wallet/:address` | Free |
| Transfer (ERC-20) | via smart contract | Gas only |

On-chain trading (buy/sell/sync/daemon) runs locally in the CLI against Solana + Base RPCs — it does not proxy through the Palmyr API.
