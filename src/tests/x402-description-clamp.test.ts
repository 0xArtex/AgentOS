/**
 * Regression guard for the /phone/temp CDP-verify failure: an over-long x402
 * resource.description (967 chars — the base text + the full recycling caveat)
 * exceeded CDP's facilitator schema cap (maxLength 500). v2 clients echo the
 * challenge's `resource` back into their X-PAYMENT payload, so CDP schema-
 * rejected the payload ("must match ... x402V1PaymentPayload requires 'scheme'")
 * and every Base/CDP lease payment 400'd. The shared builder now clamps to 500
 * so no route can regress into this again.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { send402Response } from "../middleware/x402";

function capture() {
  let body: any;
  const res: any = {
    setHeader: () => {},
    status: () => res,
    json: (b: any) => { body = b; return res; },
  };
  const req: any = { get: () => "palmyr.ai", method: "POST", originalUrl: "/phone/temp" };
  return { res, req, get: () => body };
}

describe("x402 resource.description is clamped to CDP's 500-char cap", () => {
  it("clamps a 967-char description to exactly 500 (the exact length that broke prod)", () => {
    const { res, req, get } = capture();
    send402Response(res, req, 0.2, "test", { description: "x".repeat(967), category: "communications", tags: [] });
    const body = get();
    assert.ok(body?.resource?.description, "resource.description present");
    assert.equal(body.resource.description.length, 500, "967-char description must clamp to 500");
    // The client echoes resource.description into its payload; ≤500 keeps CDP happy.
    assert.ok(body.resource.description.length <= 500);
  });

  it("leaves a compliant (<500) description untouched", () => {
    const { res, req, get } = capture();
    const desc = "Lease a cheap, receive-only US temp number for one SMS code.";
    send402Response(res, req, 0.2, "test", { description: desc, category: "communications", tags: [] });
    assert.equal(get().resource.description, desc);
  });
});
