> Fetch this before the first paid call, or when parsing 402s, exit codes, agent-mode output, or refunds.

# Palmyr — Payment (x402), agent mode & refunds

## Authentication — your wallet is your identity

No API keys. No signup. Call any endpoint → pay with USDC via x402 → your wallet owns the resource. Use the same wallet to access it later. **Networks:** Solana mainnet + Base (EVM). Identity/ownership-proof reads are free (wallet-signed, no 402).

## Payment flow (x402 v2)

1. Call any paid endpoint with no payment → `402 Payment Required`.
2. The 402 body carries `x402Version: 2`, a `resource` object, and an `accepts[]` array with one entry per rail (Solana + Base): `scheme`, `network` (CAIP-2), `amount` (USDC × 1e6), `payTo` (treasury), `asset` (USDC mint/contract), plus `extra`. The USDC amount + treasury addresses are also mirrored in the body.
3. Sign an x402 payment for one `accepts` entry and retry the **same** request with the `X-PAYMENT` header (base64). The legacy `Payment-Signature` header is also accepted. The CLI does all of this automatically.
4. On success your wallet address becomes the resource owner.

Solana payments are verified + settled in-process by a server fee-payer, so you need only USDC (no SOL for gas). Base payments are gasless (EIP-3009 `TransferWithAuthorization`) and settle through a facilitator. Replay is prevented server-side (a lost response replays the resource, not a second charge). Machine-readable discovery: `GET /.well-known/x402` and `GET /openapi.json`.

## Money safety

- **`PALMYR_MAX_USDC`** (env) or **`--max-usdc`** (flag) caps what any single call will sign — the CLI refuses to pay above the ceiling before signing.
- `pay-preflight` checks wallet decrypt (and optionally USDC balance + ATA) before the paid round-trip.
- Transient Solana errors reuse the same payment header if the prior tx may have landed (double-pay guard).

## Refunds

x402 settles **before** the handler runs, so a handler failure after payment triggers an automatic refund: treasury → payer USDC (Solana SPL transfer or Base ERC-20 `transfer`), idempotent per original payment signature, with an hourly retry sweep for any that failed to broadcast. Dashboard-balance payers are refunded to balance instead. **Do not manually re-pay a failed call — check for the refund first.**

## Agent mode (non-TTY)

The CLI auto-detects when stdout isn't a TTY and switches to a machine-parseable contract: clean JSON on stdout, structured `{error, exitCode, hint}` on stderr for failures, no spinners or ANSI. Force it on a TTY with `--json` or `PALMYR_JSON=1`. Streaming commands (`palmyr chat run`) emit **NDJSON** in agent mode — one JSON event per line — so you can `for await` over stdout.

```bash
palmyr compute deploy --type cx23 --json | jq .sshCommand
palmyr compute exec my-vps -- echo hi --json 2>err.log; [ $? -eq 0 ] || cat err.log
```

## Stable exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic failure |
| 2 | Bad input (missing/invalid flag or argument) |
| 3 | Auth failed (bad token/session) |
| 4 | Not found (wallet, server, etc.) |
| 5 | Network unreachable |
| 6 | x402 payment failed |
| 7 | Vault tamper / security check failed — **do not retry** |

## Async ops (202 + poll)

Some routes don't finish inline and return `{ operation_id, poll_url, status, poll_after_seconds }` (or `202`): VPS provision (`/compute/servers/:id`), TikTok ops (`/social/tiktok/operations/:id`, free), account transfers (`/transfers/:id`, 0.0001). **Poll the `poll_url` — never re-send the paid request**, or you pay twice.
