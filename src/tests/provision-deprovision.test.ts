/**
 * Regression tests for DELETE /provision/:service (#79).
 *
 * The handler used to return {success:true, message:"<svc> deprovisioned"} for
 * any authenticated dashboard user WITHOUT actually tearing the resource down
 * and WITHOUT checking the caller owns it. That is a lie (the resource stays
 * live + billable) and, once teardown is wired as-is, a cross-tenant delete.
 * Until real, ownership-checked deprovisioning lands it must fail closed (501)
 * and leave the resource untouched — and unauthenticated callers stay 401.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";

import { db } from "../db";
import provisionRouter from "../routes/provision";

function request(
  port: number,
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    // Send a fixed Content-Length (not chunked): a DELETE whose body is still
    // mid-transfer when the server commits its response can otherwise have the
    // socket reset (ECONNRESET) on Windows. Delivering the whole body up front
    // avoids that race.
    const baseHeaders: Record<string, string> = { "content-type": "application/json", ...headers };
    if (data !== undefined) baseHeaders["content-length"] = String(Buffer.byteLength(data));
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: baseHeaders },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(buf); } catch {}
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("provision DELETE — honest 501, no false success", () => {
  let server: http.Server;
  let port: number;
  const s = Date.now().toString(36);
  const userId = `prov-user-${s}`;
  const token = "prov_sess_" + crypto.randomBytes(8).toString("hex");
  const auth = { authorization: "Bearer " + token };

  before(async () => {
    db.prepare("INSERT INTO dashboard_users (id, display_name) VALUES (?, ?)").run(userId, userId);
    db.prepare(
      "INSERT INTO dashboard_sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, datetime('now', '+1 day'))"
    ).run(`sess-${s}`, userId, token);
    const app = express();
    app.use(express.json());
    app.use("/provision", provisionRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => { port = (server.address() as any).port; resolve(); });
    });
  });

  after(async () => {
    db.prepare("DELETE FROM dashboard_sessions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM dashboard_users WHERE id = ?").run(userId);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("rejects an unauthenticated request with 401 (no false success)", async () => {
    const { status } = await request(port, "DELETE", "/provision/email", { nodeId: "nodeEmail" });
    assert.equal(status, 401);
  });

  it("returns 501 (not a false success) for a valid service, leaving it untouched", async () => {
    const { status, json } = await request(port, "DELETE", "/provision/vps", { nodeId: "nodeVps" }, auth);
    assert.equal(status, 501, JSON.stringify(json));
    assert.equal(json.deprovisioned, false);
    assert.notEqual(json.success, true, "must never claim success while the resource is still live");
  });

  it("still validates the service name (400 for an unknown service)", async () => {
    const { status } = await request(port, "DELETE", "/provision/bogus", { nodeId: "x" }, auth);
    assert.equal(status, 400);
  });
});
