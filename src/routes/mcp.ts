/**
 * Hosted MCP server at POST /mcp.
 *
 * Stateless Streamable HTTP transport: a fresh McpServer + transport is created
 * per POST request (`sessionIdGenerator: undefined`), with `enableJsonResponse`
 * so replies are plain JSON rather than an SSE stream (sidesteps compression /
 * Cloudflare-tunnel streaming issues). GET/DELETE return a JSON-RPC 405 per the
 * stateless pattern. Curated Palmyr capabilities are exposed as tools that
 * agents pay for per-action via x402 (see services/mcp-tools.ts).
 *
 * Also exports `mcpRegistryAuthRouter`, which serves
 * GET /.well-known/mcp-registry-auth for MCP Registry domain verification of the
 * `ai.palmyr/*` namespace.
 */
import { Router, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerPalmyrTools } from "../services/mcp-tools";

const router = Router();

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "ai.palmyr/palmyr", title: "Palmyr", version: "1.0.0" },
    {
      instructions:
        "Palmyr exposes real-world capabilities (email, phone, X/TikTok, domains, VPS, and the i402 intent resolver) that agents pay for per-action via x402 (USDC on Solana or Base). No account or API key. Call a paid tool once with no `payment` to receive x402 instructions, then sign and call again with `payment`.",
    },
  );
  registerPalmyrTools(server);
  return server;
}

// POST /mcp — one JSON-RPC exchange per request (stateless).
router.post("/", async (req: Request, res: Response) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("[mcp] request error:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode: GET (SSE stream) and DELETE (session teardown) are not
// supported. Return a JSON-RPC "Method not allowed" per the SDK stateless pattern.
function methodNotAllowed(_req: Request, res: Response): void {
  res
    .status(405)
    .set("Allow", "POST")
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
}
router.get("/", methodNotAllowed);
router.delete("/", methodNotAllowed);

export default router;

/**
 * MCP Registry domain-verification well-known.
 *
 * The registry verifies control of the `ai.palmyr` namespace by fetching this
 * file and matching the served Ed25519 public key against the signature made
 * with the corresponding private key (`mcp-publisher login http`). Only served
 * when MCP_REGISTRY_PUBKEY is set; 404 otherwise.
 */
export const mcpRegistryAuthRouter = Router();
mcpRegistryAuthRouter.get("/.well-known/mcp-registry-auth", (_req: Request, res: Response) => {
  const pubkey = process.env.MCP_REGISTRY_PUBKEY;
  if (!pubkey) {
    res.status(404).json({ error: "MCP registry auth not configured" });
    return;
  }
  res.type("text/plain").send(`v=MCPv1; k=ed25519; p=${pubkey}`);
});
