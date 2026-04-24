import { Router, Response, Request } from "express";
import {
  listCapabilities,
  listProviders,
  CAPABILITY_CLASSES,
  type CapabilityClass,
  type I402Provider,
} from "../services/i402-providers";

const router = Router();

// -------------------- Categorization --------------------

interface CapabilityGroup {
  key: string;
  label: string;
  test: (name: string) => boolean;
}

const GROUPS: CapabilityGroup[] = [
  { key: "phone",    label: "Phone",    test: n => /^(provision_phone|release_phone|send_sms|read_sms)$/.test(n) },
  { key: "voice",    label: "Voice",    test: n => /^(start_voice_call|list_calls|get_call_details|voice_)/.test(n) },
  { key: "email",    label: "Email",    test: n => /^(provision_email_inbox|send_email|read_email|list_email_threads|read_email_thread)$/.test(n) },
  { key: "domain",   label: "Domain",   test: n => /^(register_domain|list_domains|get_domain|dns_manage|transfer_domain)/.test(n) },
  { key: "compute",  label: "Compute",  test: n => /^(deploy_vps|list_vps|get_vps|vps_|create_ssh_key|list_ssh_keys|delete_ssh_key|install_skill|install_skills_bulk|remove_skill|configure_openclaw|configure_vps_wallet)$/.test(n) },
  { key: "twitter",  label: "Twitter",  test: n => n.startsWith("twitter_") },
  { key: "tiktok",   label: "TikTok",   test: n => n.startsWith("tiktok_") },
  { key: "keys",     label: "Keys",     test: n => n === "issue_api_key" },
  { key: "compound", label: "Compound", test: n => !!CAPABILITY_CLASSES[n]?.isCompound },
  { key: "dispatch", label: "Dispatch", test: n => n === "social_post" || n === "social_account_provision" },
];

function groupOf(capabilityName: string): CapabilityGroup {
  for (const g of GROUPS) if (g.test(capabilityName)) return g;
  return { key: "other", label: "Other", test: () => true };
}

