import type { StepHandler, StepExecutionContext } from "./i402-executor";

// -------------------- Auth schemes for external providers --------------------

export type ExternalAuthConfig =
  | { kind: "api_key"; header: string; valueEnv: string; scheme?: "Bearer" | "raw" }
  | { kind: "x402_proxy"; /* AgentOS treasury signs x402 on the agent's behalf */ }
  | { kind: "none" };

// -------------------- Transformer contract --------------------

export type InputTransformer = (input: Record<string, unknown>, ctx: StepExecutionContext) => Record<string, unknown>;
export type OutputTransformer = (raw: unknown, ctx: StepExecutionContext) => Record<string, unknown>;

export interface ExternalHandlerConfig {
  providerId: string;
  endpoint: string;
  method?: "GET" | "POST";
  auth: ExternalAuthConfig;
  /** Map i402 canonical capability input → provider-specific request body/query */
  transformInput?: InputTransformer;
  /** Map provider-specific response → i402 canonical capability output */
  transformOutput?: OutputTransformer;
  /** Max attempts including first (default 2). Backoff doubles each retry starting at 500ms. */
  maxAttempts?: number;
  /** Per-attempt timeout in ms (default 30000). */
  timeoutMs?: number;
}

// -------------------- Internal helpers --------------------

function resolveAuthHeaders(auth: ExternalAuthConfig): Record<string, string> {
  switch (auth.kind) {
    case "none":
      return {};
    case "api_key": {
      const raw = process.env[auth.valueEnv];
      if (!raw) {
        throw new Error(
          `External provider auth misconfigured: env var ${auth.valueEnv} is unset`
        );
      }
      const value = auth.scheme === "Bearer" ? `Bearer ${raw}` : raw;
      return { [auth.header]: value };
    }
    case "x402_proxy":
      // Reserved for Checkpoint 5+ — AgentOS treasury signs x402 on agent's behalf.
      // Implementation depends on treasury-wallet integration with @x402/svm /
      // @x402/evm, which is out of scope for this checkpoint. Clear error keeps
      // the seam honest.
      throw new Error("x402_proxy auth is not yet wired; register provider as 'external' with api_key or await AM integration");
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(handle);
  }
}

async function withBackoff<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      // Backoff on 429 / 5xx / network error. Other errors fail fast.
      const status = err?.__httpStatus;
      const retryable = !status || status === 429 || (status >= 500 && status < 600);
      if (!retryable) break;
      const backoff = Math.min(500 * 2 ** (attempt - 1), 4000);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// -------------------- Factory --------------------

/**
 * Build a StepHandler that calls an external HTTP API on behalf of the agent.
 *
 * Flow:
 *  1. Transform i402 canonical input to provider-specific shape
 *  2. Resolve auth headers (API key from env, x402 proxy, or none)
 *  3. Issue HTTP call with timeout + retry on retryable errors
 *  4. Transform provider response to i402 canonical output shape
 *  5. Return output to the executor, which debits the agent's escrow
 */
export function externalHttpHandler(config: ExternalHandlerConfig): StepHandler {
  const maxAttempts = config.maxAttempts ?? 2;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const method = config.method ?? "POST";

  return async (input, ctx) => {
    const transformedInput = config.transformInput ? config.transformInput(input, ctx) : input;
    const authHeaders = resolveAuthHeaders(config.auth);

    const doFetch = async (): Promise<unknown> => {
      let url = config.endpoint;
      let body: string | undefined;
      const headers: Record<string, string> = { ...authHeaders };

      if (method === "GET") {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(transformedInput)) {
          if (v === undefined || v === null) continue;
          qs.append(k, typeof v === "string" ? v : JSON.stringify(v));
        }
        if ([...qs.keys()].length > 0) {
          url = `${url}${url.includes("?") ? "&" : "?"}${qs.toString()}`;
        }
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(transformedInput);
      }

      const res = await fetchWithTimeout(url, { method, headers, body }, timeoutMs);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err: any = new Error(
          `External provider ${config.providerId} returned ${res.status}: ${text.slice(0, 200)}`
        );
        err.__httpStatus = res.status;
        throw err;
      }
      return res.json();
    };

    const raw = await withBackoff(doFetch, maxAttempts);
    const output = config.transformOutput ? config.transformOutput(raw, ctx) : (raw as Record<string, unknown>);
    return output;
  };
}
