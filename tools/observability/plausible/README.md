# Plausible — web analytics for palmyr.ai

Self-hosted [Plausible Community Edition](https://github.com/plausible/community-edition).
Privacy-friendly pageview tracking, no cookies, no PII. Lives on the VPS,
reached over a Cloudflare Tunnel.

## Why self-host

The Palmyr brand is "no accounts, no API keys, no monthly bills." Shipping
visitor data to Google Analytics or Plausible Cloud would contradict that.
Self-hosted CE keeps the data on the same VPS as the rest of Palmyr.

## What's tracked

Pageviews, referrers, UTM tags, browser/OS, country (from IP, then IP is
discarded). Nothing else by default. No fingerprinting, no cookies, no
visitor IDs across sessions.

The tracking snippet lives in:
- `public/index.html`
- `public/dashboard.html`
- `public/templates.html`
- `public/discovery/index.html`

To add to a new page: paste this in `<head>`:

```html
<script defer data-domain="palmyr.ai" src="https://plausible.palmyr.ai/js/script.js"></script>
```

## Setup (one-time, on the VPS)

```sh
# 1. Bring secrets into .env
cp .env.example .env
# Edit .env — generate SECRET_KEY_BASE with:
#   openssl rand -base64 48
# Confirm BASE_URL matches the public hostname you'll serve from.

# 2. Boot
docker compose up -d

# 3. First-run wizard — register the admin user.
# Plausible's admin UI is at http://localhost:8000 — but it's bound to
# localhost only. Tunnel from your laptop first:
ssh -L 8000:localhost:8000 user@vps
# then open http://localhost:8000 in your browser, register, lock down
# DISABLE_REGISTRATION=invite_only in .env, restart.

# 4. Add the "palmyr.ai" site in the Plausible UI.
# Plausible only accepts events for sites it knows about — without this,
# the tracking snippet hits the API but gets silently rejected.
```

## DNS + Tunnel

The snippet on `palmyr.ai` references `https://plausible.palmyr.ai/js/script.js`,
so you need that hostname resolving to the VPS over your Cloudflare Tunnel.

In your `cloudflared` config (alongside the route for the main API), add:

```yaml
ingress:
  - hostname: plausible.palmyr.ai
    service: http://localhost:8000
  - hostname: palmyr.ai
    service: http://localhost:3001
  - service: http_status:404
```

Then `cloudflared tunnel route dns <tunnel-name> plausible.palmyr.ai` and
restart cloudflared.

## CSP

The API's `src/middleware/security.ts` includes `https://plausible.palmyr.ai`
in `scriptSrc` and `connectSrc` so the tracker can load and report. If you
move Plausible to a different hostname, update both places.

## Backup

```sh
# Postgres (admin users, site config)
docker exec palmyr-plausible-db pg_dump -U postgres plausible_db | gzip > plausible-db-$(date +%F).sql.gz

# ClickHouse (events) — clickhouse-backup or just dump volumes
docker run --rm -v plausible_event-data:/data -v $PWD:/backup \
  alpine tar czf /backup/plausible-events-$(date +%F).tar.gz -C /data .
```

## Common issues

- **"Site not found" in Plausible UI** — you didn't add `palmyr.ai` as a site
  after first-run wizard. No site, no accepted events.
- **CSP violations in browser console** — the API restarted but with stale CSP
  config that doesn't list `plausible.palmyr.ai`. Confirm the deployed
  `security.ts` matches the repo.
- **Empty dashboard** — check Plausible's own logs (`docker logs palmyr-plausible`);
  most often DNS or BASE_URL mismatch between .env and what visitors hit.
- **Plausible container crash-loops with `AUTHENTICATION_FAILED` against
  ClickHouse** — you're on a ClickHouse image tag newer than 24.3.x. Pin
  `plausible_events_db.image` back to `clickhouse/clickhouse-server:24.3.3.42-alpine`,
  then `docker compose down -v && docker compose up -d` (the `-v` wipes the
  half-initialised event volume so the older image can re-create it cleanly).
