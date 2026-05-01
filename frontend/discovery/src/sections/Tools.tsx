import { useEffect, useMemo, useState } from "react";
import type { DiscoveryResponse, Tool } from "../types";
import { useReveal } from "../lib/useReveal";
import "./Tools.css";

function formatPrice(min: number, max: number): string {
  if (min === 0 && max === 0) return "—";
  const fmt = (n: number) =>
    n === 0 ? "free" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
}

export default function Tools() {
  const [data, setData] = useState<DiscoveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [network, setNetwork] = useState<string>("all");

  const eyebrowRef = useReveal<HTMLParagraphElement>({ delay: 0.0 });
  const headingRef = useReveal<HTMLHeadingElement>({ delay: 0.1 });
  const subRef = useReveal<HTMLParagraphElement>({ delay: 0.25 });
  const ctaRef = useReveal<HTMLAnchorElement>({ delay: 0.35 });
  const tableRef = useReveal<HTMLDivElement>({ delay: 0.15, y: 48 });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/discovery")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<DiscoveryResponse>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo<Tool[]>(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.tools.filter((t) => {
      if (category !== "all" && t.category !== category) return false;
      if (network !== "all" && !t.networks.includes(network)) return false;
      if (!q) return true;
      const hay = `${t.name} ${t.description} ${t.path} ${t.categoryLabel}`.toLowerCase();
      return hay.includes(q);
    });
  }, [data, query, category, network]);

  return (
    <section className="section tools-section" id="tools">
      <div className="container tools-grid">
        <div className="tools-text">
          <p ref={eyebrowRef} className="h-eyebrow">Chapter III</p>
          <h2 ref={headingRef} className="h-display">
            Browse every tool
            <br />
            your agent can use.
          </h2>
          <p ref={subRef} className="h-sub">
            Discover hosted tools, x402 endpoints, and modes — every tool your
            agent can plug into, priced in USDC, no API keys required.
          </p>
          <a ref={ctaRef} className="cta" href="#tools">
            Explore integrations <span aria-hidden="true">→</span>
          </a>
        </div>

        <div ref={tableRef} className="tools-table-wrap">
          <header className="tools-table-head">
            <h3>All Tools</h3>
            <div className="tools-controls">
              <input
                type="search"
                className="tools-search"
                placeholder="Search tools…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                className="tools-select"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="all">All Categories</option>
                {data?.categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              <select
                className="tools-select"
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
              >
                <option value="all">All Networks</option>
                {data?.networks.map((n) => (
                  <option key={n.key} value={n.key}>
                    {n.label}
                  </option>
                ))}
              </select>
            </div>
          </header>

          <div className="tools-table">
            <div className="tools-row tools-row-head">
              <span>Name</span>
              <span>Category</span>
              <span>Network</span>
              <span className="num">Price</span>
            </div>
            {error ? (
              <div className="tools-empty">Failed to load tools: {error}</div>
            ) : !data ? (
              <div className="tools-empty">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="tools-empty">No tools match.</div>
            ) : (
              filtered.map((t) => (
                <div className="tools-row" key={t.id}>
                  <span className="tools-name" title={t.description}>
                    {t.name}
                  </span>
                  <span className="tools-cat">{t.categoryLabel}</span>
                  <span className="tools-net">
                    {t.networkLabels.join(", ") || "—"}
                  </span>
                  <span className="tools-price num">
                    {formatPrice(t.minCostUsdc, t.maxCostUsdc)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
