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

type TextToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  // v2 x402 PaymentRequired on a 402 challenge (spec: mirrored in content[0].text).
  structuredContent?: any;
  // Transport-level x402 signals: { "x402/error": PaymentRequired } on a challenge,
  // { "x402/payment-response": SettleResponse } on a settled success.
  _meta?: Record<string, any>;
};

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
}): Promise<{ status: number; text: string; json: any; headers: Record<string, string> }> {
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
  // Flatten response headers (lowercased keys) so callRoute can read the
  // spec settlement receipt (PAYMENT-RESPONSE) the x402 middleware sets.
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    respHeaders[k.toLowerCase()] = v;
  });
  return { status: resp.status, text, json, headers: respHeaders };
}

/**
 * Decode the base64 `PAYMENT-RESPONSE` header (the x402 v2 SettleResponse the
 * middleware sets on a settled request) into an object, or null if absent/bad.
 */
function decodePaymentResponseHeader(headers: Record<string, string>): any | null {
  const raw = headers["payment-response"];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Map a proxied loopback response to an MCP tool result — the settled-vs-challenge
 * discrimination, extracted as a pure function so it's unit-testable.
 *
 * CRITICAL (double-charge guard): a 402 that carries a settlement RECEIPT is a
 * SETTLED response, NOT a fresh "pay me" challenge — if we re-issued a payment
 * challenge there, the agent would pay AGAIN, an unbounded double-charge loop.
 * So: whenever a PAYMENT-RESPONSE receipt is present, pass the body through and
 * attach the receipt; only a receipt-LESS 402 is a genuine payment challenge.
 *
 * This guard is what kept MCP callers safe while the i402 resolver (`/chat`)
 * still returned HTTP 402 as its "here is the plan" data channel *after* the
 * orchestration fee settled. That route now answers 200 (see
 * routes/agent-chat.ts) — plain HTTP clients had no receipt-check and were
 * double-charging — but the receipt rule stays: it is the only correct way to
 * read a 402 in general, and it keeps this proxy compatible with any
 * still-deployed build that answers the old way.
 *
 *  • receipt present → settled: pass body through + `_meta["x402/payment-response"]`.
 *    (402/2xx = non-error data — incl. an i402 plan; non-402 ≥400 = the handler
 *    failed after settling, typically refunded → surface as `isError`.)
 *  • 402 without receipt → the v2 `PaymentRequired` challenge as `isError:true`,
 *    in `structuredContent`, byte-equal `content[0].text`, `_meta["x402/error"]`.
 *  • other 2xx → body as text (free/unpaid path).
 *  • other 4xx/5xx → `isError:true` with status + body.
 */
export function buildToolResult(
  status: number,
  text: string,
  json: any,
  headers: Record<string, string>,
  toolName?: string,
): TextToolResult {
  const settle = decodePaymentResponseHeader(headers);

  if (settle) {
    const isErr = status >= 400 && status !== 402;
    return {
      ...(isErr ? { isError: true } : {}),
      content: [{ type: "text", text }],
      _meta: { "x402/payment-response": settle },
    };
  }

  if (status === 402) {
    // Our HTTP 402 body is already a full v2 PaymentRequired; pass it through as
    // the spec challenge. `error` falls back to the body message / instructions.
    const pr = {
      x402Version: json?.x402Version ?? 2,
      error: json?.error ?? json?.message ?? PAY_INSTRUCTIONS,
      resource: json?.resource ?? { url: `mcp://tool/${toolName ?? "palmyr"}`, mimeType: "application/json" },
      accepts: json?.accepts ?? [],
    };
    return {
      isError: true,
      structuredContent: pr,
      content: [{ type: "text", text: JSON.stringify(pr) }],
      _meta: { "x402/error": pr },
    };
  }

  if (status >= 200 && status < 300) {
    return { content: [{ type: "text", text }] };
  }

  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: true, status, body: json ?? text }) }],
  };
}

/**
 * Shared handler for a proxied route, implementing the transport-level x402
 * exchange (x402-foundation MCP transport spec) alongside the legacy
 * `payment=<base64>` tool-argument fallback. Payment source — the decoded
 * PaymentPayload the client puts at `params._meta["x402/payment"]` (forwarded by
 * the SDK as `extra._meta["x402/payment"]`) OR the base64 `payment` arg. Both
 * converge on the single loopback X-PAYMENT settlement (the loopback API is the
 * only settler). Response mapping is delegated to `buildToolResult`.
 */
