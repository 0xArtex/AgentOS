/**
 * Resilient element resolution for browser-driven social ops.
 *
 * TikTok and X rotate their internal `data-e2e` test-ids and class names
 * without notice — when they do, a single hard-coded selector turns a healthy,
 * authenticated session into a UI_TIMEOUT. This module applies the lesson from
 * accessibility-tree-driven agents (e.g. Hermes): resolve an element by an
 * ORDERED list of strategies, preferring stable semantics (ARIA role +
 * accessible name) and falling back through aria-label / text / structural
 * matches.
 *
 * The unambiguous `data-e2e` is tried first — when it's valid the happy path is
 * instant and behaviour is unchanged. The durable role/text layers only engage
 * once TikTok rotates the id, which is exactly when the old code would have
 * broken. When every strategy misses, `axSnapshot` captures the page's
 * accessibility tree (role + name of each interactive node) for the failure
 * payload — that's both a human-debuggable record of what rotated and the exact
 * input a vision fallback would consume if we add one later.
 */

export interface SelectorStrategy {
  /** Short label recorded in logs so we can see which layer actually won. */
  name: string;
  /** Build a Locator from the page. Loosely typed for the playwright-extra page. */
  build: (page: any) => any;
}

export interface ResolveResult {
  locator: any;
  strategy: string;
}

export interface ResolveOptions {
  /** Per-strategy wait budget (ms). Default 4000. */
  perStrategyMs?: number;
  /**
   * Budget for the FIRST strategy only (ms). Lets the preferred selector absorb
   * a one-off delay (e.g. waiting for a video upload to finish) without making
   * every fallback pay that same long timeout. Defaults to perStrategyMs.
   */
  firstTimeoutMs?: number;
  state?: "visible" | "attached";
}

/**
 * Try each strategy in preference order; return the first whose element reaches
 * `state` within its budget. Ordered, not raced — so a precise strategy is never
 * beaten to the punch by a looser fallback that happens to match the wrong node.
 * Returns null if every strategy misses (caller should capture diagnostics).
 */
export async function resolveElement(
  page: any,
  strategies: SelectorStrategy[],
  opts: ResolveOptions = {},
): Promise<ResolveResult | null> {
  const per = opts.perStrategyMs ?? 4000;
  const first = opts.firstTimeoutMs ?? per;
  const state = opts.state ?? "visible";

  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    try {
      const locator = s.build(page).first();
      await locator.waitFor({ state, timeout: i === 0 ? first : per });
      return { locator, strategy: s.name };
    } catch {
      /* try the next strategy */
    }
  }
  return null;
}

/**
 * Flatten Playwright's accessibility snapshot to a compact list of interactive
 * {role, name} pairs — the useful signal for diagnosing a selector rotation
 * (and the shape a vision/AX fallback would act on). Best-effort: returns [] if
 * the snapshot can't be taken.
 */
export async function axSnapshot(
  page: any,
  limit = 60,
): Promise<Array<{ role: string; name: string }>> {
  try {
    const root = await page.accessibility.snapshot({ interestingOnly: true });
    const out: Array<{ role: string; name: string }> = [];
    const keep = /^(button|link|textbox|menuitem|tab|checkbox|switch|combobox|searchbox|heading)$/i;
    const walk = (node: any) => {
      if (!node || out.length >= limit) return;
      const role = String(node.role || "");
      const name = String(node.name || "").trim();
      if (name && keep.test(role)) out.push({ role, name: name.slice(0, 80) });
      if (Array.isArray(node.children)) for (const c of node.children) walk(c);
    };
    walk(root);
    return out;
  } catch {
    return [];
  }
}
