/**
 * Palmyr MCP tool registry.
 *
 * Curated, EXPLICIT list (no auto-generation) of Palmyr capabilities exposed as
 * MCP tools. Two free tools (pricing / capabilities) and a set of paid tools.
 *
 * Payment model: every paid tool proxies to the local Palmyr API over loopback
 * HTTP. The agent pays per action via x402 — the tool never holds funds. On the
 * first call (no `payment` arg) the underlying route answers HTTP 402; we surface
 * the payment instructions as a normal (non-error) tool result so the agent can
 * sign an x402 payment and call again with `payment=<base64 X-PAYMENT>`.
 *
 * Loopback-URL hygiene: the API builds absolute URLs from the request Host
 * header. Since we fetch over 127.0.0.1, those URLs would otherwise leak the
 * loopback origin. undici `fetch` ignores a manually-set Host header (verified),
 * so instead we string-replace the internal origin with https://palmyr.ai in
 * every proxied response body before returning it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config";

const PUBLIC_ORIGIN = "https://palmyr.ai";

// Optional base64 X-PAYMENT payload present on every paid tool.
const PAYMENT_PARAM = z
  .string()
  .optional()
  .describe(
    "base64 x402 payment payload (X-PAYMENT); omit on first call to receive payment instructions",
  );

const PAY_INSTRUCTIONS =
  "Sign an x402 v2 payment for one of the accepts entries (USDC on Solana or Base), " +
  "then call this tool again with the same arguments plus payment=<base64 X-PAYMENT payload>. " +
  "See https://palmyr.ai/skill.md for the full payment guide.";

type TextToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Replace the loopback origin (any scheme) with the canonical public origin. */
function scrubLoopback(text: string): string {
  const port = config.port;
  return text
    .split(`https://127.0.0.1:${port}`).join(PUBLIC_ORIGIN)
    .split(`http://127.0.0.1:${port}`).join(PUBLIC_ORIGIN)
    .split(`https://localhost:${port}`).join(PUBLIC_ORIGIN)
    .split(`http://localhost:${port}`).join(PUBLIC_ORIGIN);
}

/**
 * Proxy a single request to the local Palmyr API. Forwards ONLY method, path,
 * JSON body, and X-PAYMENT (when a payment arg is present) — no other client
 * headers. Returns the scrubbed body text + parsed JSON (best-effort).
 */
async function proxyToApi(opts: {
  method: string;
  path: string;
  body?: unknown;
  payment?: string;
}): Promise<{ status: number; text: string; json: any }> {
  const url = `http://127.0.0.1:${config.port}${opts.path}`;
  const isBodyMethod = opts.method !== "GET" && opts.method !== "HEAD";
  const headers: Record<string, string> = {};
  if (isBodyMethod) headers["Content-Type"] = "application/json";
  if (opts.payment) headers["X-PAYMENT"] = opts.payment;

  const resp = await fetch(url, {
    method: opts.method,
    headers,
    body: isBodyMethod ? JSON.stringify(opts.body ?? {}) : undefined,
  });
  const text = scrubLoopback(await resp.text());
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: resp.status, text, json };
}

/** Derive a human USDC amount from an x402 `accepts` array (base units → USDC). */
function amountUsdcFromAccepts(accepts: any): number | null {
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  const raw = accepts[0]?.amount;
  const n = Number(raw);
  if (!isFinite(n)) return null;
  return n / 1_000_000;
}

/**
 * Shared handler for a proxied route. 402 → structured payment instructions
 * (isError:false); 2xx → JSON body as text; other 4xx/5xx → isError:true.
 */
async function callRoute(
  method: string,
  path: string,
  body: unknown,
  payment: string | undefined,
): Promise<TextToolResult> {
  let result: { status: number; text: string; json: any };
  try {
    result = await proxyToApi({ method, path, body, payment });
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: true, message: err?.message || String(err) }) }],
    };
  }

  const { status, text, json } = result;

  if (status === 402) {
    const accepts = json?.accepts ?? [];
    const resource =
      typeof json?.resource === "string" ? json.resource : json?.resource?.url ?? null;
    const payload = {
      payment_required: true,
      amount_usdc: amountUsdcFromAccepts(accepts),
      resource,
      accepts,
      instructions: PAY_INSTRUCTIONS,
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }

  if (status >= 200 && status < 300) {
    return { content: [{ type: "text", text }] };
  }

  return {
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ error: true, status, body: json ?? text }) },
    ],
  };
}

/** Build a `?a=b&c=d` query string from defined values only. */
function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

type Shape = Record<string, z.ZodTypeAny>;

/**
 * Thin wrapper over `server.registerTool`. registerTool's generics over a
 * ZodRawShape are deep enough to trip TS2589 ("excessively deep") on some
 * shapes; we don't need the inferred arg types (handlers read `args` loosely),
 * so cast through `any` to keep typecheck fast and stable.
 */
