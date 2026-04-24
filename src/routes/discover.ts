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
  description: string;
  test: (name: string) => boolean;
}

const GROUPS: CapabilityGroup[] = [
  { key: "phone", label: "Phone & SMS", description: "Real numbers, send / receive SMS.", test: n => /^(provision_phone|release_phone|send_sms|read_sms)$/.test(n) },
  { key: "voice", label: "Voice", description: "Outbound calls, TTS, DTMF, recording, transfer.", test: n => /^(start_voice_call|list_calls|get_call_details|voice_)/.test(n) },
  { key: "email", label: "Email", description: "E2E-encrypted inboxes + send/read/threads.", test: n => /^(provision_email_inbox|send_email|read_email|list_email_threads|read_email_thread)$/.test(n) },
  { key: "domain", label: "Domain", description: "Register, list, transfer, manage DNS.", test: n => /^(register_domain|list_domains|get_domain|dns_manage|transfer_domain)/.test(n) },
  { key: "compute", label: "Compute", description: "VPS lifecycle, SSH keys, agent skills.", test: n => /^(deploy_vps|list_vps|get_vps|vps_|create_ssh_key|list_ssh_keys|delete_ssh_key|install_skill|install_skills_bulk|remove_skill|configure_openclaw|configure_vps_wallet)$/.test(n) },
  { key: "twitter", label: "Twitter / X", description: "Post, reply, like, follow, update profile.", test: n => n.startsWith("twitter_") },
  { key: "tiktok", label: "TikTok", description: "Login, post videos, follow, like, profile.", test: n => n.startsWith("tiktok_") },
  { key: "apikeys", label: "API Keys", description: "Issue wallet-scoped keys for third-party services.", test: n => n === "issue_api_key" },
  { key: "compound", label: "Compound", description: "End-to-end goals that expand into multi-step plans.", test: n => !!CAPABILITY_CLASSES[n]?.isCompound },
  { key: "legacy", label: "Platform Dispatch", description: "Multi-platform wrappers (social_post, social_account_provision).", test: n => n === "social_post" || n === "social_account_provision" },
];

function groupOf(capabilityName: string): CapabilityGroup {
  for (const g of GROUPS) if (g.test(capabilityName)) return g;
  return { key: "other", label: "Other", description: "", test: () => true };
}

// -------------------- HTML rendering --------------------

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
  if (usdc < 1) return `$${usdc.toFixed(2)}`;
  return `$${usdc.toFixed(2)}`;
}

function schemaToFields(schema: unknown): Array<{ key: string; value: string }> {
  if (!schema || typeof schema !== "object") return [];
  return Object.entries(schema as Record<string, unknown>).map(([k, v]) => ({
    key: k,
    value: typeof v === "string" ? v : JSON.stringify(v),
  }));
}

