# Palmyr docs

Public knowledge base for [Palmyr](https://palmyr.ai), built with [Mintlify](https://mintlify.com).

## Preview locally

```bash
cd docs
npm i -g mint
mint dev
```

Opens a live preview at `http://localhost:3000`. Run `mint broken-links` to check internal links.

## Deploy

Connect this repository in the [Mintlify dashboard](https://dashboard.mintlify.com) (or install the Mintlify GitHub app) and set the **content directory to `docs`**. Every push to the docs then deploys automatically. Point a custom domain (e.g. `docs.palmyr.ai`) at it from the dashboard.

## Structure

```
docs/
  docs.json              navigation, theme, branding
  introduction.mdx       what Palmyr is
  quickstart.mdx         install -> wallet -> first paid action
  for-agents.mdx         JSON output, x402 loop, exit codes, SDK
  concepts/              how it works, payments (x402), wallets
  services/              trading, phone, email, compute, domains, twitter, tiktok
  security/              model, permissions, privacy
  pricing.mdx            per-action price tables
  reference/             cli (command index), api (x402 wire protocol)
  logo/                  light.svg, dark.svg
  favicon.svg
```

## Branding

- Accent: gold `#a89774`
- Background (dark): teal `#112d32`
- Logos derive from `public/assets/logo-horizontal.svg`; `logo/dark.svg` is the white-fill variant for the dark theme.

The `background.color` key in `docs.json` sets the teal page background. If your Mintlify version flags it, remove that block — the gold accent and dark appearance are unaffected.

## Agent-readable

Mintlify auto-generates `/llms.txt` and `/llms-full.txt` and serves clean Markdown per page, so AI agents can consume the docs directly. Keep each page's `description` frontmatter accurate — it feeds search and `llms.txt`.

## Source of truth

Commands and prices are mirrored from `cli/README.md` (the canonical CLI reference). When the CLI changes, update the matching service page, `reference/cli.mdx`, and `pricing.mdx`.

> Note: `docs/API.md` is the older raw API spec and predates this site. Its pricing is stale — `reference/api.mdx` and `reference/cli.mdx` supersede it. Delete or fold it in when convenient.
