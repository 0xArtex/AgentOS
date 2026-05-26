# Observability — Metabase over Palmyr's SQLite

Self-hosted Metabase pointed at the live `request_log` (and friends) in `agentos.db`.
Gives us drag-and-drop dashboards over the data we already collect — no new
instrumentation, no SaaS, no events shipped off-box.

## What's already there

The API logs every request to `request_log` via `src/middleware/requestLog.ts`:

| Column             | Notes                                                  |
|--------------------|--------------------------------------------------------|
| `agent_id`         | Anonymous-ish, set by the API per caller               |
| `endpoint`, `method`, `status_code` | Standard HTTP                           |
| `payment_type`     | `'x402'` (paid), `'hackathon'` (free comp), `'free'`   |
| `cost_usdc`        | TEXT — cast to REAL for math                           |
| `response_time_ms` | INTEGER                                                |
| `created_at`       | UTC datetime                                           |

Plus the resource tables (`phone_numbers`, `email_inboxes`, `domains`,
`servers`, `sms_messages`, `email_messages`, `hackathon_usage`, …).

## Local dev

```sh
# from repo root — uses ./data/agentos.db
cd tools/observability
docker compose up -d
```

Open http://localhost:3030 and walk the setup wizard. When asked to connect a
database:

- **Type:** SQLite
- **Display name:** Palmyr
- **Filename:** `/palmyr-data/agentos.db`

That's it — the WAL + SHM files come along via the directory mount.

## Prod (VPS)

```sh
# on the VPS, in this directory
export PALMYR_DATA_DIR=/var/lib/palmyr/data   # same path the API uses
docker compose up -d
```

Don't expose port 3030 to the internet. Reach Metabase from your laptop via
SSH tunnel:

```sh
ssh -L 3030:localhost:3030 user@vps
# then open http://localhost:3030
```

If you ever want it on a public hostname (e.g. `metrics.palmyr.ai`), put it
behind Cloudflare Access or basic auth — Metabase has its own login but the
metrics themselves are sensitive (wallet addresses, payment flow), so add a
second layer.

## Backup

The Metabase metadata (saved questions, dashboards, users) lives in the
`metabase-data` named volume. Back it up periodically:

```sh
docker run --rm -v observability_metabase-data:/data -v $PWD:/backup \
  alpine tar czf /backup/metabase-$(date +%F).tar.gz -C /data .
```

Palmyr's own SQLite is already backed up wherever you back up `PALMYR_DATA_DIR`.

## Bootstrap queries

Paste these in Metabase's SQL editor to get started, then save as questions /
add to a dashboard.

### Daily request volume (last 30 days)
```sql
SELECT date(created_at) AS day, COUNT(*) AS requests
FROM request_log
WHERE created_at > datetime('now', '-30 days')
GROUP BY day
ORDER BY day;
```

### Unique callers per day
```sql
SELECT date(created_at) AS day, COUNT(DISTINCT agent_id) AS unique_agents
FROM request_log
WHERE created_at > datetime('now', '-30 days') AND agent_id IS NOT NULL
GROUP BY day
ORDER BY day;
```

### Free → paid conversion (paying agents over time)
```sql
SELECT date(created_at) AS day,
       COUNT(DISTINCT agent_id) AS paying_agents,
       SUM(CAST(cost_usdc AS REAL)) AS usdc_volume
FROM request_log
WHERE payment_type = 'x402' AND created_at > datetime('now', '-30 days')
GROUP BY day
ORDER BY day;
```

### Top endpoints (last 7 days)
```sql
SELECT endpoint,
       COUNT(*) AS calls,
       ROUND(AVG(response_time_ms)) AS avg_ms,
       SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
       SUM(CASE WHEN payment_type = 'x402' THEN 1 ELSE 0 END) AS paid_calls
FROM request_log
WHERE created_at > datetime('now', '-7 days')
GROUP BY endpoint
ORDER BY calls DESC
LIMIT 25;
```

### Error rate over time
```sql
SELECT date(created_at) AS day,
       ROUND(100.0 * SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) /
             COUNT(*), 2) AS error_pct,
       COUNT(*) AS total_requests
FROM request_log
WHERE created_at > datetime('now', '-30 days')
GROUP BY day
ORDER BY day;
```

### Funnel by command surface (counts agents who touched each)
```sql
WITH surfaces AS (
  SELECT agent_id,
         MAX(CASE WHEN endpoint LIKE '/phone%' THEN 1 ELSE 0 END) AS used_phone,
         MAX(CASE WHEN endpoint LIKE '/email%' THEN 1 ELSE 0 END) AS used_email,
         MAX(CASE WHEN endpoint LIKE '/wallet%' THEN 1 ELSE 0 END) AS used_wallet,
         MAX(CASE WHEN endpoint LIKE '/domain%' THEN 1 ELSE 0 END) AS used_domain,
         MAX(CASE WHEN payment_type = 'x402' THEN 1 ELSE 0 END) AS paid
  FROM request_log
  WHERE agent_id IS NOT NULL
  GROUP BY agent_id
)
SELECT SUM(used_phone) AS phone_users,
       SUM(used_email) AS email_users,
       SUM(used_wallet) AS wallet_users,
       SUM(used_domain) AS domain_users,
       SUM(paid) AS paid_users
FROM surfaces;
```

### Top paying agents (lifetime USDC)
```sql
SELECT agent_id,
       COUNT(*) AS paid_calls,
       ROUND(SUM(CAST(cost_usdc AS REAL)), 2) AS total_usdc,
       MIN(created_at) AS first_seen,
       MAX(created_at) AS last_seen
FROM request_log
WHERE payment_type = 'x402'
GROUP BY agent_id
ORDER BY total_usdc DESC
LIMIT 25;
```

## Caveats

- **SQLite WAL is fine for reads.** Metabase opens the DB read-only via the
  `:ro` mount, so it can never corrupt or lock the live API's writer.
- **Web/CLI/SKILL.md traffic is not in here yet** — those land in later PRs
  (Plausible + CLI telemetry + API-served skill). This dashboard covers the
  API surface only.
- **Don't change `journal_mode`.** Metabase will try to honor `WAL` reads,
  not switch the mode. If you ever see "attempt to write a readonly database"
  in logs, it's a connector misconfiguration — re-check the `:ro` mount.
