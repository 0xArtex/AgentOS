/**
 * Hook analysis — which openings actually earn views on YOUR accounts.
 *
 * A "hook" is the first thing a viewer reads: the opening line of the caption,
 * before the hashtags. Its job is to stop the scroll, and on TikTok that is
 * what drives distribution — the algorithm promotes what holds attention in the
 * opening seconds. So views (not engagement rate) is the honest proxy for hook
 * quality: engagement rate measures whether the CONTENT landed with the people
 * who watched, views measure whether the opening earned an audience at all.
 *
 * Everything here is measured against the account's OWN history. Cross-account
 * comparison is meaningless — a 2M-follower account's median beats a new
 * account's best post regardless of the writing — so "good" always means "good
 * relative to what this account usually does".
 *
 * Two honesty rules are load-bearing, because the failure mode of a system like
 * this is confident nonsense from three data points:
 *
 *   1. A pattern seen fewer than MIN_CONFIDENT_POSTS times reports its numbers
 *      but is NOT marked confident. Two posts is an anecdote.
 *   2. Posts younger than the maturity window are excluded from the comparison
 *      entirely. A post from this morning has fewer views than one from last
 *      month for reasons that have nothing to do with its hook, and mixing
 *      the two makes every recent hook look bad.
 */
import { latestForAccount, type MetricSample } from "./tiktok-metrics";
import { listByOwner } from "./tiktok-accounts";

/** Recognised opening patterns. Deliberately small and legible — a taxonomy
 *  nobody can hold in their head produces labels nobody trusts. */
export type HookPattern =
  | "question"
  | "pov"
  | "listicle"
  | "howto"
  | "contrarian"
  | "curiosity_gap"
  | "direct_address"
  | "story"
  | "urgency"
  | "social_proof";

