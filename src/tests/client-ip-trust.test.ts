/**
 * Regression: the real client IP (used for rate-limiting / brute-force
 * lockout / attribution) must only trust CF-Connecting-IP when the request
 * arrived via the local cloudflared tunnel (loopback peer). A forged
 * CF-Connecting-IP from a non-loopback peer must be ignored.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../middleware/client-ip";

function mkReq(cf: string | undefined, peer: string, ip?: string): any {
  return {
    headers: cf === undefined ? {} : { "cf-connecting-ip": cf },
    socket: { remoteAddress: peer },
    ip: ip ?? peer,
  };
}

describe("clientIp CF-Connecting-IP trust", () => {
  it("trusts CF-Connecting-IP when the peer is loopback (real tunnel)", () => {
    assert.equal(clientIp(mkReq("9.9.9.9", "127.0.0.1")), "9.9.9.9");
    assert.equal(clientIp(mkReq("9.9.9.9", "::ffff:127.0.0.1")), "9.9.9.9");
  });

  it("IGNORES a forged CF-Connecting-IP from a non-loopback peer", () => {
    // An off-tunnel attacker rotating CF-Connecting-IP must not escape their
    // real socket IP — otherwise every request lands in a fresh limiter bucket.
    assert.equal(clientIp(mkReq("9.9.9.9", "203.0.113.7")), "203.0.113.7");
    assert.equal(clientIp(mkReq("1.1.1.1", "198.51.100.2", "198.51.100.2")), "198.51.100.2");
  });

  it("falls back to the socket address when no CF header is present", () => {
    assert.equal(clientIp(mkReq(undefined, "203.0.113.9")), "203.0.113.9");
  });
});
