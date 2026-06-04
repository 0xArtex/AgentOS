// Palmyr Connect — reads the logged-in TikTok session from this browser and
// posts it to the agent's connect endpoint. The human logs into the REAL
// tiktok.com (no proxy, no streamed browser, no anti-bot to fight); this just
// hands the resulting session to the agent the human is connecting it to.
const $ = (id) => document.getElementById(id);

// chrome.cookies sameSite → the Playwright-injectable values the server expects.
const SAMESITE = { no_restriction: "None", lax: "Lax", strict: "Strict" };

function mapCookie(c) {
  const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || "/" };
  if (typeof c.expirationDate === "number") out.expires = Math.floor(c.expirationDate);
  if (typeof c.httpOnly === "boolean") out.httpOnly = c.httpOnly;
  if (typeof c.secure === "boolean") out.secure = c.secure;
  const ss = SAMESITE[c.sameSite];
  if (ss) out.sameSite = ss;
  return out;
}

$("go").addEventListener("click", async () => {
  const status = $("status");
  const url = $("code").value.trim();
  status.className = "";
  status.textContent = "";

  // The connect code is the exact callback URL the agent printed.
  if (!/^https?:\/\/.+\/connect\/[a-f0-9]{8,}\/session$/.test(url)) {
    status.className = "err";
    status.textContent = "That doesn't look like a connect code. Paste the exact code your agent gave you.";
    return;
  }

  $("go").disabled = true;
  status.textContent = "Reading your TikTok session…";
  try {
    // chrome.cookies returns HttpOnly cookies too (incl. sessionid), unlike document.cookie.
    const cookies = await chrome.cookies.getAll({ domain: "tiktok.com" });
    const mapped = cookies.map(mapCookie);
    const hasSession = mapped.some((c) => c.name === "sessionid" && c.value && c.value.length > 10);
    if (!hasSession) {
      status.className = "err";
      status.textContent = "No TikTok session found. Log in to tiktok.com in this browser first, then try again.";
      $("go").disabled = false;
      return;
    }
    status.textContent = "Sending to your agent…";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: mapped }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error("server " + res.status + (t ? " " + t.slice(0, 140) : ""));
    }
    const j = await res.json().catch(() => ({}));
    status.className = "ok";
    status.textContent = "✓ Connected — sent " + (j.count || mapped.length) + " cookies. You can close this tab.";
  } catch (e) {
    status.className = "err";
    status.textContent = "Failed: " + (e && e.message ? e.message : String(e));
    $("go").disabled = false;
  }
});
