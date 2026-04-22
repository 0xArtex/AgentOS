import type { StepHandler, StepExecutionContext } from "./i402-executor";
import * as domainService from "./domain";
import * as computeService from "./compute";
import * as emailService from "./email";
import { poolBuy } from "./social-pool";
import { postTweet } from "./social-operations";
import { llm } from "./i402-llm";
import { DEFAULT_ROUTER_MODEL } from "./i402-llm";
import { externalHttpHandler } from "./i402-external-handlers";

// -------------------- Helpers --------------------

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing or invalid '${field}' (expected string)`);
  }
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string")) {
    throw new Error(`Missing or invalid '${field}' (expected string[])`);
  }
  return value as string[];
}

function splitDomain(fqdn: string): { name: string; tld: string } {
  const parts = fqdn.split(".");
  if (parts.length < 2) throw new Error(`Invalid domain: ${fqdn}`);
  const tld = parts.pop()!;
  const name = parts.join(".");
  return { name, tld };
}

// -------------------- Individual handlers --------------------

export const registerDomainHandler: StepHandler = async (input, ctx) => {
  const preferences = asStringArray(input.domain_preferences, "domain_preferences");
  let lastErr: unknown;
  for (const fqdn of preferences) {
    try {
      const { name, tld } = splitDomain(fqdn);
      const result = await domainService.register(name, tld, ctx.walletAddress);
      return {
        domain_registered: result.domain,
        expires_at: result.expiresAt,
        registrar: result.registrar,
        dns_nameservers: [],
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`All domain preferences failed: ${(lastErr as Error)?.message ?? lastErr}`);
};

export const deployVpsHandler: StepHandler = async (input, ctx) => {
  const plan = asString(input.plan ?? "cx23", "plan");
  const image = asOptionalString(input.image) ?? "ubuntu-24.04";
  const server = await computeService.createServer(
    `agent-${ctx.sessionId.slice(0, 8)}-${Date.now()}`,
    plan as any,
    image,
    ctx.walletAddress,
    undefined,
    true
  );
  return {
    server_id: server.id,
    ipv4: server.ipv4,
    ipv6: server.ipv6,
    status: server.status,
  };
};

export const provisionEmailInboxHandler: StepHandler = async (input, ctx) => {
  const localPart = asOptionalString(input.local_part) ?? `agent-${ctx.sessionId.slice(5, 13)}`;
  const inbox = emailService.createInbox(localPart, ctx.walletAddress, ctx.walletAddress);
  return {
    address: inbox.address,
    inbox_id: inbox.id,
  };
};

function makeSocialAccountHandler(platform: "x" | "tiktok"): StepHandler {
  return async (_input, ctx) => {
    // social-pool currently supports twitter only. TikTok provisioning will
    // become pool-backed once the TikTok pool pipeline ships; until then,
    // return a clear error instead of silently failing.
    if (platform === "tiktok") {
      throw new Error("TikTok pool provisioning not yet wired into i402 handler — falls back at executor level");
    }
    const result = poolBuy({ platform: "twitter", buyer_wallet: ctx.walletAddress });
    if (!result.success || !result.account) {
      throw new Error(result.error ?? "Pool buy failed");
    }
    return {
      platform,
      handle: result.account.username,
      account_id: result.account.id,
      warming_status: "ready",
    };
  };
}

function makeSocialPostHandler(platform: "x" | "tiktok"): StepHandler {
  return async (input, _ctx) => {
    const accountId = asString(input.account_id, "account_id");
    const text = asString(input.content ?? input.text, "content");
    if (platform === "tiktok") {
      throw new Error("TikTok posting not yet wired into i402 handler");
    }
    const result = await postTweet({
      account_id: accountId,
      proxy_session_id: asString(input.proxy_session_id ?? "", "proxy_session_id"),
      cookies: (input.cookies as any[]) ?? [],
      text,
    });
    if (!result.success || !result.data) {
      throw new Error(result.error ?? "postTweet failed");
    }
    return {
      post_id: result.data.tweet_id ?? "unknown",
      url: result.data.tweet_url ?? "unknown",
      posted_at: new Date().toISOString(),
    };
  };
}

/**
 * Fallback AgentOS web search handler — used when no external provider
 * (Exa, Tavily, AM) is available. Returns a minimal shape that downstream
 * steps can template against, so a Tier B demo can still make progress in
 * offline / unconfigured environments.
 */
export const webSearchFallbackHandler: StepHandler = async (input) => {
  const query = asString(input.query, "query");
  return {
    results: [
      {
        title: `AgentOS fallback result: ${query}`,
        url: "https://agntos.dev/search-fallback",
        snippet:
          "AgentOS fallback search. Configure EXA_API_KEY or enable Agentic Market federation for real search results.",
      },
    ],
  };
};

/**
 * Real Exa-backed web search. Requires EXA_API_KEY.
 *
 * Exa API (https://docs.exa.ai/reference/search):
 *   POST https://api.exa.ai/search
 *   Header: x-api-key: <key>
 *   Body: { query, numResults?, startPublishedDate?, useAutoprompt? }
 *   Response: { results: [{ title, url, publishedDate?, text?, score? }] }
 */
export const exaWebSearchHandler: StepHandler = externalHttpHandler({
  providerId: "exa.web_search",
  endpoint: "https://api.exa.ai/search",
  method: "POST",
  auth: { kind: "api_key", header: "x-api-key", valueEnv: "EXA_API_KEY" },
  transformInput: (input) => {
    const out: Record<string, unknown> = { query: input.query };
    if (typeof input.max_results === "number") out.numResults = input.max_results;
    if (typeof input.freshness_days === "number") {
      const cutoff = new Date(Date.now() - input.freshness_days * 86400 * 1000).toISOString().slice(0, 10);
      out.startPublishedDate = cutoff;
    }
    out.type = "neural";
    return out;
  },
  transformOutput: (raw) => {
    const parsed = raw as { results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }> };
    return {
      results: (parsed.results ?? []).map(r => ({
        title: r.title ?? "(untitled)",
        url: r.url ?? "",
        snippet: (r.text ?? "").slice(0, 500),
        published: r.publishedDate,
      })),
    };
  },
});

export const summarizeHandler: StepHandler = async (input) => {
  const text = Array.isArray(input.text) ? (input.text as string[]).join("\n\n") : asString(input.text, "text");
  const style = asOptionalString(input.style) ?? "brief";
  const maxTokens = typeof input.max_tokens === "number" ? (input.max_tokens as number) : 500;

  const res = await llm.completeText({
    model: DEFAULT_ROUTER_MODEL(),
    system: [
      {
        cache: true,
        text: "You are a concise summarizer. Produce summaries in the style requested: 'brief' = 2-3 sentences, 'detailed' = one paragraph, 'bullets' = 3-5 bullet points. Do not preface with 'Here is a summary' or similar filler.",
      },
    ],
    messages: [{ role: "user", content: `Style: ${style}\n\nText to summarize:\n\n${text}` }],
    maxTokens,
    temperature: 0.2,
  });

  return {
    summary: res.content,
    token_count: res.usage.tokensOut,
  };
};

// -------------------- Unimplemented stub factory --------------------

function unimplementedHandler(providerId: string): StepHandler {
  return async () => {
    throw new Error(
      `Provider ${providerId} handler is not wired in this build. The executor's fallback mechanism will retry with an alternate provider for the same capability if one is registered.`
    );
  };
}

