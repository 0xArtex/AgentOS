/**
 * Regression: the community featured-skills curation list must not be writable
 * or deletable by anonymous callers (it points agents at ClawHub slugs they
 * then install — a supply-chain vector). Both POST and DELETE now require auth.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import computeRouter from "../routes/compute";

function request(port: number, method: string, path: string, body?: any, headers: Record<string, string> = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...headers } },
      (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode || 0 })); },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("featured-skills curation requires auth", () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    delete process.env.PALMYR_SELF_HOSTED; // never bypass auth here
    const app = express();
    app.use(express.json());
    app.use("/compute", computeRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => { port = (server.address() as any).port; resolve(); });
    });
  });

  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("rejects an anonymous POST /compute/skills/featured (402)", async () => {
    const { status } = await request(port, "POST", "/compute/skills/featured", { slug: "evil-skill" });
    assert.equal(status, 402);
  });

  it("rejects an anonymous DELETE /compute/skills/featured/:slug (402)", async () => {
    const { status } = await request(port, "DELETE", "/compute/skills/featured/anything");
    assert.equal(status, 402);
  });
});