function renderPage(capabilities: CapabilityClass[], providers: I402Provider[]): string {
  const providersByCap = new Map<string, I402Provider[]>();
  for (const p of providers) {
    if (!providersByCap.has(p.capability)) providersByCap.set(p.capability, []);
    providersByCap.get(p.capability)!.push(p);
  }

  const capsWithMeta = capabilities.map(c => {
    const group = groupOf(c.name);
    const ps = providersByCap.get(c.name) ?? [];
    const minCost = ps.length ? Math.min(...ps.map(x => x.costPerCallUsdc)) : 0;
    const maxCost = ps.length ? Math.max(...ps.map(x => x.costPerCallUsdc)) : 0;
    return { cap: c, group, providers: ps, minCost, maxCost };
  });

  // Sort: group order (as declared in GROUPS array), then alphabetic within group
  const groupOrder = new Map(GROUPS.map((g, i) => [g.key, i]));
  capsWithMeta.sort((a, b) => {
    const ga = groupOrder.get(a.group.key) ?? 999;
    const gb = groupOrder.get(b.group.key) ?? 999;
    if (ga !== gb) return ga - gb;
    return a.cap.name.localeCompare(b.cap.name);
  });

  const totalCaps = capabilities.length;
  const totalProviders = providers.length;
  const totalGroups = new Set(capsWithMeta.map(c => c.group.key)).size;

  const cardsHtml = capsWithMeta
    .map(({ cap, group, providers: ps, minCost, maxCost }) => {
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

      return `
<article class="card" data-group="${escapeHtml(group.key)}" data-search="${escapeHtml((cap.name + " " + cap.description).toLowerCase())}">
  <header class="card-head">
    <div class="card-meta">
      <span class="group-chip group-${escapeHtml(group.key)}">${escapeHtml(group.label)}</span>
      ${cap.isCompound ? '<span class="chip chip-accent">compound</span>' : ""}
    </div>
    <div class="card-price">${priceLabel}</div>
  </header>
  <h2 class="card-name"><code>${escapeHtml(cap.name)}</code></h2>
  <p class="card-desc">${escapeHtml(cap.description)}</p>
  <footer class="card-foot">
    <span class="prov-count">${ps.length} provider${ps.length === 1 ? "" : "s"}</span>
    <button class="expand-btn" type="button" aria-expanded="false">Details</button>
  </footer>
  <div class="card-body" hidden>
    <div class="schema">
      <h3>Input</h3>
      <ul>${inputFields || "<li><span>—</span></li>"}</ul>
    </div>
    <div class="schema">
      <h3>Output</h3>
      <ul>${outputFields || "<li><span>—</span></li>"}</ul>
    </div>
    <div class="provs">
      <h3>Providers</h3>
      ${providerRows || '<div class="prov-empty">No provider registered yet.</div>'}
    </div>
    <div class="cli-hint">
      <span class="hint-label">Try it:</span>
      <code>agentos chat run "&lt;natural-language intent&gt;" --budget 10 --execute</code>
    </div>
  </div>
</article>`;
    })
    .join("\n");

  const groupChipsHtml = GROUPS.filter(g => capsWithMeta.some(c => c.group.key === g.key))
    .map(
      g => `<button class="filter-chip" data-filter="${escapeHtml(g.key)}" type="button">${escapeHtml(g.label)} <span class="chip-count">${capsWithMeta.filter(c => c.group.key === g.key).length}</span></button>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Discover — AgentOS i402 Capability Catalog</title>
<meta name="description" content="Every capability AgentOS exposes over x402. ${totalCaps} capabilities across ${totalGroups} categories, served by ${totalProviders} providers.">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --accent:#f54900;
  --accent-glow:rgba(245,73,0,.18);
  --bg:#050505;
  --surface:#0a0a0a;
  --surface-2:#111;
  --border:rgba(255,255,255,.08);
  --w100:#fff;
  --w80:rgba(255,255,255,.82);
  --w60:rgba(255,255,255,.58);
  --w40:rgba(255,255,255,.38);
  --w20:rgba(255,255,255,.18);
  --w10:rgba(255,255,255,.08);
  --radius:12px;
  --mono:'JetBrains Mono',ui-monospace,Menlo,monospace;
}
::selection{background:var(--accent);color:#000}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--w100);font:15px/1.6 'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh}
body::after{content:'';position:fixed;inset:0;pointer-events:none;z-index:100;opacity:.015;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
a{color:inherit;text-decoration:none}
code{font-family:var(--mono);font-size:.92em}

.container{max-width:1280px;margin:0 auto;padding:0 clamp(20px,4vw,56px)}

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
.hero{padding:96px 0 56px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:1000px;height:600px;background:radial-gradient(ellipse 50% 50%,var(--accent-glow) 0%,transparent 70%);pointer-events:none}
.hero-inner{position:relative}
.hero-badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;background:rgba(245,73,0,.1);border:1px solid rgba(245,73,0,.25);border-radius:100px;font-size:12px;color:var(--accent);margin-bottom:20px;font-weight:500;text-transform:uppercase;letter-spacing:.08em}
.hero-badge::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
h1{font-size:clamp(36px,5.5vw,58px);font-weight:500;letter-spacing:-.03em;line-height:1.05;margin-bottom:20px;background:linear-gradient(180deg,#fff 40%,rgba(255,255,255,.55));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero-sub{font-size:17px;color:var(--w80);max-width:640px;line-height:1.65;margin-bottom:32px}
.hero-stats{display:flex;flex-wrap:wrap;gap:32px;margin-bottom:8px}
.stat{}
.stat-val{font-family:var(--mono);font-size:26px;font-weight:600;color:var(--accent);letter-spacing:-.02em}
.stat-lbl{font-size:12px;color:var(--w40);text-transform:uppercase;letter-spacing:.08em;margin-top:4px}

/* Controls */
.controls{padding:28px 0 20px;border-bottom:1px solid var(--border);position:sticky;top:57px;z-index:40;background:rgba(5,5,5,.9);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
.search{position:relative;margin-bottom:16px}
.search input{width:100%;height:48px;padding:0 20px 0 48px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);color:#fff;font:15px 'Inter',sans-serif;transition:border-color .2s,background .2s;outline:none}
.search input:focus{border-color:var(--accent);background:var(--surface-2)}
.search input::placeholder{color:var(--w40)}
.search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--w40);pointer-events:none}
.filter-chips{display:flex;flex-wrap:wrap;gap:8px}
.filter-chip{padding:8px 14px;background:var(--surface);border:1px solid var(--border);border-radius:100px;font:13px 'Inter',sans-serif;color:var(--w80);cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:8px}
.filter-chip:hover{border-color:var(--w20);color:#fff}
.filter-chip.active{background:var(--accent);border-color:var(--accent);color:#fff}
.filter-chip.active .chip-count{background:rgba(0,0,0,.25);color:#fff}
.chip-count{font:11px var(--mono);font-weight:600;padding:1px 7px;border-radius:100px;background:var(--w10);color:var(--w60)}

/* Grid */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;padding:28px 0 120px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px;transition:border-color .2s,transform .15s;position:relative}
.card:hover{border-color:rgba(245,73,0,.35)}
.card.hidden{display:none}
.card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:14px}
.card-meta{display:flex;flex-wrap:wrap;gap:6px}
.group-chip{display:inline-block;padding:3px 10px;font-size:11px;font-weight:500;border-radius:100px;text-transform:uppercase;letter-spacing:.05em}
.group-phone{background:rgba(16,185,129,.12);color:#10b981}
.group-voice{background:rgba(139,92,246,.12);color:#a78bfa}
.group-email{background:rgba(59,130,246,.12);color:#60a5fa}
.group-domain{background:rgba(245,158,11,.12);color:#fbbf24}
.group-compute{background:rgba(236,72,153,.12);color:#f472b6}
.group-twitter{background:rgba(29,161,242,.14);color:#38bdf8}
.group-tiktok{background:rgba(255,0,80,.12);color:#ff4081}
.group-apikeys{background:rgba(165,180,252,.12);color:#a5b4fc}
.group-compound{background:rgba(245,73,0,.14);color:var(--accent)}
.group-legacy{background:rgba(255,255,255,.06);color:var(--w60)}
.card-price{font-family:var(--mono);font-size:13px;color:var(--w80);font-weight:500;white-space:nowrap}
.card-name{margin-bottom:8px}
.card-name code{font-size:16px;color:#fff;font-weight:600;letter-spacing:-.01em}
.card-desc{color:var(--w60);font-size:13.5px;line-height:1.55;margin-bottom:14px}
.card-foot{display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid var(--w10)}
.prov-count{font-size:12px;color:var(--w40);font-family:var(--mono)}
.expand-btn{padding:6px 14px;background:transparent;border:1px solid var(--border);color:var(--w80);font-family:inherit;font-size:12px;font-weight:500;border-radius:100px;cursor:pointer;transition:all .15s}
.expand-btn:hover{border-color:var(--accent);color:var(--accent)}
.expand-btn[aria-expanded="true"]{background:var(--accent);border-color:var(--accent);color:#fff}

/* Expanded body */
.card-body{padding-top:16px;margin-top:16px;border-top:1px solid var(--w10)}
.card-body[hidden]{display:none}
.schema, .provs{margin-bottom:16px}
.schema h3, .provs h3{font-size:11px;font-weight:600;color:var(--w40);text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px}
.schema ul{list-style:none;display:grid;gap:4px}
.schema li{display:flex;gap:10px;align-items:baseline;font-size:12.5px;line-height:1.4}
.schema li code{color:var(--accent);font-weight:500;flex-shrink:0}
.schema li span{color:var(--w60)}
.prov{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px}
.prov-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.prov-id{font-size:12.5px;color:#fff;font-weight:500}
.prov-cost{font-family:var(--mono);font-size:12px;color:var(--accent);font-weight:600}
.prov-meta{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px}
.prov-desc{font-size:12px;color:var(--w60);margin-top:6px;line-height:1.5}
.chip{display:inline-block;padding:2px 8px;background:var(--w10);color:var(--w80);font:11px var(--mono);border-radius:100px}
.chip-rail{background:rgba(245,73,0,.15);color:var(--accent)}
.chip-dim{background:transparent;color:var(--w40)}
.chip-accent{background:var(--accent);color:#fff}
.prov-empty{font-size:13px;color:var(--w40);font-style:italic}
.cli-hint{margin-top:12px;padding:12px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;font-size:12.5px}
.hint-label{display:inline-block;color:var(--accent);font-weight:500;margin-right:8px;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.cli-hint code{color:var(--w80);font-size:12px}

/* Empty state */
.empty{padding:80px 0;text-align:center;color:var(--w40);font-size:15px}

/* Footer */
footer{border-top:1px solid var(--border);padding:40px 0;margin-top:60px}
.footer-inner{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--w60)}
.footer-inner a{color:var(--w80);transition:color .2s}
.footer-inner a:hover{color:var(--accent)}
.foot-links{display:flex;gap:20px;flex-wrap:wrap}

@media (max-width:640px){
  .hero{padding:56px 0 32px}
  .hero-stats{gap:24px}
  .stat-val{font-size:22px}
  .grid{grid-template-columns:1fr}
  .controls{top:0}
  nav{position:relative}
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
      <a href="/docs">API Docs</a>
      <a href="https://github.com/0xArtex/AgentOS" target="_blank" rel="noopener">GitHub</a>
    </div>
  </div>
</nav>

<section class="hero">
  <div class="container hero-inner">
    <div class="hero-badge">i402 Protocol · Live catalog</div>
    <h1>Everything your agent can do,<br>one natural-language call away.</h1>
    <p class="hero-sub">
      Every capability AgentOS exposes over x402. Ask in natural language via <code>agentos chat run</code> and i402 returns a plan of real x402 endpoints your agent's wallet signs directly. No API keys, no custodial escrow, one tx per step.
    </p>
    <div class="hero-stats">
      <div class="stat"><div class="stat-val">${totalCaps}</div><div class="stat-lbl">Capabilities</div></div>
      <div class="stat"><div class="stat-val">${totalProviders}</div><div class="stat-lbl">Providers</div></div>
      <div class="stat"><div class="stat-val">${totalGroups}</div><div class="stat-lbl">Categories</div></div>
      <div class="stat"><div class="stat-val">x402</div><div class="stat-lbl">Payment rail</div></div>
    </div>
  </div>
</section>

<section class="controls">
  <div class="container">
    <div class="search">
      <svg class="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input id="search" type="search" placeholder="Search capabilities — e.g. 'twitter', 'send sms', 'vps reboot'..." autocomplete="off" spellcheck="false">
    </div>
    <div class="filter-chips">
      <button class="filter-chip active" data-filter="all" type="button">All <span class="chip-count">${totalCaps}</span></button>
      ${groupChipsHtml}
    </div>
  </div>
</section>

<main class="container">
  <div class="grid" id="grid">
    ${cardsHtml}
  </div>
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
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const search = document.getElementById('search');
  const chips = document.querySelectorAll('.filter-chip');
  let activeFilter = 'all';
  let query = '';

  function applyFilter() {
    let visible = 0;
    for (const card of grid.children) {
      const g = card.dataset.group;
      const haystack = card.dataset.search;
      const match = (activeFilter === 'all' || g === activeFilter)
        && (query === '' || haystack.includes(query));
      card.classList.toggle('hidden', !match);
      if (match) visible++;
    }
    empty.hidden = visible > 0;
  }

  for (const chip of chips) {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      applyFilter();
    });
  }

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    applyFilter();
  });

  // Expand / collapse card bodies
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.expand-btn');
    if (!btn) return;
    const card = btn.closest('.card');
    const body = card.querySelector('.card-body');
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    body.hidden = open;
    btn.textContent = open ? 'Details' : 'Close';
  });

  // URL hash → filter (e.g. /discover#twitter)
  const h = location.hash.replace('#','');
  if (h) {
    const chip = document.querySelector('.filter-chip[data-filter="' + CSS.escape(h) + '"]');
    if (chip) chip.click();
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