// -------------------- Assembly --------------------

/**
 * Build the default handler map for AgentOS-owned providers.
 * External / Agentic Market / ClawHub providers need their own handler wiring
 * (scheduled for Checkpoint 5).
 */
export function buildDefaultHandlers(): Record<string, StepHandler> {
  return {
    "agentos.web_search": webSearchFallbackHandler,
    "exa.web_search": exaWebSearchHandler,
    "agentos.register_domain": registerDomainHandler,
    "agentos.deploy_vps": deployVpsHandler,
    "agentos.provision_email_inbox": provisionEmailInboxHandler,
    "agentos.x_account": makeSocialAccountHandler("x"),
    "agentos.tiktok_account": makeSocialAccountHandler("tiktok"),
    "agentos.x_post": makeSocialPostHandler("x"),
    "agentos.tiktok_post": makeSocialPostHandler("tiktok"),
    // summarize runs on the router model with prompt caching enabled
    "anthropic.summarize": summarizeHandler,

    // Unimplemented-in-v0.1 stubs — executor will see the clear error and either
    // fall back to another provider (if registered) or surface it as a fatal step_error.
    "agentos.send_sms": unimplementedHandler("agentos.send_sms"),
    "agentos.voice_call": unimplementedHandler("agentos.voice_call"),
    "agentos.provision_phone": unimplementedHandler("agentos.provision_phone"),
    "agentos.send_email": unimplementedHandler("agentos.send_email"),
    "agentos.read_email": unimplementedHandler("agentos.read_email"),
    "agentos.dns_manage": unimplementedHandler("agentos.dns_manage"),
    "agentos.code_exec": unimplementedHandler("agentos.code_exec"),
    "agentos.file_store": unimplementedHandler("agentos.file_store"),
  };
}
