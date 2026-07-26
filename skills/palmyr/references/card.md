> Fetch this when buying a prepaid Visa card, retrieving its number/CVV, or checking its balance.

# Palmyr — Prepaid Visa Cards

Buy a **USA prepaid Visa card loaded with exactly the balance you ask for** ($5–$1000). One x402 payment covers the card + fee; the card number, CVV, and expiry are ready ~10 seconds later. Use it at any US online checkout that accepts Visa prepaid — the escape hatch for everything that is credit-card gated.

**Card facts (read before buying):**
- **US merchants only**, priced in USD. Physical goods must ship to a US address.
- **Non-reloadable**: one load, then spend across any number of transactions until depleted. Order the exact amount a checkout needs (total incl. tax/shipping) to avoid leftovers.
- Works with Apple Pay / Google Pay adds.
- Issued via Laso Finance (FinCEN-registered MSB). **Each agent gets its own isolated issuer account** — a dedicated payer wallet created automatically on first purchase — so one agent's activity never affects another's. Palmyr stores the card encrypted, recoverable by your wallet.

## CLI

```bash
palmyr card buy --amount 20        # Buy a $20 card (pays 20.60: amount + 3% fee, min $0.50)
palmyr card buy --amount 20 --no-wait   # Return the operation handle immediately
palmyr card list                   # Your cards: status, last4, balance ($0.01)
palmyr card get --id <card_id>     # Full number / CVV / expiry ($0.01, owner-only)
palmyr card refresh --id <card_id> # Live balance + transactions ($0.01)
```

## API

| Action | Endpoint | Cost (USDC) |
|---|---|---|
| Buy a card | `POST /cards/buy` `{ amount }` | dynamic: `amount + max(3%, $0.50)` — exact total in the 402 challenge |
| Poll the purchase | `GET /cards/operations/:id` | Free |
| List your cards | `GET /cards` | 0.01 (ownership proof) |
| Card number / CVV / expiry | `GET /cards/:id` | 0.01 (ownership proof, owner-only) |
| Live balance + transactions | `POST /cards/:id/refresh` | 0.01 (issuer re-scrape is rate-limited to 1/5min per card) |

## Flow

1. `POST /cards/buy {"amount": 20}` unpaid → **402** whose challenge asks exactly **20.60 USDC** (Base or Solana).
2. Pay and retry → **202** `{ operation_id, card_id, poll_url, poll_after_seconds }`. Payment is captured — **do not resubmit**; failures auto-refund.
3. Poll `GET /cards/operations/:id` (free, every ~3s) until `done: true`.
   - `status: "ready"` → fetch `GET /cards/:id` for `{ card_number, exp_month, exp_year, cvv, billing_address }` + balance.
   - `status: "failed"` → `refund_status` shows the automatic refund (`sent` = your USDC is on its way back).
4. Spend. Check remaining balance any time via `POST /cards/:id/refresh` (returns the issuer's transaction list too).

## Billing address

Checkouts ask for a billing address (or just a ZIP) far more often than not, so `GET /cards/:id` returns one with the card:

```json
"billing_address": {
  "name": "Laso Finance", "line_1": "440 N Barranca Avenue", "line_2": "#4496",
  "city": "Covina", "state": "CA", "zip": "91723", "country": "US", "required": false
}
```

- The billing **name is always `Laso Finance`**, not your agent or wallet — the card is issued to the issuer. There is no way to register your own name or address on the card.
- On these U.S. cards AVS is **not** pinned to it (`required: false`), so any valid U.S. address also clears — but this one is the known-good default, so use it unless you have a real U.S. address of your own.
- Shipping is separate: a physical order still ships to whatever U.S. address you enter.

## Limits & gotchas

- Per card: **$5 minimum, $1000 maximum**, whole cents.
- Rolling-24h issuance ceilings apply (per-wallet and platform-wide) — a `429` with `error_code: daily_agent | daily_agent_cards | daily_global` means wait for the window to roll; your wallet is NOT charged on a 429. The count ceiling (default **6 cards per agent per day**) mirrors the issuer's own per-account limit.
- A `503 issuer_float_low` means the operator's card float is being topped up — retry after `retry_after_seconds`; you were not charged.
- The free poll never returns the card number; only the owner-verified `GET /cards/:id` does.
- Card details are recoverable: they're stored encrypted server-side and any later `GET /cards/:id` from the owner wallet returns them again.
