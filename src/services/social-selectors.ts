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
 * Wait until the content an operation is about to query has actually rendered.
 *
 * This exists because of a defect that made four of five TikTok operations fail
 * in production for months, each with a different and confidently wrong error.
 * Every op navigated with `domcontentloaded` and then waited on a readiness
 * signal that renders EARLIER than the content it needed — the Studio search
 * box, or a profile page whose auth-gated action buttons hydrate last. The wait
 * was satisfied by an empty shell, the query found nothing, and the op blamed a
 * rotated selector, an already-followed account, or an already-deleted post.
 * Live validation caught each one: delete's failure dump listed only the Studio
 * navigation and zero post rows; follow's screenshot showed a fully-rendered
 * profile whose action buttons were still grey skeletons.
 *
 * So: gate on a predicate that is true only once the REAL content exists, and
 * let the caller distinguish "not ready" from "genuinely absent" — they need
 * different errors and, for a paid op, different refund decisions.
 *
 * `predicate` is a JS expression evaluated in the page; its resolved value is
 * returned so a caller can branch on WHICH state was reached (a truthy string,
 * say) rather than just a boolean. Returns null on timeout — never throws, and
 * never silently swallows the timeout the way `.catch(() => {})` did.
 */
export async function waitForHydrated(
  page: any,
  probe: { label: string; predicate: string },
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<unknown | null> {
  const timeout = opts.timeoutMs ?? 20000;
  const polling = opts.pollMs ?? 250;
  try {
    const handle = await page.waitForFunction(probe.predicate, undefined, { timeout, polling });
    const value = await handle.jsonValue().catch(() => true);
    return value ?? true;
  } catch {
    console.warn(`[selectors] hydration probe "${probe.label}" did not settle within ${timeout}ms`);
    return null;
  }
}

/**
 * Page-context predicates for the surfaces our operations drive. Kept together
 * so the "what does rendered actually mean here" judgement lives in one place
 * rather than being re-guessed at each call site.
 */
export const HYDRATION_PROBES = {
  /**
   * A profile's action row. Matches the button in ANY state — Follow, Following,
   * Friends, Requested — because "already following" is a legitimate outcome we
   * must be able to observe rather than mistake for a missing control. Restricted
   * to leaf-ish nodes so a wrapper containing the word doesn't satisfy it.
   */
  profileActions: {
    label: "profile-actions",
    predicate: `(() => {
      const els = document.querySelectorAll('button, [role="button"]');
      for (const el of els) {
        if (el.querySelector('button, [role="button"]')) continue;
        if (/^(follow|following|friends|requested)$/i.test((el.textContent || '').trim())) return true;
      }
      return false;
    })()`,
  },

  /** A video watch page's engagement rail. */
  videoActions: {
    label: "video-actions",
    predicate: `!!document.querySelector('[data-e2e="like-icon"], button[aria-label*="ike"], [data-e2e="browse-like-icon"]')`,
  },

  /**
   * The Studio content manager. Resolves to 'rows' once real posts are present,
   * or 'empty' only when the list shell has been up for a while with none — the
   * distinction that stops an unrendered list being reported as an account with
   * no videos. Callers must treat a null return as NOT-READY, never as zero.
   */
  studioContent: {
    label: "studio-content",
    predicate: `(() => {
      if (document.querySelectorAll('a[href*="/video/"]').length > 0) return 'rows';
      const shell = document.querySelector('input[placeholder*="Search for post" i]');
      if (!shell) return false;
      const w = window;
      if (!w.__palmyrEmptySince) { w.__palmyrEmptySince = Date.now(); return false; }
      return (Date.now() - w.__palmyrEmptySince) > 6000 ? 'empty' : false;
    })()`,
  },
} as const;

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
