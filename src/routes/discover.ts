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
  key: string;         // used as path prefix (e.g. "phone" → phone/send_sms)
  label: string;
  description: string;
  test: (name: string) => boolean;
}

const GROUPS: CapabilityGroup[] = [
  { key: "phone",    label: "Phone & SMS",       description: "Real numbers, send / receive SMS.",                   test: n => /^(provision_phone|release_phone|send_sms|read_sms)$/.test(n) },
  { key: "voice",    label: "Voice",             description: "Outbound calls, TTS, DTMF, recording, transfer.",     test: n => /^(start_voice_call|list_calls|get_call_details|voice_)/.test(n) },
  { key: "email",    label: "Email",             description: "E2E-encrypted inboxes plus send / read / threads.",   test: n => /^(provision_email_inbox|send_email|read_email|list_email_threads|read_email_thread)$/.test(n) },
  { key: "domain",   label: "Domain",            description: "Register, list, transfer, manage DNS.",               test: n => /^(register_domain|list_domains|get_domain|dns_manage|transfer_domain)/.test(n) },
  { key: "compute",  label: "Compute",           description: "VPS lifecycle, SSH keys, agent skills.",              test: n => /^(deploy_vps|list_vps|get_vps|vps_|create_ssh_key|list_ssh_keys|delete_ssh_key|install_skill|install_skills_bulk|remove_skill|configure_openclaw|configure_vps_wallet)$/.test(n) },
  { key: "twitter",  label: "Twitter / X",       description: "Post, reply, like, follow, update profile.",           test: n => n.startsWith("twitter_") },
  { key: "tiktok",   label: "TikTok",            description: "Login, post videos, follow, like, profile.",          test: n => n.startsWith("tiktok_") },
  { key: "keys",     label: "API Keys",          description: "Issue wallet-scoped keys for third-party services.",  test: n => n === "issue_api_key" },
  { key: "compound", label: "Compound",          description: "End-to-end goals that expand into multi-step plans.", test: n => !!CAPABILITY_CLASSES[n]?.isCompound },
  { key: "dispatch", label: "Platform Dispatch", description: "Multi-platform wrappers (social_post, social_account_provision).", test: n => n === "social_post" || n === "social_account_provision" },
];

function groupOf(capabilityName: string): CapabilityGroup {
  for (const g of GROUPS) if (g.test(capabilityName)) return g;
  return { key: "other", label: "Other", description: "", test: () => true };
}

