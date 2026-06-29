/**
 * Regression tests for the security-middleware cluster:
 *
 *  1. sanitizeInputs (security.ts) must strip null bytes but NEVER trim — it runs
 *     globally, so trimming silently corrupted whitespace-significant payloads
 *     (opaque secrets with a trailing newline, post bodies with intentional edge
 *     whitespace). It must also not overflow the stack on deeply-nested input.
 *  2. bruteForceProtection (security.ts) must count auth failures regardless of
 *     how the response was sent (res.send/res.end, not only res.json), and must
 *     not count successful responses.
 *  3. requestTimeout (timeout.ts) must 408 + abort its signal when the handler
 *     overruns, and must leave the signal un-aborted for a handler that finishes
 *     in time.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { sanitizeInputs, bruteForceProtection } from "../middleware/security";
import { requestTimeout } from "../middleware/timeout";

function mockRes(): any {
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.headersSent = false;
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: any) => {
    res.headersSent = true;
    res._json = b;
    res.emit("finish");
    return res;
  };
  res.setHeader = () => res;
  return res;
}

describe("sanitizeInputs", () => {
  it("strips null bytes but preserves leading/trailing whitespace", () => {
    const req: any = {
      body: { secret: "  sk-live-trailing-newline\n", note: "a\0b" },
      query: { q: "  padded  " },
    };
    sanitizeInputs(req, mockRes(), () => {});
    // Whitespace-significant values are left exactly as submitted.
    assert.equal(req.body.secret, "  sk-live-trailing-newline\n");
    assert.equal(req.query.q, "  padded  ");
    // Null bytes are still removed.
    assert.equal(req.body.note, "ab");
  });

  it("strips null bytes inside arrays and object keys", () => {
    const req: any = { body: { ["k\0ey"]: ["x\0y", "z"] } };
    sanitizeInputs(req, mockRes(), () => {});
    assert.deepEqual(req.body, { key: ["xy", "z"] });
  });

  it("does not overflow the stack on deeply-nested input", () => {
    let root: any = {};
    let cur = root;
    for (let i = 0; i < 50_000; i++) {
      cur.next = {};
      cur = cur.next;
    }
    cur.leaf = "ok";
    const req: any = { body: root };
    assert.doesNotThrow(() => sanitizeInputs(req, mockRes(), () => {}));
  });
});

describe("bruteForceProtection", () => {
  function failOnce(ip: string, status = 401): void {
    const req: any = { headers: {}, socket: { remoteAddress: ip }, ip };
    const res = mockRes();
    bruteForceProtection(req, res, () => {});
    res.statusCode = status;
    res.emit("finish"); // simulate a res.send/res.end completion — NOT res.json
  }

  it("blocks an IP after 10 failures counted via res.send-style completion", () => {
    const ip = "203.0.113.55";
    for (let i = 0; i < 10; i++) failOnce(ip);

    const req: any = { headers: {}, socket: { remoteAddress: ip }, ip };
    const res = mockRes();
    let nexted = false;
    bruteForceProtection(req, res, () => {
      nexted = true;
    });
    assert.equal(res.statusCode, 429);
    assert.equal(nexted, false);
  });

  it("does not block before the threshold and ignores non-4xx responses", () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 9; i++) failOnce(ip, 200); // successes must not count

    const req: any = { headers: {}, socket: { remoteAddress: ip }, ip };
    const res = mockRes();
    let nexted = false;
    bruteForceProtection(req, res, () => {
      nexted = true;
    });
    assert.equal(nexted, true);
    assert.notEqual(res.statusCode, 429);
  });
});

describe("requestTimeout", () => {
  it("408s and aborts the signal when the handler overruns", async () => {
    const req: any = {};
    const res = mockRes();
    const mw = requestTimeout(30);
    await new Promise<void>((resolve) => {
      mw(req, res, () => {
        /* slow handler: never responds */
      });
      setTimeout(() => {
        assert.equal(res.statusCode, 408);
        assert.equal(res._json.error, "Request Timeout");
        assert.equal(req.timedOut, true);
        assert.equal(req.timeoutSignal.aborted, true);
        resolve();
      }, 90);
    });
  });

  it("leaves the signal un-aborted when the handler finishes in time", async () => {
    const req: any = {};
    const res = mockRes();
    const mw = requestTimeout(80);
    await new Promise<void>((resolve) => {
      mw(req, res, () => {
        res.status(200).json({ ok: true });
      });
      setTimeout(() => {
        assert.equal(res.statusCode, 200);
        assert.equal(req.timedOut, undefined);
        assert.equal(req.timeoutSignal.aborted, false);
        resolve();
      }, 130);
    });
  });
});