async function callRoute(
  method: string,
  path: string,
  body: unknown,
  paymentArg: string | undefined,
  extra?: any,
  toolName?: string,
): Promise<TextToolResult> {
  // Transport-native payment: the client sends the DECODED PaymentPayload at
  // params._meta["x402/payment"]. Re-encode it to the standard base64 X-PAYMENT
  // header so it settles through the same loopback path as the `payment=` arg.
  const metaPay = extra?._meta?.["x402/payment"];
  const xPayment =
    paymentArg ?? (metaPay ? Buffer.from(JSON.stringify(metaPay)).toString("base64") : undefined);

  let result: { status: number; text: string; json: any; headers: Record<string, string> };
  try {
    result = await proxyToApi({ method, path, body, payment: xPayment });
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: true, message: err?.message || String(err) }) }],
    };
  }

  const { status, text, json, headers } = result;
  return buildToolResult(status, text, json, headers, toolName);
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
  cb: (args: any, extra: any) => Promise<TextToolResult>,
): void {
  // Pass `extra` (RequestHandlerExtra) through so paid handlers can read the
  // transport-native payment at extra._meta["x402/payment"].
  (server.registerTool as any)(name, config, (args: any, extra: any) => cb(args, extra));
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
    async (args: any, extra: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/chat", rest, payment, extra, "i402_plan");
    },
  );

  // Cards — buy a prepaid Visa card with an exact balance. Dynamic price.
  addTool(server,
    "card_buy",
    {
      title: "Buy prepaid Visa card",
      description:
        "Buy a USA prepaid Visa card loaded with EXACTLY the requested balance ($5–$1000). " +
        "Dynamic x402 price = amount + fee (3% min 0.50 USDC) — the 402 instructions carry the exact total. " +
        "Returns 202 with an operation_id: poll card_status until ready (~10s), then fetch the number with card_get. " +
        "US merchants only; non-reloadable (spend across transactions until depleted); max 6 cards per agent per rolling 24h (issuer limit).",
      inputSchema: {
        amount: z.number().describe("USD balance to load on the card (min $5, max $1000, whole cents)"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any, extra: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/cards/buy", rest, payment, extra, "card_buy");
    },
  );

  // Cards — poll a purchase. Free.
  addTool(server,
    "card_status",
    {
      title: "Check card purchase status",
      description:
        "Poll a card purchase started by card_buy (free). done=true when status is 'ready' (fetch details with card_get) " +
        "or 'failed' (payment auto-refunded — see refund_status).",
      inputSchema: {
        card_id: z.string().describe("operation_id / card_id returned by card_buy"),
      } as Shape,
    },
    async (args: any, extra: any) => {
      return callRoute("GET", `/cards/operations/${encodeURIComponent(args.card_id)}`, {}, undefined, extra, "card_status");
    },
  );

  // Cards — full details. 0.01 USDC ownership proof.
  addTool(server,
    "card_get",
    {
      title: "Get card number/CVV",
      description:
        "Retrieve a prepaid card you own: full card number, CVV, expiry, live balance. Owner-verified " +
        "(0.01 USDC ownership proof; the paying wallet must be the card's buyer).",
      inputSchema: {
        card_id: z.string().describe("card_id returned by card_buy"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any, extra: any) => {
      const { payment, card_id } = args;
      return callRoute("GET", `/cards/${encodeURIComponent(card_id)}`, {}, payment, extra, "card_get");
    },
  );

  // Cards — list. 0.01 USDC ownership proof.
  addTool(server,
    "card_list",
    {
      title: "List your prepaid cards",
      description:
        "List cards owned by the paying wallet: status, last4, balance (never full numbers — those are per-card via card_get). " +
        "0.01 USDC ownership proof.",
      inputSchema: {
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any, extra: any) => {
      const { payment } = args;
      return callRoute("GET", "/cards", {}, payment, extra, "card_list");
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
    async (args: any, extra: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/email/inboxes", rest, payment, extra, "email_create_inbox");
    },
  );

  // Email — create a disposable temp inbox. 0.50 USDC.
  addTool(server,
    "email_create_temp",
    {
      title: "Create disposable temp inbox",
      description:
        "Provision a cheap, disposable, receive-only email inbox — ideal for receiving a one-off verification or order-confirmation email during a checkout/signup flow. The address (a natural-looking handle on a dedicated inbox domain) is returned in the response. Auto-expires (default 24h). Reads return plaintext to the owning wallet (no E2E key to manage). Costs 0.50 USDC, paid per-action via x402.",
      inputSchema: {
        ttl_seconds: z.number().optional().describe("Lifetime in seconds before the inbox auto-expires (default 86400 = 24h, min 300, max 604800)"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any, extra: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/email/temp", rest, payment, extra, "email_create_temp");
    },
  );

  // Email — extend a temp inbox's TTL. 0.50 USDC.
  addTool(server,
    "email_extend_temp",
    {
      title: "Extend disposable temp inbox",
      description:
        "Rent another 7 days on a live disposable temp inbox — each call pushes expires_at exactly 7 days further (fixed, stackable, no cap). Owner-only; expired temp inboxes cannot be revived (buy a new one via email_create_temp). Costs 0.50 USDC, paid per-action via x402.",
      inputSchema: {
        inbox_id: z.string().describe("Temp inbox id returned by email_create_temp"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any, extra: any) => {
      const { payment, inbox_id } = args;
      return callRoute("POST", `/email/temp/${encodeURIComponent(inbox_id)}/extend`, {}, payment, extra, "email_extend_temp");
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
    async (args: any, extra: any) => {
      const { payment, inbox_id, ...rest } = args;
      return callRoute("POST", `/email/inboxes/${encodeURIComponent(inbox_id)}/send`, rest, payment, extra, "email_send");
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
    async (args: any, extra: any) => {
      const { payment, inbox_id, limit, cursor } = args;
      return callRoute(
        "GET",
        `/email/inboxes/${encodeURIComponent(inbox_id)}/messages${qs({ limit, cursor })}`,
        undefined,
        payment,
        extra,
        "email_read_messages",
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
    async (args: any, extra: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/phone/numbers", rest, payment, extra, "phone_buy_number");
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
    async (args: any, extra: any) => {
      const { payment, number_id, ...rest } = args;
      return callRoute("POST", `/phone/numbers/${encodeURIComponent(number_id)}/send`, rest, payment, extra, "phone_send_sms");
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
    async (args: any, extra: any) => {
      const { payment, number_id } = args;
      return callRoute("GET", `/phone/numbers/${encodeURIComponent(number_id)}/messages`, undefined, payment, extra, "phone_read_messages");
    },
  );

  // Phone — blocking wait for an SMS verification code (OTP). 0.02 USDC.
  addTool(server,
    "wait_for_otp",
    {
      title: "Wait for SMS verification code (OTP)",
      description:
        "Wait for an SMS verification code / OTP to arrive on a Palmyr phone number you own, and return the parsed code. " +
        "Blocks up to timeout_s (default 60, max 90) checking every ~2s — one call replaces hand-rolled polling of phone_read_messages " +
        "during account signups and 2FA flows. Messages that arrived up to lookback_s seconds (default 10) BEFORE the call also match, " +
        "so a code that landed early is not missed — pass lookback_s=0 when reusing a number across signups so a stale code can't be re-served. " +
        "Default extraction handles standalone 4-8 digit codes, 'code is/code:' tokens, and Google-style G-XXXXXX; pass pattern to override " +
        "(max 256 chars; a pattern that blows its per-match budget is dropped mid-wait and pattern_timeout: true is reported). " +
        "Returns { found: true, code, message_text } on a hit or { found: false, waited_s } on timeout (not an error — just call again). " +
        "Costs 0.02 USDC, paid per-action via x402.",
      inputSchema: {
        number_id: z.string().describe("Phone number id returned by phone_buy_number"),
        timeout_s: z.number().optional().describe("Seconds to block waiting (default 60, max 90)"),
        lookback_s: z.number().optional().describe("Also match messages received up to this many seconds before the call (default 10; use 0 for reused numbers)"),
        pattern: z.string().optional().describe("Custom extraction regex overriding the default OTP formats (first capture group wins, else the full match; max 256 chars)"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any, extra: any) => {
      const { payment, number_id, ...rest } = args;
      return callRoute("POST", `/phone/numbers/${encodeURIComponent(number_id)}/wait-otp`, rest, payment, extra, "wait_for_otp");
    },
  );

  // Phone — lease a disposable receive-only temp number. 0.20 USDC.
  addTool(server,
    "phone_temp_number",
    {
      title: "Lease disposable temp phone number",
      description:
        "Lease a cheap, instant, receive-only US phone number from a pool to receive one SMS verification code — the phone analogue of a disposable temp email inbox. $0.20 for 30 min (ttl_seconds, clamped 300–1800), returned to the pool at expiry; call wait_for_otp to catch the code. " +
        "Good for one-time SMS verification and phone-gated signups. Works with major sites like Google, X, and Discord; some (Telegram, WhatsApp, OpenAI) may reject it as a VoIP number — for strict sites, buy a dedicated number with phone_buy_number. Pool numbers are recycled after the lease, so use them for one-time codes only, not long-term 2FA. Costs 0.20 USDC, paid per-action via x402.",
      inputSchema: {
        ttl_seconds: z.number().optional().describe("Lease lifetime in seconds before auto-expiry (default 1800 = 30min, min 300, max 1800)"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any, extra: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/phone/temp", rest, payment, extra, "phone_temp_number");
    },
  );

  // Phone — extend a temp number lease. 0.20 USDC.
  addTool(server,
    "phone_extend_temp",
    {
      title: "Extend disposable temp phone number",
      description:
        "Rent another 30 minutes on a live disposable temp number — each call pushes expires_at 30 min further (stackable up to 24h total lease). Owner-only; expired temp leases cannot be revived (lease a fresh one via phone_temp_number). Costs 0.20 USDC, paid per-action via x402.",
      inputSchema: {
        number_id: z.string().describe("Temp number lease id returned by phone_temp_number"),
        payment: PAYMENT_PARAM,
      } as Shape,
    },
    async (args: any, extra: any) => {
      const { payment, number_id } = args;
      return callRoute("POST", `/phone/temp/${encodeURIComponent(number_id)}/extend`, {}, payment, extra, "phone_extend_temp");
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
    async (args: any, extra: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/social/twitter/post", rest, payment, extra, "twitter_post");
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
    async (args: any, extra: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/social/tiktok/post", rest, payment, extra, "tiktok_post");
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
    async (args: any, extra: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/domains/register", rest, payment, extra, "domain_register");
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
    async (args: any, extra: any) => {
      const { payment, ...rest } = args;
      return callRoute("POST", "/compute/servers", rest, payment, extra, "compute_deploy");
    },
  );
}
