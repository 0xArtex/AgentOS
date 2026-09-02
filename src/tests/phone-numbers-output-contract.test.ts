/**
 * GET /phone/numbers always returns `{ numbers }` on HTTP 200, but discovery
 * used to advertise an unconstrained object. Pin the OpenAPI 200 schema and
 * the live 402 Bazaar projection to require that handler-owned field only.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "http";
import net from "net";
import { initDatabase } from "../db";
import {
  send402Response,
  phoneNumbersListSuccessSchema,
} from "../middleware/x402";
import { mountDiscoveryRoutes } from "../routes/well-known";
import phoneRoutes from "../routes/phone";
import emailRoutes from "../routes/email";

function capture402(method: string, path: string, minUsdc: number, metadata: { description: string; category: string; tags: string[] }) {
  let body: any;
  const res: any = {
    setHeader: () => {},
    status: () => res,
    json: (b: any) => {
      body = b;
      return res;
    },
  };
  const req: any = {
    get: () => "palmyr.ai",
    method,
    originalUrl: path,
    path,
    route: { path: path.replace(/^\/phone/, "") || "/" },
  };
  send402Response(res, req, minUsdc, "Payment required. Use x402 protocol.", metadata);
  return body;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") return reject(new Error("bind failed"));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function getJson(port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path }, r => {
      let buf = "";
      r.setEncoding("utf8");
      r.on("data", c => (buf += c));
      r.on("end", () => {
        let body: any = buf;
        try {
          body = JSON.parse(buf);
        } catch {
          /* non-JSON */
        }
        resolve({ status: r.statusCode ?? 0, body });
      });
    }).on("error", reject);
  });
}

describe("GET /phone/numbers output contract", () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    initDatabase();
    const app = express();
    app.use("/phone", phoneRoutes);
    app.use("/email", emailRoutes);
    mountDiscoveryRoutes(app);
    port = await findFreePort();
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
  });

  after(async () => {
    if (!server) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("OpenAPI GET /phone/numbers 200 requires numbers; GET /email/inboxes stays unconstrained", async () => {
    const res = await getJson(port, "/openapi.json");
    assert.equal(res.status, 200);
    const phone = res.body.paths?.["/phone/numbers"]?.get;
    assert.ok(phone, "GET /phone/numbers is advertised");
    const phone200 = phone.responses?.["200"]?.content?.["application/json"]?.schema;
    assert.deepEqual(phone200?.required, ["numbers"]);
    assert.equal(phone200?.properties?.numbers?.type, "array");
    assert.deepEqual(phone.extensions?.bazaar?.schema?.properties?.output?.required, ["numbers"]);
    assert.deepEqual(phone.extensions?.bazaar?.info?.output?.example, { numbers: [] });

    const email = res.body.paths?.["/email/inboxes"]?.get;
    assert.ok(email, "GET /email/inboxes is advertised");
    const email200 = email.responses?.["200"]?.content?.["application/json"]?.schema;
    assert.equal(email200?.required, undefined);
    assert.equal(email.extensions?.bazaar?.schema?.properties?.output?.required, undefined);
    assert.deepEqual(email.extensions?.bazaar?.info?.output?.example, {});
  });

  it("unpaid GET /phone/numbers stays HTTP 402 at 0.01 USDC and projects numbers", async () => {
    const res = await getJson(port, "/phone/numbers");
    assert.equal(res.status, 402);
    const accepts = res.body.accepts || [];
    assert.ok(accepts.length >= 1, "402 carries accepts");
    for (const a of accepts) {
      assert.equal(a.amount, "10000", "price stays 10000 atomic USDC");
    }
    const bazaar = res.body.extensions?.bazaar;
    assert.deepEqual(bazaar?.info?.output?.example, { numbers: [] });
    assert.deepEqual(
      bazaar?.schema?.properties?.output?.properties?.example?.required,
      ["numbers"],
    );
  });

  it("send402Response projects numbers only on GET /phone/numbers", () => {
    const phone = capture402("GET", "/phone/numbers", 0.01, {
      description: "List all phone numbers owned by or shared with the calling wallet.",
      category: "communications",
      tags: ["phone", "list"],
    });
    assert.deepEqual(phone.extensions.bazaar.info.output.example, { numbers: [] });
    assert.deepEqual(
      phone.extensions.bazaar.schema.properties.output.properties.example.required,
      phoneNumbersListSuccessSchema.required,
    );

    const search = capture402("GET", "/phone/numbers/search", 0.01, {
      description: "Search available numbers",
      category: "communications",
      tags: ["phone"],
    });
    assert.deepEqual(search.extensions.bazaar.info.output.example, {});
    assert.equal(
      search.extensions.bazaar.schema.properties.output.properties.example.required,
      undefined,
    );

    const chat = capture402("POST", "/chat", 0.001, {
      description: "i402 planner",
      category: "general",
      tags: ["chat"],
    });
    assert.deepEqual(chat.extensions.bazaar.info.output.example, {});
    assert.equal(
      chat.extensions.bazaar.schema.properties.output.properties.example.required,
      undefined,
    );
  });
});
