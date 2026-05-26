/**
 * Best-effort classification of a User-Agent string into a coarse agent kind.
 *
 * The label set is open — add new patterns above the 'other' fallback as new
 * agent UAs show up in the wild. Wrong-but-stable is better than no signal.
 *
 * Used by the /skill.md fetch logger to attribute reads to Claude vs GPT vs
 * Cursor vs random scripts. See `tools/observability/README.md` for the
 * dashboards that consume this column.
 */
export function classifyAgent(ua: string | null | undefined): string {
  if (!ua) return "unknown";
  const u = ua.toLowerCase();
  if (/anthropic|claude/.test(u)) return "claude";
  if (/openai|chatgpt|gpt-?[34]/.test(u)) return "gpt";
  if (/cursor/.test(u)) return "cursor";
  if (/continue/.test(u)) return "continue";
  if (/aider/.test(u)) return "aider";
  if (/^curl/.test(u)) return "curl";
  if (/wget/.test(u)) return "wget";
  if (/python-?requests|httpx/.test(u)) return "python";
  if (/node-?fetch|axios|undici|got/.test(u)) return "node";
  if (/mozilla/.test(u)) return "browser";
  return "other";
}
