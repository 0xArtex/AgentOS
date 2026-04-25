import Anthropic from "@anthropic-ai/sdk";
import type { LLMResponse, LLMUsage } from "./i402-types";

// -------------------- Model catalog + pricing --------------------

// Pricing per million tokens (USDC). Kept in sync with Anthropic's published rates.
// Cache-creation is ~1.25x base input. Cache reads are ~0.1x base input.
interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheWritePerM: number;
  cacheReadPerM: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7": { inputPerM: 15.0, outputPerM: 75.0, cacheWritePerM: 18.75, cacheReadPerM: 1.5 },
  "claude-opus-4-7[1m]": { inputPerM: 30.0, outputPerM: 150.0, cacheWritePerM: 37.5, cacheReadPerM: 3.0 },
  "claude-sonnet-4-6": { inputPerM: 3.0, outputPerM: 15.0, cacheWritePerM: 3.75, cacheReadPerM: 0.3 },
  "claude-haiku-4-5-20251001": { inputPerM: 1.0, outputPerM: 5.0, cacheWritePerM: 1.25, cacheReadPerM: 0.1 },
};

// Fallback for unknown models — uses Haiku pricing so at worst we under-bill the agent.
const DEFAULT_PRICING: ModelPricing = MODEL_PRICING["claude-haiku-4-5-20251001"];

function pricingFor(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}

// -------------------- Lazy client init --------------------

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set — i402 orchestrator cannot generate plans");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

/** Reset the cached client. Used by tests that override env. */
export function resetAnthropicClient(): void {
  _client = null;
}

// -------------------- Environment defaults --------------------

export const DEFAULT_ROUTER_MODEL = () => process.env.I402_MODEL_ROUTER ?? "claude-haiku-4-5-20251001";
export const DEFAULT_PLANNER_MODEL = () => process.env.I402_MODEL_PLANNER ?? "claude-opus-4-7";
export const MAX_OUTPUT_TOKENS = () => parseInt(process.env.I402_MAX_OUTPUT_TOKENS ?? "4096", 10);
export const PROMPT_CACHE_ENABLED = () => (process.env.I402_PROMPT_CACHE_ENABLED ?? "true") === "true";

// -------------------- Cost + usage computation --------------------

export function computeCost(model: string, usage: Anthropic.Messages.Usage): LLMUsage {
  const p = pricingFor(model);
  const tokensIn = usage.input_tokens ?? 0;
  const tokensOut = usage.output_tokens ?? 0;
  const cacheRead = (usage as any).cache_read_input_tokens ?? 0;
  const cacheCreation = (usage as any).cache_creation_input_tokens ?? 0;

  const cost =
    (tokensIn * p.inputPerM) / 1_000_000 +
    (tokensOut * p.outputPerM) / 1_000_000 +
    (cacheCreation * p.cacheWritePerM) / 1_000_000 +
    (cacheRead * p.cacheReadPerM) / 1_000_000;

  return {
    tokensIn,
    tokensOut,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    costUsdc: cost,
  };
}

// -------------------- Cache-controlled system blocks --------------------

/**
 * Build a cache-controlled system array. Blocks marked stable (catalog, capabilities,
 * base instructions) get cache_control. Per-request dynamic content is plain text.
 *
 * Anthropic allows up to 4 cache breakpoints; put them on the longest-lived blocks.
 */
export interface SystemBlock {
  text: string;
  /** If true, mark this block with cache_control ephemeral — enables prompt caching. */
  cache?: boolean;
}

export function buildSystemBlocks(
  blocks: SystemBlock[]
): Array<Anthropic.Messages.TextBlockParam> {
  const caching = PROMPT_CACHE_ENABLED();
  return blocks.map(b => {
    const block: Anthropic.Messages.TextBlockParam = { type: "text", text: b.text };
    if (caching && b.cache) {
      (block as any).cache_control = { type: "ephemeral" };
    }
    return block;
  });
}

// -------------------- Text completion --------------------

export interface TextCompletionInput {
  model: string;
  system: SystemBlock[];
  messages: Array<Anthropic.Messages.MessageParam>;
  maxTokens?: number;
  temperature?: number;
}

export async function completeText(input: TextCompletionInput): Promise<LLMResponse<string>> {
  const response = await withRetry(async () => {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: input.model,
      max_tokens: input.maxTokens ?? MAX_OUTPUT_TOKENS(),
      system: buildSystemBlocks(input.system),
      messages: input.messages,
    };
    if (input.temperature !== undefined) params.temperature = input.temperature;
    return anthropic().messages.create(params);
  });

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map(b => b.text)
    .join("\n");

  return {
    model: response.model,
    content: text,
    usage: computeCost(response.model, response.usage),
    stopReason: response.stop_reason ?? undefined,
  };
}

// -------------------- Structured output via tool use --------------------

/**
 * Force a structured JSON output by defining a single tool and requiring the
 * model to call it. The parsed tool input is returned as the content.
 */
export interface StructuredCompletionInput<T> {
  model: string;
  system: SystemBlock[];
  messages: Array<Anthropic.Messages.MessageParam>;
  tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  maxTokens?: number;
  temperature?: number;
  /** Runtime validator. Throws if the LLM output doesn't match expected shape. */
  parse?: (raw: unknown) => T;
}

export async function completeStructured<T = unknown>(
  input: StructuredCompletionInput<T>
): Promise<LLMResponse<T>> {
  const response = await withRetry(async () => {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: input.model,
      max_tokens: input.maxTokens ?? MAX_OUTPUT_TOKENS(),
      system: buildSystemBlocks(input.system),
      tools: [
        {
          name: input.tool.name,
          description: input.tool.description,
          input_schema: input.tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: input.tool.name },
      messages: input.messages,
    };
    if (input.temperature !== undefined) params.temperature = input.temperature;
    return anthropic().messages.create(params);
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error(`Model ${response.model} did not produce a tool_use block for ${input.tool.name}`);
  }

  const raw = toolUse.input as unknown;
  const parsed = input.parse ? input.parse(raw) : (raw as T);

  return {
    model: response.model,
    content: parsed,
    usage: computeCost(response.model, response.usage),
    stopReason: response.stop_reason ?? undefined,
  };
}

// -------------------- Swappable adapter (for tests) --------------------

/**
 * Re-assignable adapter so tests can stub LLM calls without touching the network.
 * Production code uses `llm.completeStructured(...)` / `llm.completeText(...)`.
 * Tests assign `llm.completeStructured = async () => ({ ... })`.
 */
export const llm = {
  completeText,
  completeStructured,
};

// -------------------- Retry / backoff --------------------

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
      if (!retryable || attempt === maxAttempts) break;
      const backoffMs = Math.min(500 * 2 ** (attempt - 1), 4000);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}
