/**
 * Regression: media fetched from a user-supplied URL must be byte-capped while
 * streaming, not buffered in full. A host that streams unbounded data with no
 * Content-Length (so fetchSsrfSafe's header check passes) must be aborted once
 * cumulative bytes exceed the cap, instead of OOMing the box via arrayBuffer().
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readBodyCapped } from "../services/social-operations";

function fakeResp(chunks: Buffer[]): any {
  let cancelled = false;
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) {
          if (cancelled) return;
          yield c;
        }
      },
      cancel() { cancelled = true; },
    },
  };
}

describe("readBodyCapped", () => {
  it("returns the full buffer when under the cap", async () => {
    const buf = await readBodyCapped(fakeResp([Buffer.alloc(100, 1), Buffer.alloc(50, 2)]), 1000);
    assert.equal(buf.length, 150);
  });

  it("aborts once cumulative bytes exceed the cap (no unbounded buffering)", async () => {
    // 10 chunks of 1 KB each, cap 4 KB → must throw after ~4 chunks, not buffer all 10.
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(1024, 7));
    await assert.rejects(() => readBodyCapped(fakeResp(chunks), 4096), /too large/i);
  });

  it("caps even when the body has no async-iterator (arrayBuffer fallback)", async () => {
    const big = { arrayBuffer: async () => new Uint8Array(5000).buffer } as any;
    await assert.rejects(() => readBodyCapped(big, 1000), /too large/i);
  });
});
