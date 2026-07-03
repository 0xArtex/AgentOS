> Fetch this when checking, pricing, registering, or sharing a domain.

# Palmyr — Domains

## CLI

```bash
palmyr domain check --name example.dev    # Check availability (free)
palmyr domain pricing --name example      # Get pricing (free)
palmyr domain buy --name example.dev      # Register (dynamic price, ~25% markup)
palmyr domain list                        # Owned + shared
palmyr domain transfer-ownership --name example.dev --to <wallet>   # Hand domain to another wallet
palmyr domain share --name example.dev --with <wallet>              # Grant another wallet DNS-edit access
palmyr domain unshare --name example.dev --from <wallet>
```

## API

| Action | Endpoint | Cost (USDC) |
|---|---|---|
| Check availability | `GET /domains/check?domain=example.com` | Free |
| TLD pricing | `GET /domains/pricing?domain=example` | Free |
| Register domain | `POST /domains/register` | dynamic (per-TLD, ~25% markup; exact amount in the 402 challenge) |
| List your domains (owner + shared) | `GET /domains` | 0.01 (ownership proof) |
| DNS records | `GET /domains/:domain/dns` | 0.01 (ownership proof) |
| Update DNS | `POST /domains/:domain/dns` | 0.01 (ownership proof; shared wallets allowed) |
| Transfer ownership | `POST /domains/:domain/transfer-ownership` | 0.01 (ownership proof; clears `shared_with`) |
| Share with a wallet | `POST /domains/:domain/share` | 0.01 (ownership proof; owner-only) |
| Revoke a shared wallet | `POST /domains/:domain/unshare` | 0.01 (ownership proof; owner-only) |