// Strip the group prefix/suffix so paths read clean:
//  twitter_post  → post
//  voice_speak   → speak
//  provision_phone → provision
//  register_domain → register
function toPathSlug(groupKey: string, capName: string): string {
  const prefix = `${groupKey}_`;
  const suffix = `_${groupKey}`;
  let s = capName;
  if (s.startsWith(prefix)) s = s.slice(prefix.length);
  if (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  return s || capName;
}

// -------------------- HTML helpers --------------------

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPrice(usdc: number): string {
  if (usdc === 0) return "free";
  if (usdc < 0.01) return `$${usdc.toFixed(4)}`;
  return `$${usdc.toFixed(2)}`;
}

function schemaToFields(schema: unknown): Array<{ key: string; value: string }> {
  if (!schema || typeof schema !== "object") return [];
  return Object.entries(schema as Record<string, unknown>).map(([k, v]) => ({
    key: k,
    value: typeof v === "string" ? v : JSON.stringify(v),
  }));
}

// -------------------- Page --------------------

function renderPage(capabilities: CapabilityClass[], providers: I402Provider[]): string {
  const providersByCap = new Map<string, I402Provider[]>();
  for (const p of providers) {
    if (!providersByCap.has(p.capability)) providersByCap.set(p.capability, []);
    providersByCap.get(p.capability)!.push(p);
  }

  type Enriched = { cap: CapabilityClass; group: CapabilityGroup; slug: string; path: string; providers: I402Provider[]; minCost: number; maxCost: number };
  const rows: Enriched[] = capabilities.map(c => {
    const group = groupOf(c.name);
    const slug = toPathSlug(group.key, c.name);
    const ps = providersByCap.get(c.name) ?? [];
    const minCost = ps.length ? Math.min(...ps.map(x => x.costPerCallUsdc)) : 0;
    const maxCost = ps.length ? Math.max(...ps.map(x => x.costPerCallUsdc)) : 0;
    return { cap: c, group, slug, path: `${group.key}/${slug}`, providers: ps, minCost, maxCost };
  });
  rows.sort((a, b) => a.path.localeCompare(b.path));

  const totalCaps = capabilities.length;

  const rowsHtml = rows
    .map(({ cap, group, slug, path, providers: ps, minCost, maxCost }) => {
      const priceLabel =
        ps.length === 0
          ? "—"
          : minCost === maxCost
            ? formatPrice(minCost)
            : `${formatPrice(minCost)}–${formatPrice(maxCost)}`;
      const inputFields = schemaToFields(cap.inputSchema)
        .map(f => `<li><code>${escapeHtml(f.key)}</code><span>${escapeHtml(f.value)}</span></li>`)
        .join("");
      const outputFields = schemaToFields(cap.outputSchema)
        .map(f => `<li><code>${escapeHtml(f.key)}</code><span>${escapeHtml(f.value)}</span></li>`)
        .join("");
      const providerRows = ps
        .map(
          p => `
            <div class="prov">
              <div class="prov-head">
                <code class="prov-id">${escapeHtml(p.id)}</code>
                <span class="prov-cost">${formatPrice(p.costPerCallUsdc)}</span>
              </div>
              <div class="prov-meta">
                <span class="chip chip-rail">${escapeHtml(p.authScheme)}</span>
                <span class="chip">${escapeHtml(p.method)} ${escapeHtml(p.endpoint.replace(/^https?:\/\/[^/]+/, ""))}</span>
              </div>
            </div>`
        )
        .join("");
      const haystack = escapeHtml((path + " " + cap.name + " " + cap.description).toLowerCase());
      return `
<div class="row" data-search="${haystack}">
  <button class="row-main" type="button" aria-expanded="false">
    <span class="row-tool">
      <code class="row-path"><span class="row-ns">${escapeHtml(group.key)}</span><span class="row-sep">/</span>${escapeHtml(slug)}</code>
      <span class="row-desc">${escapeHtml(cap.description)}</span>
    </span>
    <span class="row-price">${priceLabel}</span>
    <svg class="row-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
  </button>
  <div class="row-body" hidden>
    <div class="schemas">
      <div class="schema">
        <h4>Input</h4>
        <ul>${inputFields || "<li><span>—</span></li>"}</ul>
      </div>
      <div class="schema">
        <h4>Output</h4>
        <ul>${outputFields || "<li><span>—</span></li>"}</ul>
      </div>
    </div>
    <div class="cli-hint">
      <span class="hint-label">Try it</span>
      <code>agentos chat run "&lt;natural-language intent&gt;" --budget 10 --execute</code>
    </div>
  </div>
</div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Discover — AgentOS</title>
<meta name="description" content="Every capability AgentOS exposes over x402. ${totalCaps} tools for superagents, no API keys required.">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --accent:#f54900;
  --accent-glow:rgba(245,73,0,.10);
  --bg:#050505;
  --surface:#0a0a0a;
  --surface-2:#0f0f0f;
  --border:rgba(255,255,255,.07);
  --w100:#fff;
  --w80:rgba(255,255,255,.82);
  --w60:rgba(255,255,255,.58);
  --w40:rgba(255,255,255,.38);
  --w20:rgba(255,255,255,.18);
  --w10:rgba(255,255,255,.08);
  --w05:rgba(255,255,255,.04);
  --mono:'JetBrains Mono',ui-monospace,Menlo,monospace;
}
::selection{background:var(--accent);color:#000}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--w100);font:15px/1.55 'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh}
a{color:inherit;text-decoration:none}
code{font-family:var(--mono);font-size:.92em}

.container{max-width:1040px;margin:0 auto;padding:0 clamp(20px,4vw,40px)}

/* Nav */
nav{border-bottom:1px solid var(--border)}
.nav-inner{display:flex;align-items:center;justify-content:space-between;padding:16px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px;letter-spacing:.02em}
.brand-mark{width:26px;height:26px;border-radius:6px;background:var(--accent);display:grid;place-items:center;font-family:var(--mono);font-size:13px;color:#fff;font-weight:700}
.nav-links{display:flex;gap:28px;flex:1;margin-left:36px}
.nav-links a{font-size:12px;color:var(--w60);text-transform:uppercase;letter-spacing:.1em;font-weight:500;transition:color .15s}
.nav-links a:hover{color:var(--w100)}
.nav-links a.active{color:var(--w100)}

/* Hero */
.hero{padding:96px 0 56px;text-align:center;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-240px;left:50%;transform:translateX(-50%);width:1000px;height:560px;background:radial-gradient(ellipse 50% 50%,var(--accent-glow) 0%,transparent 70%);pointer-events:none}
.hero-inner{position:relative}
h1{font-size:clamp(36px,6vw,62px);font-weight:500;letter-spacing:-.035em;line-height:1.03;margin-bottom:22px;background:linear-gradient(180deg,#fff 50%,rgba(255,255,255,.55));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero-sub{font-size:15px;color:var(--w60);max-width:520px;margin:0 auto;line-height:1.65}

/* Controls row */
.controls{padding:32px 0 12px}
.controls-inner{display:flex;align-items:center;gap:12px}
.search{position:relative;flex:1}
.search input{width:100%;height:44px;padding:0 16px 0 42px;background:var(--surface);border:1px solid var(--border);border-radius:10px;color:#fff;font:14px 'Inter',sans-serif;outline:none;transition:border-color .15s,background .15s}
.search input:focus{border-color:var(--accent);background:var(--surface-2)}
.search input::placeholder{color:var(--w40)}
.search-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--w40);pointer-events:none}
.count-pill{padding:0 14px;height:44px;display:inline-flex;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:10px;font:12px var(--mono);color:var(--w60);white-space:nowrap}
.count-pill strong{color:var(--accent);font-weight:600;margin-right:4px}

/* Table */
main{padding:16px 0 120px}
.list{border-top:1px solid var(--border)}
.list-head{display:grid;grid-template-columns:1fr auto 24px;gap:18px;padding:12px 6px;border-bottom:1px solid var(--border);font:10.5px var(--mono);color:var(--w40);text-transform:uppercase;letter-spacing:.12em;font-weight:600}
.list-head .col-price{text-align:right}

.row{border-bottom:1px solid var(--w05)}
.row.hidden{display:none}
.row-main{
  display:grid;
  grid-template-columns:1fr auto 24px;
  gap:18px;
  align-items:center;
  width:100%;
  padding:14px 6px;
  background:transparent;
  border:none;
  color:inherit;
  font:inherit;
  text-align:left;
  cursor:pointer;
  transition:background .1s;
}
.row-main:hover{background:var(--w05)}
.row-tool{display:flex;align-items:baseline;gap:14px;min-width:0;overflow:hidden}
.row-path{font-family:var(--mono);font-size:13.5px;font-weight:500;color:var(--w100);letter-spacing:-.01em;white-space:nowrap;flex-shrink:0}
.row-ns{color:var(--w40);font-weight:400}
.row-sep{color:var(--w40);margin:0 1px}
.row-desc{color:var(--w60);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.row-price{font-family:var(--mono);font-size:13px;color:var(--w80);font-weight:500;white-space:nowrap;text-align:right}
.row-arrow{color:var(--w40);transition:transform .2s,color .2s}
.row-main[aria-expanded="true"]{background:var(--surface)}
.row-main[aria-expanded="true"] .row-arrow{transform:rotate(90deg);color:var(--accent)}
.row-main[aria-expanded="true"] .row-ns{color:var(--accent)}

/* Expanded body */
.row-body{padding:8px 6px 22px;background:var(--surface)}
.row-body[hidden]{display:none}
.schemas{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:6px 0 14px}
.schema h4,.cli-hint .hint-label{font-size:10px;font-weight:600;color:var(--w40);text-transform:uppercase;letter-spacing:.14em;margin-bottom:8px;display:block}
.schema ul{list-style:none;display:grid;gap:4px}
.schema li{display:flex;gap:10px;align-items:baseline;font-size:12.5px;line-height:1.5}
.schema li code{color:var(--accent);font-weight:500;flex-shrink:0}
.schema li span{color:var(--w60)}
.prov{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;margin-bottom:6px}
.prov-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.prov-id{font-size:12px;color:var(--w80);font-weight:500}
.prov-cost{font-family:var(--mono);font-size:11.5px;color:var(--accent);font-weight:600}
.prov-meta{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-block;padding:2px 8px;background:var(--w10);color:var(--w60);font:10.5px var(--mono);border-radius:100px}
.chip-rail{background:rgba(245,73,0,.12);color:var(--accent)}
.cli-hint{margin-top:4px;padding:12px 14px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px}
.cli-hint .hint-label{color:var(--accent);margin-bottom:6px}
.cli-hint code{color:var(--w80);font-size:12px;display:block;word-break:break-all}

/* Empty state */
.empty{padding:60px 0;text-align:center;color:var(--w40);font-size:14px}

/* Footer */
footer{border-top:1px solid var(--border);padding:24px 0;margin-top:40px}
.footer-inner{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--w40)}
.footer-inner a{color:var(--w60);transition:color .15s}
.footer-inner a:hover{color:var(--accent)}
.foot-links{display:flex;gap:18px;flex-wrap:wrap}

@media (max-width:720px){
  .nav-links{display:none}
  .hero{padding:56px 0 32px}
  .row-main{grid-template-columns:1fr auto 20px;gap:10px}
  .row-tool{flex-direction:column;align-items:flex-start;gap:2px}
  .row-desc{max-width:100%}
  .schemas{grid-template-columns:1fr;gap:14px}
}
</style>
</head>
<body>

<nav>
  <div class="container nav-inner">
    <a href="/" class="brand">
      <span class="brand-mark">A</span>
      <span>AgentOS</span>
    </a>
    <div class="nav-links">
      <a href="/">Home</a>
      <a href="/discover" class="active">Discover</a>
      <a href="/docs">Docs</a>
      <a href="https://github.com/0xArtex/AgentOS" target="_blank" rel="noopener">GitHub</a>
    </div>
  </div>
</nav>

<section class="hero">
  <div class="container hero-inner">
    <h1>The best tools<br>handpicked for superagents</h1>
    <p class="hero-sub">No subscriptions, no credits, no API keys. One wallet, every capability, priced in USDC over x402.</p>
  </div>
</section>

<section class="controls">
  <div class="container controls-inner">
    <div class="search">
      <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input id="search" type="search" placeholder="Search tools..." autocomplete="off" spellcheck="false">
    </div>
    <span class="count-pill"><strong id="visible-count">${totalCaps}</strong> / ${totalCaps} tools</span>
  </div>
</section>

<main class="container">
  <div class="list">
    <div class="list-head">
      <span>Tool</span>
      <span class="col-price">Price</span>
      <span></span>
    </div>
    <div id="rows">${rowsHtml}</div>
    <div class="empty" id="empty" hidden>No tools match that search.</div>
  </div>
</main>

<footer>
  <div class="container footer-inner">
    <div>i402 catalog · <a href="/chat/capabilities">capabilities</a> · <a href="/chat/providers">providers</a></div>
    <div class="foot-links">
      <a href="/">Home</a>
      <a href="/docs">Docs</a>
      <a href="https://github.com/0xArtex/AgentOS" target="_blank" rel="noopener">GitHub</a>
    </div>
  </div>
</footer>

<script>
(() => {
  const search = document.getElementById('search');
  const rows = document.getElementById('rows');
  const empty = document.getElementById('empty');
  const visCount = document.getElementById('visible-count');
  const allRows = rows.querySelectorAll('.row');

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    let visible = 0;
    for (const row of allRows) {
      const hay = row.dataset.search || '';
      const match = q === '' || hay.includes(q);
      row.classList.toggle('hidden', !match);
      if (match) visible++;
    }
    empty.hidden = visible > 0;
    visCount.textContent = visible;
  }
  search.addEventListener('input', applyFilter);

  // '/' focuses search, Escape clears or blurs
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== search) {
      e.preventDefault();
      search.focus();
      search.select();
    }
    if (e.key === 'Escape' && document.activeElement === search) {
      if (search.value) { search.value=''; applyFilter(); }
      else search.blur();
    }
  });

  // Expand / collapse row
  rows.addEventListener('click', (e) => {
    const btn = e.target.closest('.row-main');
    if (!btn) return;
    const row = btn.closest('.row');
    const body = row.querySelector('.row-body');
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    body.hidden = open;
  });

  // URL hash → pre-fill search (e.g. /discover#twitter)
  const h = location.hash.replace('#', '');
  if (h) { search.value = h; applyFilter(); }
})();
</script>

</body>
</html>`;
}

// -------------------- Route --------------------

router.get("/", (_req: Request, res: Response) => {
  const capabilities = listCapabilities();
  const providers = listProviders({ enabledOnly: true });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60");
  res.status(200).send(renderPage(capabilities, providers));
});

export default router;
