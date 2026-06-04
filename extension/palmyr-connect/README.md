# Palmyr Connect

A tiny browser extension that connects a logged-in TikTok session to your Palmyr
agent. The human logs in to the **real tiktok.com** in their own browser — no
proxy, no streamed remote browser, no anti-bot to fight — and this hands the
resulting session to the agent.

## Why this exists

To run TikTok ops, the agent needs the account's web session (the HttpOnly
`sessionid` cookie). That cookie can only be read from the browser that's logged
in. This extension reads it (via the `chrome.cookies` API, which can see HttpOnly
cookies) and posts it to the agent's one-time, token-scoped connect endpoint.

It's first-party and consensual: you only ever paste a connect code that **your
own agent** gave you, for an account **you** are logging into.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `palmyr-connect/` folder.

Works in Chrome, Edge, Brave — any Chromium browser.

## Use

1. Your agent runs `palmyr tiktok connect <username>` and prints a **connect code**
   (a URL ending in `/connect/<token>/session`) plus a link.
2. Log in to **tiktok.com** normally in this browser.
3. Click the **Palmyr Connect** toolbar icon, paste the connect code, click
   **Connect TikTok account**.
4. The agent captures the session automatically and saves it. Done.

Nothing is stored by the extension — it reads the session once, posts it to the
code you pasted, and forgets it. The connect code is single-use and expires in
~15 minutes.

## Permissions

- `cookies` + tiktok.com host access — to read the session cookies.
- broad host access — to POST the session to your agent's API (which can be any
  host, since you self-host). The extension only ever sends to the exact connect
  code you paste.
