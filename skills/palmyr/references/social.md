> Fetch this when buying/importing an X or TikTok account, posting, or transferring/sharing/disputing one.

# Palmyr — Social (X/Twitter + TikTok)

## X / Twitter — CLI

```bash
palmyr twitter buy                                       # Buy a ready X account ($5 default; per-country pricing if --country is set)
palmyr twitter buy --country GB                          # Filter by RESIDENCY (X "Account based in"). Price = country_prices.GB
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
```

### Hand off / share an X account between wallets (owner-only)

Imported-only accounts are auto-registered with the server on the first transfer (~$0.01 USDC, transparent), so the receiver wallet can claim them — no separate `register` step.

```bash
palmyr twitter transfer <username> --to <wallet> --confirm   # Rotates password + revokes other sessions, then flips ownership. Server returns transfer_id immediately; CLI polls /transfers/:id every 5s until completed (rotation runs ~30-90s). Local copy wiped on success.
palmyr twitter share <username> --with <wallet>              # Grant shared access (same login, no rotation)
palmyr twitter unshare <username> --from <wallet> [--rotate] # Revoke a share. --rotate also rotates the password so revoked cookies stop working (async, polled like transfer).
palmyr twitter list [--local]                               # Local vault PLUS server-only accounts the wallet owns or was shared (hints to `claim`). --local skips the server check.
palmyr twitter claim                                        # Pull every server-side X account the wallet can access into the local vault.
```

**Auto-import on use:** any command above (post, like, info, totp, …) that targets an account the wallet can access server-side but doesn't have locally will auto-import on first call. A just-transferred/shared account can run `palmyr twitter post @h "gm"` directly — no separate `claim`.

### Two paths to a working X account

1. **Buy from the pool** — `POST /social/twitter/buy` ($5 USDC). Returns a ready account: handle, encrypted credentials, captured cookies, and a `proxy_session_id` that pins a sticky residential IP. The CLI auto-imports it; post immediately.
2. **Bring your own** — `POST /social/twitter/login` ($0.005). Send credentials (or pre-captured `auth_token` + `ct0` cookies); the server logs in via Playwright stealth through your `proxy_session_id` IP, returning a 12h cookie session.

