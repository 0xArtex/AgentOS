/**
 * Unit tests for buildToolResult — the settled-vs-challenge discrimination in the
 * MCP x402 proxy. The load-bearing case is a 402 that carries a settlement
 * receipt: it MUST be treated as a settled data response, never re-issued as a
 * payment challenge (doing so double-charges the agent on i402 `/chat`, which
 * returns HTTP 402 as its "here is the plan" channel after the fee settles).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolResult } from "../services/mcp-tools";

const RECEIPT = { success: true, transaction: "0xabc123", network: "eip155:8453", payer: "0x8Bf0" };
function withReceipt(): Record<string, string> {
  return { "payment-response": Buffer.from(JSON.stringify(RECEIPT)).toString("base64") };
}
const NO_HEADERS: Record<string, string> = {};

test("402 WITH receipt → settled data pass-through, NOT a payment challenge (double-charge guard)", () => {
  const planBody = { plan_id: "p1", steps: [{ capability: "phone" }], totals: { total_cost_usdc: 3 } };
  const r = buildToolResult(402, JSON.stringify(planBody), planBody, withReceipt(), "i402_plan");
  // must NOT be a challenge
  assert.equal(r.isError, undefined, "settled 402 is not an error");
  assert.equal((r as any).structuredContent, undefined, "no payment-challenge structuredContent");
  assert.equal(r._meta?.["x402/error"], undefined, "no x402/error challenge mirror");
  // must pass the plan body through and attach the receipt
  assert.equal(r.content[0].text, JSON.stringify(planBody), "plan body passed through verbatim");
  assert.deepEqual(r._meta?.["x402/payment-response"], RECEIPT, "settlement receipt attached");
});

test("402 WITHOUT receipt → genuine payment challenge (spec shape)", () => {
  const body = { x402Version: 2, resource: { url: "https://palmyr.ai/phone/numbers" }, accepts: [{ network: "eip155:8453", amount: "3000000" }] };
  const r = buildToolResult(402, JSON.stringify(body), body, NO_HEADERS, "phone_buy_number");
  assert.equal(r.isError, true);
  const sc: any = (r as any).structuredContent;
  assert.equal(sc.x402Version, 2);
  assert.ok(Array.isArray(sc.accepts) && sc.accepts.length === 1, "carries accepts");
  assert.equal(r.content[0].text, JSON.stringify(sc), "content text byte-equals structuredContent");
  assert.deepEqual(r._meta?.["x402/error"], sc, "x402/error mirror present");
  assert.equal(r._meta?.["x402/payment-response"], undefined, "no settlement receipt on a challenge");
});

test("2xx WITH receipt → success + receipt", () => {
  const body = { id: "num_1", phoneNumber: "+1555" };
  const r = buildToolResult(200, JSON.stringify(body), body, withReceipt(), "phone_buy_number");
  assert.equal(r.isError, undefined);
  assert.equal((r as any).structuredContent, undefined);
  assert.equal(r.content[0].text, JSON.stringify(body));
  assert.deepEqual(r._meta?.["x402/payment-response"], RECEIPT);
});

test("2xx WITHOUT receipt → plain success (free/unpaid tool)", () => {
  const body = { prices: [] };
  const r = buildToolResult(200, JSON.stringify(body), body, NO_HEADERS, "palmyr_pricing");
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text, JSON.stringify(body));
  assert.equal(r._meta, undefined, "no _meta when nothing to attach");
});

test("4xx WITH receipt → settled-then-failed (refunded) surfaces as error, keeps receipt", () => {
  const body = { error: "provisioning failed", refunded: true };
  const r = buildToolResult(400, JSON.stringify(body), body, withReceipt(), "phone_buy_number");
  assert.equal(r.isError, true, "handler failure after settlement is an error");
  assert.equal((r as any).structuredContent, undefined, "not a payment challenge");
  assert.deepEqual(r._meta?.["x402/payment-response"], RECEIPT, "settlement receipt still surfaced");
});

test("5xx WITHOUT receipt → plain error", () => {
  const body = { error: "upstream" };
  const r = buildToolResult(500, JSON.stringify(body), body, NO_HEADERS, "email_send");
  assert.equal(r.isError, true);
  assert.equal((r as any).structuredContent, undefined);
  assert.equal(r._meta, undefined);
});
