import { useEffect, useMemo, useState } from "react";
import type { DiscoveryResponse, Tool } from "../types";
import { useReveal } from "../lib/useReveal";
import ToolIcon from "../components/ToolIcon";
import "./Tools.css";

function formatPrice(min: number, max: number): string {
  if (min === 0 && max === 0) return "—";
  const fmt = (n: number) =>
    n === 0 ? "free" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
}

function sortPriority(t: Tool): number {
  if (t.name === "grow_audience") return 0;
  if (t.name === "launch_product") return 1;
  if (t.category === "twitter") return 2;
  if (t.category === "domain") return 3;
  if (t.category === "phone") return 4;
  if (t.category === "voice") return 5;
  if (t.category === "compute" && t.name !== "configure_openclaw") return 6;
  if (t.name === "configure_openclaw") return 7;
  return 99;
}

interface SchemaBlockProps {
  title: string;
  schema: Record<string, unknown>;
}

function SchemaBlock({ title, schema }: SchemaBlockProps) {
  const entries = Object.entries(schema ?? {});
  return (
    <div className="schema-block">
      <span className="detail-cli-label">{title}</span>
      {entries.length === 0 ? (
        <p className="schema-empty">—</p>
      ) : (
        <ul>
          {entries.map(([k, v]) => (
            <li key={k}>
              <code>{k}</code>
              <span>{typeof v === "string" ? v : JSON.stringify(v)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Tools() {
  const [data, setData] = useState<DiscoveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
    const list = data.tools.filter((t) => {
      if (category !== "all" && t.category !== category) return false;
      if (!q) return true;
      const hay = `${t.name} ${t.description} ${t.path} ${t.categoryLabel}`.toLowerCase();
      return hay.includes(q);
    });
    // Manually-curated priority order: marquee compound flows first,
    // then the categories users hit most often, then long-tail.
    return list.sort((a, b) => {
      const pa = sortPriority(a);
      const pb = sortPriority(b);
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name);
    });
  }, [data, query, category]);

  const totalCount = data?.stats.totalTools ?? 0;

  return (
    <section className="section tools-section" id="tools">
      <div className="container tools-grid">
        <div className="tools-text">
          <p ref={eyebrowRef} className="h-eyebrow">Discovery</p>
          <h2 ref={headingRef} className="h-display">
            Browse every
            <br />
            tool your
            <br />
            agent can use<span className="accent-dot">.</span>
          </h2>
          <p ref={subRef} className="h-sub">
            Discover tools across phone, voice, email, compute, and social —
            ready for your agent to call.
          </p>
          <a ref={ctaRef} className="tools-cta-link" href="/skill.md">
            Get started <span aria-hidden="true">→</span>
          </a>
        </div>

        <div ref={tableRef} className="tools-table-wrap" id="tools-table">
          <header className="tools-table-head">
            <div className="tools-title-row">
              <h3>All Tools</h3>
              {totalCount > 0 && <span className="tools-count">{totalCount}</span>}
            </div>

            <div className="tools-controls">
              <label className="tools-search-wrap">
                <svg
                  className="tools-search-icon"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  type="search"
                  className="tools-search"
                  placeholder="Search tools (e.g., send_sms, compute)…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>

              <label className="tools-select-wrap">
                <span className="tools-select-label">Category</span>
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
              </label>
            </div>
          </header>

          <div className="tools-table">
            <div className="tools-row tools-row-head">
              <span>Tool</span>
              <span>Description</span>
              <span className="num">
                Avg per use
                <svg
                  className="info-icon"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </span>
            </div>
            {error ? (
              <div className="tools-empty">Failed to load tools: {error}</div>
            ) : !data ? (
              <div className="tools-empty">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="tools-empty">No tools match.</div>
            ) : (
              filtered.map((t) => {
                const isOpen = expandedId === t.id;
                return (
                  <div key={t.id} className={`tools-row-group${isOpen ? " is-open" : ""}`}>
                    <button
                      type="button"
                      className="tools-row tools-row-clickable"
                      aria-expanded={isOpen}
                      aria-controls={`detail-${t.id}`}
                      onClick={() => setExpandedId(isOpen ? null : t.id)}
                    >
                      <span className="tools-tool">
                        <span className="tool-icon">
                          <ToolIcon name={t.name} category={t.category} size={20} />
                        </span>
                        <span className="tool-name">{t.name}</span>
                      </span>
                      <span className="tools-desc">{t.description}</span>
                      <span className="tools-price num">
                        {formatPrice(t.minCostUsdc, t.maxCostUsdc)}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="tools-row-detail" id={`detail-${t.id}`}>
                        <p className="detail-desc">{t.description}</p>
                        <div className="detail-grid">
                          <SchemaBlock
                            title="Input"
                            schema={t.inputSchema}
                          />
                          <SchemaBlock
                            title="Output"
                            schema={t.outputSchema}
                          />
                        </div>
                        <div className="detail-cli">
                          <span className="detail-cli-label">Try it</span>
                          <code>
                            agentos chat run &quot;{t.name.replace(/_/g, " ")} …&quot;
                            --budget 10 --execute
                          </code>
                        </div>
                        {t.providers.length > 0 && (
                          <div className="detail-providers">
                            <span className="detail-cli-label">
                              {t.providers.length} provider
                              {t.providers.length > 1 ? "s" : ""}
                            </span>
                            <ul>
                              {t.providers.map((p) => (
                                <li key={p.id}>
                                  <code>{p.id}</code>
                                  <span className="detail-prov-net">
                                    {p.networkLabel}
                                  </span>
                                  <span className="detail-prov-cost">
                                    {formatPrice(p.costUsdc, p.costUsdc)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}

            <footer className="tools-table-foot">
              <span>More tools and capabilities are added regularly.</span>
              <a
                href="https://github.com/0xArtex/AgentOS/issues/new?labels=tool-request&title=Tool+request%3A+"
                target="_blank"
                rel="noopener"
                className="tools-foot-link"
              >
                Request a tool <span aria-hidden="true">→</span>
              </a>
            </footer>
          </div>
        </div>
      </div>
    </section>
  );
}
