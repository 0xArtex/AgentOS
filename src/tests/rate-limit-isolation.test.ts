import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { rateLimit } from "../middleware/rateLimit";

test("route-specific rate limits do not share counters with the global limiter", async () => {
  const app = express();
  app.use(rateLimit(200, 60_000));
  app.get("/ping", (_req, res) => res.sendStatus(204));
  app.post("/signup", rateLimit(5, 60 * 60_000), (_req, res) => res.sendStatus(204));
  const server: any = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const port = server.address().port;
  const headers = { "cf-connecting-ip": "198.51.100.61" };
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/ping`, { headers })).status, 204);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await fetch(`http://127.0.0.1:${port}/signup`, { method: "POST", headers });
      assert.equal(response.status, 204, `signup attempt ${attempt} should not inherit the global counter`);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/signup`, { method: "POST", headers })).status, 429);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