Every op sends `account_id` + `cookies` + optional `proxy_session_id`; the server reuses the same residential IP that first logged in, so X never sees a geography change. Success is verified at the network layer (the server reads X's actual `CreateTweet` / `FavoriteTweet` / `update_profile` response) — no false positives.

## TikTok — CLI

DIRECT browser automation (no paid upstream). Sessions come from a real browser login.

```bash
palmyr tiktok connect <username> [--tag <folder>]   # DEFAULT: prints a clean /connect link (in qr_link) the human opens + scans with the TikTok app on their phone. Zero install, auto-refreshes (~15 min), captured on confirm.
palmyr tiktok connect <username> --local            # Open the browser on THIS machine and log in here (a desktop with a human present).
palmyr tiktok import <username> --sessionid <s> --csrf <c> --webid <w> --country <iso2>   # BYO cookies (free)
palmyr tiktok import <username> --credentials-line "login:pw:email:email_pw" --country us # Marketplace line (free; local vault only)
palmyr tiktok login <username>                      # Validate cookies + cache the session ($0.02)
palmyr tiktok session <username>                    # Check cached session — flags stale >12h (free)
palmyr tiktok post <username> --file video.mp4 --caption "..." [--privacy 0|1|2]           # Post a video; privacy 0 public · 1 friends · 2 private (default public) ($0.01)
palmyr tiktok schedule <username> --at 2026-06-03T18:00:00Z --file v.mp4 --caption "..."   # TikTok's native scheduler, ~15 min–10 days out (same price as post)
```

### Human-in-the-loop (draft → approve → post → audit log)

```bash
palmyr tiktok draft <username> --file v.mp4 --caption "..." [--privacy 0|1|2] [--at <iso>]   # Stage for approval; does NOT publish (free). --at makes approve schedule it.
palmyr tiktok drafts [<username>] [--tag <folder>]   # List drafts awaiting approval (free)
palmyr tiktok approve <draft-id>                     # Publish a queued draft + record it in the post log (charges the post price)
palmyr tiktok reject <draft-id>                      # Discard a queued draft (free)
palmyr tiktok logs [<username>] [--tag <folder>] [--limit N]   # Audit log — approved drafts + direct posts (free)
```

### Self-learning loop + engagement + management

```bash
palmyr tiktok analytics <username>       # Scrape per-post views/likes/comments, tier vs the account's OWN posts, snapshot time-series ($0.005; free self-hosted)
palmyr tiktok review <username>          # Performance review — best/worst, tier mix, avg engagement, trend (free, local store)
palmyr tiktok monitor start --every 6h [--account a,b]   # Unattended periodic analytics. Also: tick | stop | status (free locally)
palmyr tiktok follow <username> --user @handle   # Follow ($0.001)
palmyr tiktok like <username> --video <url>       # Like a video ($0.001)
palmyr tiktok delete <username> --video <url>     # Delete a post via TikTok Studio ($0.001)
palmyr tiktok bio <username> --text "..."         # Update bio, <=80 chars ($0.001)
palmyr tiktok name <username> --display "..."     # Update display name, <=30 chars ($0.001). TikTok rate-limits nickname changes to ~once/week.
palmyr tiktok pfp <username> --file pic.png       # Update avatar ($0.005)
palmyr tiktok list [--tag <folder>]               # All local TikTok accounts; --tag filters to one folder (free)
palmyr tiktok tag <username> <folder>             # File an account under a folder-like tag; --clear removes it (free)
palmyr tiktok info|rename|remove|totp <username>  # Local account management (free)
```

## API — X / Twitter

| Action | Endpoint | Cost (USDC) |
|---|---|---|
| Buy account from pool | `POST /social/twitter/buy` | dynamic (`country_price × source_multiplier`; base 5.00) |
| Login (capture cookies) | `POST /social/twitter/login` | 0.005 |
| Post tweet | `POST /social/twitter/post` | 0.001 |
| Reply / Like / Retweet / Follow / Unfollow / Delete | `POST /social/twitter/{reply,like,retweet,follow,unfollow,delete}` | 0.001 |
| Update profile (bio/name/location/website) | `POST /social/twitter/profile` | 0.001 |
| Update avatar / banner (async: `202 {operation_id}` → poll `GET /social/twitter/operations/:id`; result carries the resulting `avatar_url`/`banner_url`) | `POST /social/twitter/{avatar,banner}` | 0.005 |
| Change username | `POST /social/twitter/username` | 0.005 |
| Dispute a bought account | `POST /social/twitter/dispute` (or `palmyr twitter dispute`) | 0.01 (ownership proof) |

**Transfer / share (async, ownership-proof, ~$0.01 each).** Pool accounts use `/x/accounts/:id/*`; BYO ("registered") use `/social/twitter/registered/:id/*`; pool-bought use `/social/twitter/pool/:id/*`. Transfers return `202 { transfer_id }`; poll `GET /transfers/:transfer_id` (0.0001, scoped to from/to wallet — ~6–18 polls at 5s). `unshare` bodies accept `{ wallet, rotate? }` (`rotate:true` also rotates the password). List what you own/were shared: `GET /x/accounts/mine`, `GET /social/twitter/registered/mine`, `GET /social/twitter/pool/mine`.

## API — TikTok

| Action | Endpoint | Cost (USDC) |
|---|---|---|
| Host login QR | `POST /social/tiktok/qr` | Free |
| Login (validate + cache cookies) | `POST /social/tiktok/login` | 0.02 |
| Post video (add `schedule_at` for native scheduler) | `POST /social/tiktok/post` | 0.01 |
| Follow / Like / Delete | `POST /social/tiktok/{follow,like,delete}` | 0.001 |
| Update profile (bio / display name) | `POST /social/tiktok/profile` | 0.001 |
| Update avatar | `POST /social/tiktok/avatar` | 0.005 |

**Async:** TikTok post/login and some transfers return `202` + a `poll_url` (`/social/tiktok/operations/:id`, free, 122-bit unguessable id). Poll it — never re-send the paid request.
