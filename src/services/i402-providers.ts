import crypto from "crypto";
import { db } from "../db";

// -------------------- Types --------------------

export type I402ProviderSource =
  | "agentos"
  | "agentic_market"
  | "external"
  | "clawhub"
  | "agent_composed";

export type I402AuthScheme =
  | "internal"
  | "x402-solana"
  | "x402-base"
  | "api_key"
  | "wallet_sig";

export type I402Quality = "fast" | "cheap" | "best";

export interface I402Provider {
  id: string;
  source: I402ProviderSource;
  capability: string;
  name: string;
  description?: string;
  endpoint: string;
  method: string;
  authScheme: I402AuthScheme;
  inputSchema: unknown;
  outputSchema: unknown;
  costPerCallUsdc: number;
  p50LatencyMs?: number;
  p99LatencyMs?: number;
  successRate: number;
  reputationScore: number;
  enabled: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityClass {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  isCompound?: boolean;
}

interface ProviderRow {
  id: string;
  source: I402ProviderSource;
  capability: string;
  name: string;
  description: string | null;
  endpoint: string;
  method: string;
  auth_scheme: I402AuthScheme;
  input_schema: string;
  output_schema: string;
  cost_per_call_usdc: number;
  p50_latency_ms: number | null;
  p99_latency_ms: number | null;
  success_rate: number;
  reputation_score: number;
  enabled: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProvider(row: ProviderRow): I402Provider {
  return {
    id: row.id,
    source: row.source,
    capability: row.capability,
    name: row.name,
    description: row.description ?? undefined,
    endpoint: row.endpoint,
    method: row.method,
    authScheme: row.auth_scheme,
    inputSchema: JSON.parse(row.input_schema),
    outputSchema: JSON.parse(row.output_schema),
    costPerCallUsdc: row.cost_per_call_usdc,
    p50LatencyMs: row.p50_latency_ms ?? undefined,
    p99LatencyMs: row.p99_latency_ms ?? undefined,
    successRate: row.success_rate,
    reputationScore: row.reputation_score,
    enabled: row.enabled === 1,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// -------------------- Canonical capability classes (v0.1) --------------------

export const CAPABILITY_CLASSES: Record<string, CapabilityClass> = {
  web_search: {
    name: "web_search",
    description: "Search the web and return ranked results.",
    inputSchema: {
      query: { type: "string", required: true },
      max_results: { type: "number", default: 10, max: 50 },
      freshness_days: { type: "number", optional: true },
    },
    outputSchema: {
      results: {
        type: "array",
        items: { title: "string", url: "string", snippet: "string", published: "iso8601?" },
      },
    },
  },
  web_scrape: {
    name: "web_scrape",
    description: "Fetch and extract content from a URL.",
    inputSchema: {
      url: { type: "string", required: true },
      selector: { type: "string", optional: true },
    },
    outputSchema: { content: "string", title: "string?", meta: "object?" },
  },
  summarize: {
    name: "summarize",
    description: "Produce a summary of input text or documents.",
    inputSchema: {
      text: { type: "string|string[]", required: true },
      style: { type: "enum", values: ["brief", "detailed", "bullets"], default: "brief" },
      max_tokens: { type: "number", default: 500 },
    },
    outputSchema: { summary: "string", token_count: "number" },
  },
  embed: {
    name: "embed",
    description: "Produce vector embeddings for text.",
    inputSchema: { text: "string|string[]" },
    outputSchema: { embeddings: "number[][]", dim: "number" },
  },
  image_gen: {
    name: "image_gen",
    description: "Generate an image from a text prompt.",
    inputSchema: {
      prompt: { type: "string", required: true },
      aspect_ratio: { type: "string", default: "1:1" },
      style: { type: "string", optional: true },
    },
    outputSchema: { url: "string", width: "number", height: "number" },
  },
  video_gen: {
    name: "video_gen",
    description: "Generate a short video from a text prompt.",
    inputSchema: { prompt: "string", duration_seconds: "number" },
    outputSchema: { url: "string", duration_seconds: "number" },
  },
  tts: {
    name: "tts",
    description: "Synthesize speech audio from text.",
    inputSchema: { text: "string", voice: "string?", language: "string?" },
    outputSchema: { audio_url: "string", duration_ms: "number" },
  },
  stt: {
    name: "stt",
    description: "Transcribe speech audio to text.",
    inputSchema: { audio_url: "string", language: "string?" },
    outputSchema: { text: "string", duration_ms: "number" },
  },
  send_sms: {
    name: "send_sms",
    description: "Send an SMS from a provisioned phone number.",
    inputSchema: { from: "string", to: "string", body: "string" },
    outputSchema: { message_id: "string", status: "string" },
  },
  voice_call: {
    name: "voice_call",
    description: "Initiate an outbound voice call.",
    inputSchema: { from: "string", to: "string", script: "string?" },
    outputSchema: { call_id: "string", status: "string" },
  },
  provision_phone: {
    name: "provision_phone",
    description: "Provision a new phone number from a registrar.",
    inputSchema: { country: "string", capabilities: "string[]?" },
    outputSchema: { phone_number: "string", country: "string", capabilities: "string[]" },
  },
  provision_email_inbox: {
    name: "provision_email_inbox",
    description: "Create an email inbox, optionally at a custom domain.",
    inputSchema: { local_part: "string?", domain: "string?" },
    outputSchema: { address: "string", inbox_id: "string" },
  },
  send_email: {
    name: "send_email",
    description: "Send an email from an owned inbox.",
    inputSchema: { from: "string", to: "string|string[]", subject: "string", body: "string", html: "string?" },
    outputSchema: { message_id: "string" },
  },
  read_email: {
    name: "read_email",
    description: "Read messages from an owned inbox.",
    inputSchema: { inbox_id: "string", limit: "number?", since: "iso8601?" },
    outputSchema: { messages: "object[]" },
  },
  deploy_vps: {
    name: "deploy_vps",
    description: "Provision a cloud VPS with cloud-init and SSH access.",
    inputSchema: {
      plan: { type: "string", values: ["cx23", "cx33", "cx43", "cx53", "cpx11", "cpx21", "cpx31", "cpx41", "cpx51"] },
      region: "string?",
      ssh_public_key: "string?",
      cloud_init: "string?",
    },
    outputSchema: { server_id: "string", ipv4: "string", ipv6: "string?", status: "string" },
  },
  register_domain: {
    name: "register_domain",
    description: "Register a new domain name via a registrar.",
    inputSchema: {
      domain_preferences: "string[]",
      tld_preference: "string[]?",
      years: { type: "number", default: 1, max: 10 },
    },
    outputSchema: { domain_registered: "string", expires_at: "iso8601", registrar: "string", dns_nameservers: "string[]" },
  },
  dns_manage: {
    name: "dns_manage",
    description: "Create, update, or delete DNS records on an owned domain.",
    inputSchema: { domain: "string", action: { type: "enum", values: ["create", "update", "delete"] }, record: "object" },
    outputSchema: { record_id: "string" },
  },
  social_account_provision: {
    name: "social_account_provision",
    description: "Provision a social media account from the pool, transferred to the agent's wallet.",
    inputSchema: {
      platform: { type: "enum", values: ["x", "tiktok", "reddit", "linkedin"] },
      country: "string?",
      handle_preference: "string[]?",
    },
    outputSchema: { platform: "string", handle: "string", account_id: "string", warming_status: "string" },
  },
  social_post: {
    name: "social_post",
    description: "Publish a post to an owned social account.",
    inputSchema: {
      platform: { type: "enum", values: ["x", "tiktok", "reddit", "linkedin"] },
      account_id: "string",
      content: "string",
      media_urls: "string[]?",
      schedule_at: "iso8601?",
    },
    outputSchema: { post_id: "string", url: "string", posted_at: "iso8601" },
  },
  code_exec: {
    name: "code_exec",
    description: "Execute code on an owned VPS and return output.",
    inputSchema: { server_id: "string", language: "string", source: "string", timeout_ms: "number?" },
    outputSchema: { stdout: "string", stderr: "string", exit_code: "number" },
  },
  file_store: {
    name: "file_store",
    description: "Store a file in object storage and return a signed URL.",
    inputSchema: { content_base64: "string", content_type: "string", name: "string?" },
    outputSchema: { url: "string", key: "string", size_bytes: "number" },
  },
  // Compound capabilities — expand into sub-plans via the planner.
  launch_product: {
    name: "launch_product",
    description: "End-to-end: market research, branding, domain, landing page, social presence, email.",
    isCompound: true,
    inputSchema: { niche: "string", target_audience: "string?", region: "string?" },
    outputSchema: { artifacts: "object[]" },
  },
  research_topic: {
    name: "research_topic",
    description: "Compound: search + summarize + synthesize into a structured report.",
    isCompound: true,
    inputSchema: { topic: "string", depth: { type: "enum", values: ["brief", "detailed"] } },
    outputSchema: { report: "string", citations: "string[]" },
  },
  grow_audience: {
    name: "grow_audience",
    description: "Compound: trending analysis + content generation + scheduled posting across owned socials.",
    isCompound: true,
    inputSchema: { topic: "string", platforms: "string[]", cadence: "string?" },
    outputSchema: { scheduled_posts: "object[]" },
  },
};

export function listCapabilities(): CapabilityClass[] {
  return Object.values(CAPABILITY_CLASSES);
}

export function getCapability(name: string): CapabilityClass | undefined {
  return CAPABILITY_CLASSES[name];
}

// -------------------- Registry CRUD --------------------

export interface RegisterProviderInput {
  id?: string;
  source: I402ProviderSource;
  capability: string;
  name: string;
  description?: string;
  endpoint: string;
  method?: string;
  authScheme: I402AuthScheme;
  inputSchema: unknown;
  outputSchema: unknown;
  costPerCallUsdc: number;
  p50LatencyMs?: number;
  p99LatencyMs?: number;
  reputationScore?: number;
  metadata?: Record<string, unknown>;
}

export function registerProvider(input: RegisterProviderInput): I402Provider {
  if (!CAPABILITY_CLASSES[input.capability]) {
    throw new Error(`Unknown capability class: ${input.capability}`);
  }
  const id = input.id ?? `${input.source}.${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT OR IGNORE INTO i402_providers (
      id, source, capability, name, description, endpoint, method, auth_scheme,
      input_schema, output_schema, cost_per_call_usdc, p50_latency_ms, p99_latency_ms,
      success_rate, reputation_score, enabled, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    id,
    input.source,
    input.capability,
    input.name,
    input.description ?? null,
    input.endpoint,
    input.method ?? "POST",
    input.authScheme,
    JSON.stringify(input.inputSchema),
    JSON.stringify(input.outputSchema),
    input.costPerCallUsdc,
    input.p50LatencyMs ?? null,
    input.p99LatencyMs ?? null,
    1.0,
    input.reputationScore ?? 0.5,
    input.metadata ? JSON.stringify(input.metadata) : null
  );
  const provider = getProvider(id);
  if (!provider) throw new Error(`Failed to register provider ${id}`);
  return provider;
}

export function getProvider(id: string): I402Provider | undefined {
  const row = db.prepare(`SELECT * FROM i402_providers WHERE id = ?`).get(id) as ProviderRow | undefined;
  return row ? rowToProvider(row) : undefined;
}

export function listProviders(filter: { capability?: string; source?: I402ProviderSource; enabledOnly?: boolean } = {}): I402Provider[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.capability) {
    clauses.push("capability = ?");
    params.push(filter.capability);
  }
  if (filter.source) {
    clauses.push("source = ?");
    params.push(filter.source);
  }
  if (filter.enabledOnly !== false) {
    clauses.push("enabled = 1");
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM i402_providers ${where} ORDER BY reputation_score DESC, cost_per_call_usdc ASC`).all(...params) as ProviderRow[];
  return rows.map(rowToProvider);
}

export function setProviderEnabled(id: string, enabled: boolean): void {
  db.prepare(`UPDATE i402_providers SET enabled = ?, updated_at = datetime('now','utc') WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export interface MetricsUpdate {
  latencyMs?: number;
  success?: boolean;
}

/**
 * Update rolling metrics for a provider after a step executes against it.
 * success_rate uses exponential moving average (alpha 0.1) so recent behavior dominates.
 */
export function updateProviderMetrics(id: string, metrics: MetricsUpdate): void {
  const provider = getProvider(id);
  if (!provider) return;
  const alpha = 0.1;
  let newSuccessRate = provider.successRate;
  if (metrics.success !== undefined) {
    newSuccessRate = provider.successRate * (1 - alpha) + (metrics.success ? 1 : 0) * alpha;
  }
  let newP50 = provider.p50LatencyMs ?? null;
  if (metrics.latencyMs !== undefined) {
    newP50 = provider.p50LatencyMs
      ? Math.round(provider.p50LatencyMs * (1 - alpha) + metrics.latencyMs * alpha)
      : metrics.latencyMs;
  }
  db.prepare(
    `UPDATE i402_providers SET success_rate = ?, p50_latency_ms = ?, updated_at = datetime('now','utc') WHERE id = ?`
  ).run(newSuccessRate, newP50, id);
}

// -------------------- Scoring / ranking --------------------

/**
 * Score and rank providers for a capability given a quality preference.
 * Weights depend on quality hint. Lower cost and lower latency are better.
 */
export function scoreProviders(capability: string, quality: I402Quality = "best"): I402Provider[] {
  const candidates = listProviders({ capability });
  if (candidates.length === 0) return [];

  const maxCost = Math.max(...candidates.map(c => c.costPerCallUsdc), 0.0001);
  const maxLat = Math.max(...candidates.map(c => c.p50LatencyMs ?? 1000), 1);

  const weights = {
    best: { reputation: 0.6, cost: 0.2, latency: 0.2 },
    cheap: { reputation: 0.2, cost: 0.7, latency: 0.1 },
    fast: { reputation: 0.2, cost: 0.1, latency: 0.7 },
  }[quality];

  const ranked = candidates
    .map(c => {
      const costScore = 1 - c.costPerCallUsdc / maxCost;
      const latScore = 1 - (c.p50LatencyMs ?? 1000) / maxLat;
      const relScore = c.reputationScore * c.successRate;
      const score = relScore * weights.reputation + costScore * weights.cost + latScore * weights.latency;
      return { provider: c, score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked.map(r => r.provider);
}

// -------------------- Seed: AgentOS first-party primitives --------------------

/**
 * Register every AgentOS-owned service as a provider in the i402 registry.
 * Idempotent — uses INSERT OR IGNORE so re-running leaves metrics intact.
 *
 * All endpoints use auth_scheme "x402-solana" for payment settlement, and the
 * canonical AgentOS API base is read from env or defaults to production.
 */
export function seedAgentOSPrimitives(): void {
  const base = process.env.AGENTOS_API_BASE ?? "https://agntos.dev";

  const primitives: RegisterProviderInput[] = [
    {
      id: "agentos.web_search",
      source: "agentos",
      capability: "web_search",
      name: "AgentOS fallback web search",
      description: "First-party search fallback when no real external provider is configured.",
      endpoint: `${base}/search`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.web_search.inputSchema,
      outputSchema: CAPABILITY_CLASSES.web_search.outputSchema,
      costPerCallUsdc: 0.10,
      p50LatencyMs: 2500,
      p99LatencyMs: 8000,
      reputationScore: 0.6,
    },
    {
      id: "exa.web_search",
      source: "external",
      capability: "web_search",
      name: "Exa web search",
      description: "Real Exa-backed web search with semantic ranking. Requires EXA_API_KEY.",
      endpoint: "https://api.exa.ai/search",
      authScheme: "api_key",
      inputSchema: CAPABILITY_CLASSES.web_search.inputSchema,
      outputSchema: CAPABILITY_CLASSES.web_search.outputSchema,
      costPerCallUsdc: 0.10,
      p50LatencyMs: 1800,
      p99LatencyMs: 6000,
      reputationScore: 0.9,
      metadata: { vendor: "exa", env: "EXA_API_KEY" },
    },
    {
      id: "agentos.provision_phone",
      source: "agentos",
      capability: "provision_phone",
      name: "AgentOS phone provisioning (Telnyx)",
      description: "Provision a real phone number in any of 150+ countries.",
      endpoint: `${base}/phone/numbers`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.provision_phone.inputSchema,
      outputSchema: CAPABILITY_CLASSES.provision_phone.outputSchema,
      costPerCallUsdc: 2.00,
      p50LatencyMs: 4000,
      p99LatencyMs: 15000,
      reputationScore: 0.9,
    },
    {
      id: "agentos.send_sms",
      source: "agentos",
      capability: "send_sms",
      name: "AgentOS SMS (Telnyx)",
      endpoint: `${base}/phone/sms`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.send_sms.inputSchema,
      outputSchema: CAPABILITY_CLASSES.send_sms.outputSchema,
      costPerCallUsdc: 0.05,
      p50LatencyMs: 800,
      p99LatencyMs: 3000,
      reputationScore: 0.9,
    },
    {
      id: "agentos.voice_call",
      source: "agentos",
      capability: "voice_call",
      name: "AgentOS voice calls (Telnyx)",
      endpoint: `${base}/voice/calls`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.voice_call.inputSchema,
      outputSchema: CAPABILITY_CLASSES.voice_call.outputSchema,
      costPerCallUsdc: 0.10,
      p50LatencyMs: 2000,
      p99LatencyMs: 10000,
      reputationScore: 0.85,
    },
    {
      id: "agentos.provision_email_inbox",
      source: "agentos",
      capability: "provision_email_inbox",
      name: "AgentOS email inbox",
      description: "Create a wallet-owned inbox at agntos.dev with E2E encryption.",
      endpoint: `${base}/email/inboxes`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.provision_email_inbox.inputSchema,
      outputSchema: CAPABILITY_CLASSES.provision_email_inbox.outputSchema,
      costPerCallUsdc: 1.00,
      p50LatencyMs: 1500,
      p99LatencyMs: 4000,
      reputationScore: 0.9,
    },
    {
      id: "agentos.send_email",
      source: "agentos",
      capability: "send_email",
      name: "AgentOS email send",
      endpoint: `${base}/email/send`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.send_email.inputSchema,
      outputSchema: CAPABILITY_CLASSES.send_email.outputSchema,
      costPerCallUsdc: 0.08,
      p50LatencyMs: 900,
      p99LatencyMs: 3000,
      reputationScore: 0.9,
    },
    {
      id: "agentos.read_email",
      source: "agentos",
      capability: "read_email",
      name: "AgentOS email read",
      endpoint: `${base}/email/messages`,
      method: "GET",
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.read_email.inputSchema,
      outputSchema: CAPABILITY_CLASSES.read_email.outputSchema,
      costPerCallUsdc: 0.02,
      p50LatencyMs: 400,
      p99LatencyMs: 1500,
      reputationScore: 0.9,
    },
    {
      id: "agentos.deploy_vps",
      source: "agentos",
      capability: "deploy_vps",
      name: "AgentOS VPS provisioning (Hetzner)",
      description: "Cloud-init hardened VPS with Node.js 22 and OpenClaw pre-installed.",
      endpoint: `${base}/compute/servers`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.deploy_vps.inputSchema,
      outputSchema: CAPABILITY_CLASSES.deploy_vps.outputSchema,
      costPerCallUsdc: 6.00,
      p50LatencyMs: 60000,
      p99LatencyMs: 180000,
      reputationScore: 0.92,
    },
    {
      id: "agentos.register_domain",
      source: "agentos",
      capability: "register_domain",
      name: "AgentOS domain registration (Namecheap + Cloudflare)",
      description: "Register a domain with dynamic pricing and Cloudflare DNS.",
      endpoint: `${base}/domain/register`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.register_domain.inputSchema,
      outputSchema: CAPABILITY_CLASSES.register_domain.outputSchema,
      costPerCallUsdc: 9.99,
      p50LatencyMs: 20000,
      p99LatencyMs: 90000,
      reputationScore: 0.9,
    },
    {
      id: "agentos.dns_manage",
      source: "agentos",
      capability: "dns_manage",
      name: "AgentOS DNS management (Cloudflare)",
      endpoint: `${base}/domain/dns`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.dns_manage.inputSchema,
      outputSchema: CAPABILITY_CLASSES.dns_manage.outputSchema,
      costPerCallUsdc: 0.00,
      p50LatencyMs: 1500,
      p99LatencyMs: 5000,
      reputationScore: 0.9,
    },
    {
      id: "agentos.x_account",
      source: "agentos",
      capability: "social_account_provision",
      name: "AgentOS X account provisioning",
      description: "Transfer a warmed X account from the pool to the agent's wallet.",
      endpoint: `${base}/social/accounts`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.social_account_provision.inputSchema,
      outputSchema: CAPABILITY_CLASSES.social_account_provision.outputSchema,
      costPerCallUsdc: 15.00,
      p50LatencyMs: 4000,
      p99LatencyMs: 20000,
      reputationScore: 0.8,
      metadata: { platform: "x" },
    },
    {
      id: "agentos.tiktok_account",
      source: "agentos",
      capability: "social_account_provision",
      name: "AgentOS TikTok account provisioning",
      description: "Transfer a warmed TikTok account from the pool to the agent's wallet.",
      endpoint: `${base}/social/accounts`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.social_account_provision.inputSchema,
      outputSchema: CAPABILITY_CLASSES.social_account_provision.outputSchema,
      costPerCallUsdc: 18.00,
      p50LatencyMs: 5000,
      p99LatencyMs: 30000,
      reputationScore: 0.75,
      metadata: { platform: "tiktok" },
    },
    {
      id: "agentos.x_post",
      source: "agentos",
      capability: "social_post",
      name: "AgentOS X post",
      endpoint: `${base}/social/post`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.social_post.inputSchema,
      outputSchema: CAPABILITY_CLASSES.social_post.outputSchema,
      costPerCallUsdc: 0.50,
      p50LatencyMs: 3000,
      p99LatencyMs: 15000,
      reputationScore: 0.8,
      metadata: { platform: "x" },
    },
    {
      id: "agentos.tiktok_post",
      source: "agentos",
      capability: "social_post",
      name: "AgentOS TikTok post",
      endpoint: `${base}/social/post`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.social_post.inputSchema,
      outputSchema: CAPABILITY_CLASSES.social_post.outputSchema,
      costPerCallUsdc: 0.50,
      p50LatencyMs: 4000,
      p99LatencyMs: 25000,
      reputationScore: 0.75,
      metadata: { platform: "tiktok" },
    },
    {
      id: "agentos.code_exec",
      source: "agentos",
      capability: "code_exec",
      name: "AgentOS code execution on owned VPS",
      endpoint: `${base}/compute/exec`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.code_exec.inputSchema,
      outputSchema: CAPABILITY_CLASSES.code_exec.outputSchema,
      costPerCallUsdc: 0.05,
      p50LatencyMs: 2000,
      p99LatencyMs: 30000,
      reputationScore: 0.85,
    },
    {
      id: "agentos.file_store",
      source: "agentos",
      capability: "file_store",
      name: "AgentOS file storage",
      endpoint: `${base}/storage/files`,
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.file_store.inputSchema,
      outputSchema: CAPABILITY_CLASSES.file_store.outputSchema,
      costPerCallUsdc: 0.02,
      p50LatencyMs: 800,
      p99LatencyMs: 3000,
      reputationScore: 0.85,
    },
  ];

  const tx = db.transaction(() => {
    for (const primitive of primitives) {
      registerProvider(primitive);
    }
  });
  tx();
}