export const HOOK_PATTERNS: { pattern: HookPattern; label: string; test: RegExp }[] = [
  // Ends in a question mark, or opens with an interrogative.
  { pattern: "question", label: "Asks a question", test: /\?\s*$|^\s*(who|what|when|where|why|how|is|are|do|does|did|can|should|would|will)\b/i },
  { pattern: "pov", label: "POV / relatable scenario", test: /^\s*(pov\b|p\.o\.v|when you\b|me when\b|that moment when\b)/i },
  { pattern: "listicle", label: "Numbered list", test: /^\s*(top\s+)?\d+\s+\w|^\s*the\s+\d+\b/i },
  // `how do you …` is a tutorial ask as much as `how to …` is, so it counts.
  { pattern: "howto", label: "How-to / tutorial", test: /\bhow\s+(to|i|we|they|do|does|did|can)\b/i },
  // NOTE the `\w+` rather than `\w`: with a single `\w` the trailing `\b` can
  // only hold when the following word is one letter long, so `stop doing …`
  // silently failed to classify while `stop x` matched.
  { pattern: "contrarian", label: "Contrarian / myth-busting", test: /\b(stop\s+\w+|don'?t\s+\w+|never\s+\w+|nobody\s+(tells|talks)|no\s+one\s+(tells|talks)|unpopular\s+opinion|you'?re\s+doing\s+it\s+wrong)\b/i },
  { pattern: "curiosity_gap", label: "Curiosity gap", test: /\b(this\s+is\s+(why|how|what)|here'?s\s+(why|how|what)|the\s+reason\s+\w+|what\s+happened|you\s+won'?t\s+believe|nobody\s+knows)\b/i },
  { pattern: "direct_address", label: "Speaks to the viewer", test: /\b(you|your|you'?re|yourself)\b/i },
  { pattern: "story", label: "First-person story", test: /^\s*(i|we)\s+(\w+ed|was|were|had|got|went|tried|quit|built|made|lost|found|spent)\b/i },
  { pattern: "urgency", label: "Urgency / timeliness", test: /\b(right\s+now|today\s+only|last\s+chance|before\s+it|hurry|ends\s+(today|tonight|soon)|deadline)\b/i },
  { pattern: "social_proof", label: "Numbers / results", test: /\$[\d,]+|\b\d[\d,]*(k|m)?\s*(followers|views|subs|subscribers|sales|clients|customers|downloads)\b/i },
];

/** A pattern needs at least this many posts before we call its result confident. */
export const MIN_CONFIDENT_POSTS = 3;
/** Posts younger than this are still distributing and cannot be fairly judged. */
export const DEFAULT_MATURITY_DAYS = 7;

/**
 * The scroll-stopping opening of a caption.
 *
 * Hashtags are stripped: they are discovery metadata, not the hook, and a
 * caption that is nothing but hashtags has no hook at all rather than a hook
 * made of hashtags. The first sentence wins; failing punctuation, a leading
 * slice, because a run-on caption's hook is still only its opening.
 */
export function extractHook(caption: string | null | undefined, maxChars: number = 120): string | null {
  if (typeof caption !== "string") return null;
  const stripped = caption
    .replace(/#[\p{L}\p{N}_]+/gu, " ")
    .replace(/https?:\/\/\S+/gi, " ");

  // Split into sentence-ish segments BEFORE collapsing whitespace — creators
  // break the hook onto its own line far more often than they punctuate it, and
  // collapsing first erases the very newlines being split on. The first
  // segment with any words left after stripping is the hook, so a caption that
  // opens with a line of hashtags still finds the real opening below it.
  const hook = stripped
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!hook) return null;
  return hook.length > maxChars ? hook.slice(0, maxChars).trim() : hook;
}

/** Every pattern a hook matches. A hook can be several at once ("How do I…?"
 *  is both a question and a how-to) and forcing a single label would discard
 *  the overlap that makes some hooks work. */
export function classifyHook(hook: string | null | undefined): HookPattern[] {
  if (typeof hook !== "string" || !hook.trim()) return [];
  return HOOK_PATTERNS.filter((p) => p.test.test(hook)).map((p) => p.pattern);
}

function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

export interface HookPost {
  account_id: string;
  video_id: string;
  video_url: string | null;
  hook: string | null;
  patterns: HookPattern[];
  views: number;
  posted_at: string | null;
  age_days: number | null;
}

export interface PatternStat {
  pattern: HookPattern;
  label: string;
  posts: number;
  median_views: number | null;
  /** Pattern median ÷ account median. 1.4 = 40% above this account's normal. */
  lift: number | null;
  /** False when the sample is too small to mean anything. Never hide this. */
  confident: boolean;
}

export interface HookReport {
  scope: { account_ids: string[]; tag: string | null };
  baseline: {
    mature_posts: number;
    median_views: number | null;
    excluded_immature: number;
    excluded_no_hook: number;
    maturity_days: number;
  };
  patterns: PatternStat[];
  top_hooks: HookPost[];
  notes: string[];
}

/** Turn stored samples into judged posts, dropping what cannot be judged. */
function maturePosts(
  accountId: string,
  samples: MetricSample[],
  maturityDays: number,
  now: number,
): { posts: HookPost[]; immature: number; noHook: number } {
  const posts: HookPost[] = [];
  let immature = 0;
  let noHook = 0;

  for (const s of samples) {
    const hook = extractHook(s.caption);
    if (!hook) { noHook++; continue; }

    const postedMs = s.posted_at ? Date.parse(s.posted_at) : NaN;
    const ageDays = Number.isNaN(postedMs) ? null : (now - postedMs) / 86_400_000;
    // Unknown age is treated as immature rather than mature: guessing "old
    // enough" inflates a post's apparent hook quality on nothing but a missing
    // field.
    if (ageDays === null || ageDays < maturityDays) { immature++; continue; }

    posts.push({
      account_id: accountId,
      video_id: s.video_id,
      video_url: s.video_url,
      hook,
      patterns: classifyHook(hook),
      views: s.views ?? 0,
      posted_at: s.posted_at,
      age_days: Math.round(ageDays * 10) / 10,
    });
  }
  return { posts, immature, noHook };
}

/**
 * How each opening pattern performs against this account's own normal.
 *
 * Scope by a single account, or by tag to cover a niche across every account
 * the wallet owns with that tag — which is the closest honest reading of "best
 * hook for this industry": it is YOUR industry accounts, measured, rather than
 * a claim about the platform at large that we have no data to support.
 */
export function hookReport(opts: {
  owner: string;
  accountId?: string;
  tag?: string;
  maturityDays?: number;
  now?: number;
}): HookReport {
  const maturityDays = opts.maturityDays ?? DEFAULT_MATURITY_DAYS;
  const now = opts.now ?? Date.now();

  const accountIds = opts.accountId
    ? [opts.accountId]
    : listByOwner(opts.owner, opts.tag).map((a) => a.id);

  const all: HookPost[] = [];
  let immature = 0;
  let noHook = 0;
  for (const id of accountIds) {
    const r = maturePosts(id, latestForAccount(id), maturityDays, now);
    all.push(...r.posts);
    immature += r.immature;
    noHook += r.noHook;
  }

  const baselineMedian = median(all.map((p) => p.views));

  const patterns: PatternStat[] = HOOK_PATTERNS.map(({ pattern, label }) => {
    const hits = all.filter((p) => p.patterns.includes(pattern));
    const med = median(hits.map((p) => p.views));
    // A baseline of zero makes a ratio meaningless (and infinite), so decline
    // to compute one rather than emit a number that reads as a finding.
    const lift = med !== null && baselineMedian !== null && baselineMedian > 0
      ? Math.round((med / baselineMedian) * 100) / 100
      : null;
    return {
      pattern,
      label,
      posts: hits.length,
      median_views: med,
      lift,
      confident: hits.length >= MIN_CONFIDENT_POSTS && lift !== null,
    };
  })
    .filter((p) => p.posts > 0)
    .sort((a, b) => {
      // Confident results first, then by lift. An unconfident 10x must never
      // outrank a confident 1.5x in a list people read top-down.
      if (a.confident !== b.confident) return a.confident ? -1 : 1;
      return (b.lift ?? -Infinity) - (a.lift ?? -Infinity);
    });

  const top_hooks = [...all].sort((a, b) => b.views - a.views).slice(0, 10);

  const notes: string[] = [];
  if (all.length === 0) {
    notes.push(
      `No posts old enough to judge yet. Hooks are scored only after ${maturityDays} days, ` +
      `because a post still being distributed cannot be compared with one that has finished.`,
    );
  }
  if (immature > 0) {
    notes.push(`${immature} post(s) younger than ${maturityDays} days were excluded — still distributing.`);
  }
  if (noHook > 0) {
    notes.push(`${noHook} post(s) had no readable hook (empty caption, or hashtags only).`);
  }
  if (all.length > 0 && all.length < MIN_CONFIDENT_POSTS) {
    notes.push(
      `Only ${all.length} mature post(s) — every result here is an anecdote. ` +
      `Treat nothing as a finding until each pattern has at least ${MIN_CONFIDENT_POSTS}.`,
    );
  }
  const unconfident = patterns.filter((p) => !p.confident).length;
  if (unconfident > 0 && all.length >= MIN_CONFIDENT_POSTS) {
    notes.push(`${unconfident} pattern(s) below ${MIN_CONFIDENT_POSTS} posts are shown but not marked confident.`);
  }
  notes.push("Lift is measured against this account's OWN median views, not other accounts.");

  return {
    scope: { account_ids: accountIds, tag: opts.tag ?? null },
    baseline: {
      mature_posts: all.length,
      median_views: baselineMedian,
      excluded_immature: immature,
      excluded_no_hook: noHook,
      maturity_days: maturityDays,
    },
    patterns,
    top_hooks,
    notes,
  };
}

export interface CaptionCheck {
  caption: string;
  hook: string | null;
  patterns: { pattern: HookPattern; label: string }[];
  /** What this account's history says about those patterns, when it says anything. */
  evidence: PatternStat[];
  notes: string[];
}

/**
 * Classify a caption an agent is ABOUT to post, and say what this account's
 * own history implies about it.
 *
 * Useful before any data exists — naming the pattern is worth something on its
 * own — and it sharpens as posts accrue. When there is no evidence it says so
 * rather than inventing a verdict.
 */
export function checkCaption(opts: {
  owner: string;
  caption: string;
  accountId?: string;
  tag?: string;
  now?: number;
}): CaptionCheck {
  const hook = extractHook(opts.caption);
  const found = classifyHook(hook);
  const patterns = HOOK_PATTERNS.filter((p) => found.includes(p.pattern)).map(({ pattern, label }) => ({ pattern, label }));

  const report = hookReport({ owner: opts.owner, accountId: opts.accountId, tag: opts.tag, now: opts.now });
  const evidence = report.patterns.filter((p) => found.includes(p.pattern));

  const notes: string[] = [];
  if (!hook) notes.push("No readable hook — the caption is empty, or nothing but hashtags and links.");
  else if (found.length === 0) {
    notes.push(
      "No recognised pattern. That is not automatically bad — it may simply be plain — " +
      "but the strongest openings usually do something identifiable: ask, promise, contradict, or tell.",
    );
  }
  if (evidence.length === 0 && found.length > 0) {
    notes.push("This account has no mature posts using these patterns yet, so there is nothing to compare against.");
  }
  const confident = evidence.filter((e) => e.confident);
  if (evidence.length > 0 && confident.length === 0) {
    notes.push(`Matching patterns have fewer than ${MIN_CONFIDENT_POSTS} mature posts each — indicative at best.`);
  }
  return { caption: opts.caption, hook, patterns, evidence, notes };
}