function addTool(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: Shape },
  cb: (args: any) => Promise<TextToolResult>,
): void {
  (server.registerTool as any)(name, config, cb);
}

/**
 * Register every curated Palmyr tool on the given MCP server. Called fresh per
 * request in the stateless transport, so it must stay cheap + side-effect-free.
 */
export function registerPalmyrTools(server: McpServer): void {
  // ── Free tools ─────────────────────────────────────────────
  addTool(server, 
    "palmyr_pricing",
    {
      title: "Palmyr pricing",
      description:
        "List every paid Palmyr capability and its live x402 price (USDC on Solana/Base). Free — no payment required.",
      inputSchema: {} as Shape,
    },
    async () => callRoute("GET", "/pricing", undefined, undefined),
  );

  addTool(server, 
    "palmyr_capabilities",
    {
      title: "Palmyr capabilities",
      description:
        "List the i402 capabilities Palmyr can plan and execute (the intent-resolver catalog). Free — no payment required.",
      inputSchema: {} as Shape,
    },
    async () => callRoute("GET", "/chat/capabilities", undefined, undefined),
  );

  // ── Paid tools ─────────────────────────────────────────────

  // i402 intent resolver (flagship). 0.10 USDC per plan.
  addTool(server, 
    "i402_plan",
    {
      title: "i402 plan (intent resolver)",
      description:
        "State an intent, get a priced execution plan. The i402 orchestrator turns a natural-language outcome into an ordered list of x402 calls your agent signs and runs. Costs 0.10 USDC per plan, paid per-action via x402.",
      inputSchema: {
        intent: z.string().describe("Natural-language outcome, e.g. 'register a .com and set up email on it'"),
        budget_usdc: z.number().describe("Max total USDC to spend across the whole plan"),
        params: z.record(z.any()).optional().describe("Optional structured parameters for the intent"),
        deadline_seconds: z.number().optional(),
        quality: z.string().optional().describe("Optional quality hint, e.g. 'fast' | 'best'"),
        constraints: z.record(z.any()).optional(),
        allow_budget_exceeded: z.boolean().optional().describe("Return an executable plan even if it exceeds budget_usdc"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/chat", rest, payment);
    },
  );

  // Email — create inbox. 2.00 USDC.
  addTool(server, 
    "email_create_inbox",
    {
      title: "Create email inbox",
      description:
        "Provision an email inbox at {name}@palmyr.ai (or a custom domain you own), keyed to your wallet. Costs 2.00 USDC, paid per-action via x402.",
      inputSchema: {
        name: z.string().describe("Local part of the address; inbox becomes {name}@palmyr.ai"),
        walletAddress: z.string().optional().describe("Solana pubkey to enable E2E encryption (defaults to the payer)"),
        solanaPublicKey: z.string().optional(),
        domain: z.string().optional().describe("A Namecheap-registered domain you own; auto-sets MX/SPF/DKIM"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/email/inboxes", rest, payment);
    },
  );

  // Email — send. 0.08 USDC.
  addTool(server, 
    "email_send",
    {
      title: "Send email",
      description:
        "Send an email from an inbox you own. Costs 0.08 USDC, paid per-action via x402.",
      inputSchema: {
        inbox_id: z.string().describe("Inbox id returned by email_create_inbox"),
        to: z.string().describe("Recipient email address"),
        subject: z.string(),
        body: z.string(),
        html: z.string().optional(),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any) => {
      const { payment, inbox_id, ...rest } = args;
      return callRoute("POST", `/email/inboxes/${encodeURIComponent(inbox_id)}/send`, rest, payment);
    },
  );

  // Email — read messages. 0.02 USDC.
  addTool(server, 
    "email_read_messages",
    {
      title: "Read email messages",
      description:
        "Read decrypted messages from an inbox you own (payment wallet must match the inbox). Costs 0.02 USDC, paid per-action via x402.",
      inputSchema: {
        inbox_id: z.string().describe("Inbox id returned by email_create_inbox"),
        limit: z.number().optional().describe("Page size (default 50, max 200)"),
        cursor: z.string().optional().describe("id of the last message from the previous page"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any) => {
      const { payment, inbox_id, limit, cursor } = args;
      return callRoute(
        "GET",
        `/email/inboxes/${encodeURIComponent(inbox_id)}/messages${qs({ limit, cursor })}`,
        undefined,
        payment,
      );
    },
  );

  // Phone — buy number. 3.00 USDC.
  addTool(server, 
    "phone_buy_number",
    {
      title: "Buy phone number",
      description:
        "Provision a real phone number (SMS + voice) for your agent. Costs 3.00 USDC, paid per-action via x402.",
      inputSchema: {
        country: z.string().describe("ISO-2 country code, e.g. 'US'"),
        areaCode: z.string().optional(),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/phone/numbers", rest, payment);
    },
  );

  // Phone — send SMS. 0.05 USDC.
  addTool(server, 
    "phone_send_sms",
    {
      title: "Send SMS",
      description:
        "Send an SMS from a phone number you own. Costs 0.05 USDC, paid per-action via x402.",
      inputSchema: {
        number_id: z.string().describe("Phone number id returned by phone_buy_number"),
        to: z.string().describe("Recipient number in E.164, e.g. '+15551234567'"),
        body: z.string(),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any) => {
      const { payment, number_id, ...rest } = args;
      return callRoute("POST", `/phone/numbers/${encodeURIComponent(number_id)}/send`, rest, payment);
    },
  );

  // Phone — read messages. 0.02 USDC.
  addTool(server, 
    "phone_read_messages",
    {
      title: "Read SMS messages",
      description:
        "Read SMS messages received on a phone number you own. Costs 0.02 USDC, paid per-action via x402.",
      inputSchema: {
        number_id: z.string().describe("Phone number id returned by phone_buy_number"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any) => {
      const { payment, number_id } = args;
      return callRoute("GET", `/phone/numbers/${encodeURIComponent(number_id)}/messages`, undefined, payment);
    },
  );

  // Twitter/X — post. 0.001 USDC.
  addTool(server, 
    "twitter_post",
    {
      title: "Post to X (Twitter)",
      description:
        "Post a tweet from an X account you control (via injected session cookies). Costs 0.001 USDC, paid per-action via x402.",
      inputSchema: {
        account_id: z.string().describe("Your identifier for the X account"),
        cookies: z.array(z.any()).describe("Non-empty array of session cookies for the X account"),
        text: z.string().describe("Tweet text"),
        proxy_session_id: z.string().optional(),
        community_id: z.string().optional(),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/social/twitter/post", rest, payment);
    },
  );

  // TikTok — post (async). 0.01 USDC.
  addTool(server, 
    "tiktok_post",
    {
      title: "Post to TikTok",
      description:
        "Post a video to a TikTok account you control (from video_base64 or video_url). Async: returns an operation to poll. Costs 0.01 USDC, paid per-action via x402.",
      inputSchema: {
        account_id: z.string().describe("Your identifier for the TikTok account"),
        cookies: z.array(z.any()).describe("Non-empty array of session cookies for the TikTok account"),
        caption: z.string(),
        video_base64: z.string().optional().describe("Base64 video bytes — only fits tiny clips (the MCP transport caps request bodies at 1mb); prefer video_url"),
        video_url: z.string().optional().describe("Public URL to the video (preferred; no size limit)"),
        proxy_session_id: z.string().optional(),
        country: z.string().optional(),
        privacy: z.string().optional(),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/social/tiktok/post", rest, payment);
    },
  );

  // Domains — check availability. Free.
  addTool(server, 
    "domain_check",
    {
      title: "Check domain availability",
      description:
        "Check domain availability and per-TLD pricing. Pass a full domain (example.com) or a bare name to scan popular TLDs. Free — no payment required.",
      inputSchema: {
        domain: z.string().describe("A full domain (example.com) or a bare name (example)"),
      } as Shape,
    },
    async (args: any) => callRoute("GET", `/domains/check${qs({ domain: args.domain })}`, undefined, undefined),
  );

  // Domains — register (dynamic price). Priced per TLD.
  addTool(server, 
    "domain_register",
    {
      title: "Register domain",
      description:
        "Register a domain to your wallet. Priced per TLD — the exact quote is returned in the 402 challenge, paid per-action via x402.",
      inputSchema: {
        domain: z.string().describe("Full domain to register, e.g. 'example.com'"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/domains/register", rest, payment);
    },
  );

  // Compute — deploy VPS (dynamic price). Priced per server type.
  addTool(server, 
    "compute_deploy",
    {
      title: "Deploy VPS",
      description:
        "Deploy a cloud VPS keyed to your wallet (optionally auto-installs OpenClaw/skills). Priced per server type — the exact quote is returned in the 402 challenge, paid per-action via x402.",
      inputSchema: {
        name: z.string().describe("Server name"),
        serverType: z.string().describe("Hetzner server type, e.g. 'cx22'"),
        image: z.string().optional().describe("OS image (default 'ubuntu-24.04')"),
        location: z.string().optional(),
        install: z.union([z.string(), z.array(z.string())]).optional().describe("Recipe name(s) to install, e.g. 'openclaw'"),
        sshPublicKey: z.string().optional(),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/compute/servers", rest, payment);
    },
  );
}