// Strip the group prefix from a capability name so the path is clean.
// phone + send_sms        → phone/send_sms (no prefix, kept as-is)
// voice + voice_speak     → voice/speak
// twitter + twitter_post  → twitter/post
function toPathSlug(groupKey: string, capName: string): string {
  const prefix = `${groupKey}_`;
  const short = capName.startsWith(prefix) ? capName.slice(prefix.length) : capName;
  return short;
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

  type EnrichedCap = { cap: CapabilityClass; group: CapabilityGroup; providers: I402Provider[]; minCost: number; maxCost: number; slug: string };
  const enriched: EnrichedCap[] = capabilities.map(c => {
    const group = groupOf(c.name);
    const ps = providersByCap.get(c.name) ?? [];
    const minCost = ps.length ? Math.min(...ps.map(x => x.costPerCallUsdc)) : 0;
    const maxCost = ps.length ? Math.max(...ps.map(x => x.costPerCallUsdc)) : 0;
    return { cap: c, group, providers: ps, minCost, maxCost, slug: toPathSlug(group.key, c.name) };
  });

  // Bucket by group, keeping declared order
  const byGroup = new Map<string, EnrichedCap[]>();
  for (const g of GROUPS) byGroup.set(g.key, []);
  for (const e of enriched) {
    if (!byGroup.has(e.group.key)) byGroup.set(e.group.key, []);
    byGroup.get(e.group.key)!.push(e);
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.slug.localeCompare(b.slug));

  const totalCaps = capabilities.length;
  const totalProviders = providers.length;
  const totalGroups = Array.from(byGroup.values()).filter(list => list.length > 0).length;

  const groupsHtml = GROUPS.concat([{ key: "other", label: "Other", description: "", test: () => false }])
    .map(g => {
      const rows = byGroup.get(g.key) ?? [];
      if (rows.length === 0) return "";
      const rowsHtml = rows
        .map(({ cap, group, providers: ps, minCost, maxCost, slug }) => {
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
                    ${p.p50LatencyMs ? `<span class="chip chip-dim">p50 ${p.p50LatencyMs}ms</span>` : ""}
                    <span class="chip chip-dim">rep ${p.reputationScore.toFixed(2)}</span>
                  </div>
                  ${p.description ? `<div class="prov-desc">${escapeHtml(p.description)}</div>` : ""}
                </div>`
            )
            .join("");
          const haystack = escapeHtml((slug + " " + cap.name + " " + cap.description).toLowerCase());
          return `
<div class="row" data-search="${haystack}">
  <button class="row-main" type="button" aria-expanded="false">
    <code class="row-path"><span class="row-ns">${escapeHtml(group.key)}</span><span class="row-sep">/</span>${escapeHtml(slug)}</code>
    <span class="row-desc">${escapeHtml(cap.description)}</span>
    <span class="row-price">${priceLabel}</span>
    <span class="row-prov">${ps.length} ${ps.length === 1 ? "provider" : "providers"}</span>
    ${cap.isCompound ? '<span class="row-badge">compound</span>' : ""}
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
    <div class="provs">
      <h4>Providers</h4>
      ${providerRows || '<div class="prov-empty">No provider registered yet.</div>'}
    </div>
    <div class="cli-hint">
      <span class="hint-label">Try it</span>
      <code>agentos chat run "&lt;natural-language intent&gt;" --budget 10 --execute</code>
    </div>
  </div>
</div>`;
        })
        .join("");
      return `
<section class="group" data-group="${escapeHtml(g.key)}">
  <header class="group-head">
    <h2 class="group-name">${escapeHtml(g.label)}</h2>
    <span class="group-count">${rows.length}</span>
    ${g.description ? `<p class="group-desc">${escapeHtml(g.description)}</p>` : ""}
  </header>
  <div class="group-list">
    ${rowsHtml}
  </div>
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Discover — AgentOS i402 Capability Catalog</title>
<meta name="description" content="Every capability AgentOS exposes over x402. ${totalCaps} capabilities, ${totalProviders} providers.">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --accent:#f54900;
  --accent-dim:rgba(245,73,0,.65);
  --accent-glow:rgba(245,73,0,.14);
  --bg:#050505;
  --surface:#0a0a0a;
  --surface-2:#101010;
  --border:rgba(255,255,255,.08);
  --border-strong:rgba(255,255,255,.14);
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
body::after{content:'';position:fixed;inset:0;pointer-events:none;z-index:100;opacity:.012;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
a{color:inherit;text-decoration:none}
code{font-family:var(--mono);font-size:.92em}

.container{max-width:1080px;margin:0 auto;padding:0 clamp(20px,4vw,40px)}

/* Nav */
nav{position:sticky;top:0;z-index:50;background:rgba(5,5,5,.85);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
.nav-inner{display:flex;align-items:center;justify-content:space-between;padding:14px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px;letter-spacing:-.01em}
.brand-mark{width:24px;height:24px;border-radius:6px;background:var(--accent);display:grid;place-items:center;font-family:var(--mono);font-size:12px;color:#fff;font-weight:700}
.nav-links{display:flex;gap:22px}
.nav-links a{font-size:13px;color:var(--w60);transition:color .2s}
.nav-links a:hover{color:var(--w100)}
.nav-links a.active{color:var(--accent)}

/* Hero */
.hero{padding:64px 0 28px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:900px;height:500px;background:radial-gradient(ellipse 50% 50%,var(--accent-glow) 0%,transparent 70%);pointer-events:none}
.hero-inner{position:relative}
.hero-badge{display:inline-flex;align-items:center;gap:8px;padding:5px 12px;background:rgba(245,73,0,.09);border:1px solid rgba(245,73,0,.22);border-radius:100px;font-size:11.5px;color:var(--accent);margin-bottom:18px;font-weight:500;text-transform:uppercase;letter-spacing:.08em}
.hero-badge::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--accent);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
h1{font-size:clamp(32px,4.2vw,44px);font-weight:500;letter-spacing:-.03em;line-height:1.06;margin-bottom:14px;background:linear-gradient(180deg,#fff 40%,rgba(255,255,255,.55));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero-sub{font-size:15.5px;color:var(--w80);max-width:620px;line-height:1.6;margin-bottom:22px}
.hero-stats{display:flex;flex-wrap:wrap;gap:18px 28px;font-size:13px;color:var(--w60)}
.hero-stats strong{color:var(--accent);font-family:var(--mono);font-weight:600;font-size:14px;margin-right:4px}

/* Search bar */
.search-wrap{padding:20px 0;border-bottom:1px solid var(--border);position:sticky;top:57px;z-index:40;background:rgba(5,5,5,.9);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
.search{position:relative}
.search input{width:100%;height:44px;padding:0 16px 0 44px;background:var(--surface);border:1px solid var(--border);border-radius:10px;color:#fff;font:14.5px 'Inter',sans-serif;transition:border-color .15s,background .15s;outline:none}
.search input:focus{border-color:var(--accent);background:var(--surface-2)}
.search input::placeholder{color:var(--w40)}
.search-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--w40);pointer-events:none}
.search-clear{position:absolute;right:10px;top:50%;transform:translateY(-50%);padding:4px 10px;background:var(--w10);color:var(--w60);border:none;border-radius:100px;font:11.5px var(--mono);cursor:pointer;display:none}
.search-clear:hover{background:var(--w20);color:#fff}
.search.has-query .search-clear{display:inline-block}

main{padding:28px 0 120px}

/* Group section */
.group{margin-bottom:40px}
.group.hidden{display:none}
.group-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:10px;margin-bottom:4px;border-bottom:1px solid var(--border)}
.group-name{font-size:14px;font-weight:600;color:#fff;letter-spacing:-.01em;text-transform:uppercase;letter-spacing:.08em}
.group-count{font:11.5px var(--mono);color:var(--w40);font-weight:500}
.group-desc{flex-basis:100%;font-size:13px;color:var(--w60);margin-top:2px}

/* Row (capability list item) */
.group-list{}
.row{border-bottom:1px solid var(--w05);transition:background .1s}
.row.hidden{display:none}
.row:hover{background:var(--w05)}
.row-main{
  display:grid;
  grid-template-columns:minmax(210px,30%) 1fr auto auto auto;
  gap:18px;
  align-items:center;
  width:100%;
  padding:13px 6px;
  background:transparent;
  border:none;
  color:inherit;
  font:inherit;
  text-align:left;
  cursor:pointer;
}
.row-path{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--w100);letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-ns{color:var(--accent)}
.row-sep{color:var(--w40);margin:0 1px}
.row-desc{color:var(--w60);font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-price{font-family:var(--mono);font-size:12.5px;color:var(--w80);font-weight:500;white-space:nowrap}
.row-prov{font-family:var(--mono);font-size:11.5px;color:var(--w40);white-space:nowrap}
.row-badge{font-family:var(--mono);font-size:10.5px;padding:2px 7px;background:rgba(245,73,0,.14);color:var(--accent);border-radius:100px;font-weight:500;text-transform:uppercase;letter-spacing:.04em}
.row-arrow{color:var(--w40);transition:transform .2s,color .2s;flex-shrink:0}
.row-main[aria-expanded="true"]{background:var(--surface)}
.row-main[aria-expanded="true"] .row-arrow{transform:rotate(90deg);color:var(--accent)}
.row-main[aria-expanded="true"] .row-path{color:var(--accent)}

/* Row expanded body */
.row-body{padding:6px 6px 22px 6px;background:var(--surface);border-top:none}
.row-body[hidden]{display:none}
.schemas{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:14px 0 4px}
.schema h4,.provs h4,.cli-hint .hint-label{font-size:10.5px;font-weight:600;color:var(--w40);text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;display:block}
.schema ul{list-style:none;display:grid;gap:4px}
.schema li{display:flex;gap:10px;align-items:baseline;font-size:12.5px;line-height:1.45}
.schema li code{color:var(--accent);font-weight:500;flex-shrink:0}
.schema li span{color:var(--w60)}
.provs{margin-top:12px}
.prov{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px}
.prov-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.prov-id{font-size:12.5px;color:#fff;font-weight:500}
.prov-cost{font-family:var(--mono);font-size:12px;color:var(--accent);font-weight:600}
.prov-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.prov-desc{font-size:12px;color:var(--w60);margin-top:6px;line-height:1.5}
.chip{display:inline-block;padding:2px 8px;background:var(--w10);color:var(--w80);font:11px var(--mono);border-radius:100px}
.chip-rail{background:rgba(245,73,0,.15);color:var(--accent)}
.chip-dim{background:transparent;color:var(--w40)}
.prov-empty{font-size:13px;color:var(--w40);font-style:italic;padding:8px 0}
.cli-hint{margin-top:14px;padding:12px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;font-size:12.5px}
.cli-hint .hint-label{color:var(--accent);margin-bottom:4px}
.cli-hint code{color:var(--w80);font-size:12px;display:block;word-break:break-all}

/* Empty state */
.empty{padding:80px 0;text-align:center;color:var(--w40);font-size:15px}

/* Footer */
footer{border-top:1px solid var(--border);padding:32px 0;margin-top:40px}
.footer-inner{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;font-size:12.5px;color:var(--w60)}
.footer-inner a{color:var(--w80);transition:color .2s}
.footer-inner a:hover{color:var(--accent)}
.foot-links{display:flex;gap:18px;flex-wrap:wrap}

@media (max-width:760px){
  .row-main{
    grid-template-columns:1fr auto auto;
    grid-template-areas:
      "path       price arrow"
      "desc       desc  desc"
      "prov       badge badge";
    gap:4px 12px;
    padding:14px 6px;
  }
  .row-path{grid-area:path}
  .row-desc{grid-area:desc;white-space:normal;overflow:visible}
  .row-price{grid-area:price}
  .row-prov{grid-area:prov;justify-self:start}
  .row-badge{grid-area:badge;justify-self:end}
  .row-arrow{grid-area:arrow}
  .schemas{grid-template-columns:1fr}
}
@media (max-width:640px){
  .hero{padding:40px 0 20px}
  nav{position:relative}
  .search-wrap{top:0}
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
      <a href="/docs">API</a>
      <a href="https://github.com/0xArtex/AgentOS" target="_blank" rel="noopener">GitHub</a>
    </div>
  </div>
</nav>

<section class="hero">
  <div class="container hero-inner">
    <div class="hero-badge">i402 · Live catalog</div>
    <h1>Discover</h1>
    <p class="hero-sub">
      Every capability your agent can invoke over x402. Ask in natural language via <code>agentos chat run</code> — i402 returns a plan of real x402 endpoints your agent's wallet signs directly.
    </p>
    <div class="hero-stats">
      <span><strong>${totalCaps}</strong> capabilities</span>
      <span><strong>${totalProviders}</strong> providers</span>
      <span><strong>${totalGroups}</strong> categories</span>
      <span><strong>x402</strong> payment rail</span>
    </div>
  </div>
</section>

<section class="search-wrap">
  <div class="container">
    <div class="search" id="search-wrap">
      <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input id="search" type="search" placeholder="Filter capabilities — e.g. 'twitter', 'send sms', 'vps reboot'..." autocomplete="off" spellcheck="false">
      <button class="search-clear" id="search-clear" type="button">clear</button>
    </div>
  </div>
</section>

<main class="container">
  ${groupsHtml}
  <div class="empty" id="empty" hidden>No capabilities match that search.</div>
</main>

<footer>
  <div class="container footer-inner">
    <div>Protocol spec: <a href="/skill.md">skill.md</a> · JSON feed: <a href="/chat/capabilities">/chat/capabilities</a>, <a href="/chat/providers">/chat/providers</a></div>
    <div class="foot-links">
      <a href="/">Home</a>
      <a href="/dashboard.html">Dashboard</a>
      <a href="https://github.com/0xArtex/AgentOS" target="_blank" rel="noopener">GitHub</a>
      <a href="/docs">API</a>
    </div>
  </div>
</footer>

<script>
(() => {
  const search = document.getElementById('search');
  const searchWrap = document.getElementById('search-wrap');
  const searchClear = document.getElementById('search-clear');
  const empty = document.getElementById('empty');
  const groups = document.querySelectorAll('.group');

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    searchWrap.classList.toggle('has-query', q.length > 0);
    let totalVisible = 0;
    for (const group of groups) {
      let visibleInGroup = 0;
      for (const row of group.querySelectorAll('.row')) {
        const haystack = row.dataset.search || '';
        const match = q === '' || haystack.includes(q);
        row.classList.toggle('hidden', !match);
        if (match) visibleInGroup++;
      }
      group.classList.toggle('hidden', visibleInGroup === 0);
      totalVisible += visibleInGroup;
    }
    empty.hidden = totalVisible > 0;
  }

  search.addEventListener('input', applyFilter);
  searchClear.addEventListener('click', () => {
    search.value = '';
    search.focus();
    applyFilter();
  });

  // '/' focuses search
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== search) {
      e.preventDefault();
      search.focus();
      search.select();
    }
    if (e.key === 'Escape' && document.activeElement === search) {
      if (search.value) {
        search.value = '';
        applyFilter();
      } else {
        search.blur();
      }
    }
  });

  // Expand / collapse
  document.addEventListener('click', (e) => {
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
  if (h) {
    search.value = h;
    applyFilter();
  }
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
