/**
 * Namecheap response-status detection.
 *
 * Money-critical. Namecheap reports failure as `<ApiResponse Status="ERROR">` —
 * an ATTRIBUTE on the envelope. The client used to look for a `<Status>ERROR</Status>`
 * ELEMENT, which Namecheap never emits, so every registrar error resolved as a
 * success carrying no parsed fields. The reconciliation oracle
 * (`isOwnedAtRegistrar`) treats "getInfo resolved" as "we own this domain", so
 * a failed registration was finalised as active, with no refund, for a domain
 * that was never registered.
 *
 * The XML below is the real shape returned by api.namecheap.com (captured from
 * a live getInfo probe for an unregistered .xyz and for one we own).
 */
import { test } from "node:test";
import assert from "node:assert";
import { assertNamecheapOk, namecheapRequest } from "../services/namecheap";

/** Run `fn` with fetch stubbed to return `xml`, and fake API creds present. */
async function withStubbedRegistrar(xml: string, fn: () => Promise<void>): Promise<void> {
  const savedFetch = globalThis.fetch;
  const savedUser = process.env.NAMECHEAP_API_USER;
  const savedKey = process.env.NAMECHEAP_API_KEY;
  process.env.NAMECHEAP_API_USER = "test-user";
  process.env.NAMECHEAP_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    new Response(xml, { status: 200, headers: { "content-type": "text/xml" } })) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = savedFetch;
    if (savedUser === undefined) delete process.env.NAMECHEAP_API_USER;
    else process.env.NAMECHEAP_API_USER = savedUser;
    if (savedKey === undefined) delete process.env.NAMECHEAP_API_KEY;
    else process.env.NAMECHEAP_API_KEY = savedKey;
  }
}

const ERROR_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response">
  <Errors><Error Number="2030166">Domain is invalid</Error></Errors>
  <Warnings />
  <RequestedCommand>namecheap.domains.getinfo</RequestedCommand>
  <Server>PHX01APIEXT05</Server>
</ApiResponse>`;

const OK_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <RequestedCommand>namecheap.domains.getinfo</RequestedCommand>
  <CommandResponse Type="namecheap.domains.getInfo">
    <DomainGetInfoResult Status="Ok" DomainName="subilot.xyz" />
  </CommandResponse>
</ApiResponse>`;

test("throws on a Status=ERROR envelope, surfacing number and message", () => {
  assert.throws(
    () => assertNamecheapOk("namecheap.domains.getInfo", ERROR_XML),
    (e: Error) => {
      assert.match(e.message, /Domain is invalid/);
      assert.match(e.message, /2030166/);
      assert.match(e.message, /namecheap\.domains\.getInfo/);
      return true;
    },
  );
});

test("accepts a Status=OK envelope, whose empty <Errors /> is not an error", () => {
  assert.doesNotThrow(() => assertNamecheapOk("namecheap.domains.getInfo", OK_XML));
});

test("fails closed on a response that is not a Namecheap envelope", () => {
  // An edge/CDN HTML error page must never read as success — that was the whole
  // failure mode: a non-success response resolving as an empty success object.
  assert.throws(
    () => assertNamecheapOk("namecheap.domains.check", "<html><body>502 Bad Gateway</body></html>"),
    /unrecognized response/,
  );
  assert.throws(() => assertNamecheapOk("namecheap.domains.check", ""), /unrecognized response/);
});

test("getInfo on a domain we do not own REJECTS — the ownership oracle depends on it", async () => {
  // `isOwnedAtRegistrar` reads "namecheapRequest resolved" as "the domain is in
  // our account". If this resolves, a failed registration finalises as active
  // and the payer is charged for a domain that does not exist.
  await withStubbedRegistrar(ERROR_XML, async () => {
    await assert.rejects(
      () => namecheapRequest("namecheap.domains.getInfo", { DomainName: "never-registered.xyz" }),
      /Domain is invalid/,
    );
  });
});

test("a failed getHosts REJECTS rather than resolving as an empty zone", async () => {
  await withStubbedRegistrar(ERROR_XML, async () => {
    await assert.rejects(
      () => namecheapRequest("namecheap.domains.dns.getHosts", { SLD: "example", TLD: "xyz" }),
      /Namecheap namecheap\.domains\.dns\.getHosts failed/,
    );
  });
});

test("a setHosts write reporting IsSuccess=false REJECTS", async () => {
  // Status="OK" with IsSuccess="false" means the call was accepted and the zone
  // was NOT updated — reporting success there is how a no-op write gets sold as
  // a completed one.
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <CommandResponse Type="namecheap.domains.dns.setHosts">
    <DomainDNSSetHostsResult Domain="example.xyz" IsSuccess="false" />
  </CommandResponse>
</ApiResponse>`;
  await withStubbedRegistrar(xml, async () => {
    await assert.rejects(
      () => namecheapRequest("namecheap.domains.dns.setHosts", { SLD: "example", TLD: "xyz" }),
      /IsSuccess=false/,
    );
  });
});

test("a successful setHosts resolves with isSuccess true", async () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <CommandResponse Type="namecheap.domains.dns.setHosts">
    <DomainDNSSetHostsResult Domain="example.xyz" IsSuccess="true" />
  </CommandResponse>
</ApiResponse>`;
  await withStubbedRegistrar(xml, async () => {
    const r = await namecheapRequest("namecheap.domains.dns.setHosts", { SLD: "example", TLD: "xyz" });
    assert.equal(r.isSuccess, true);
  });
});

test("still rejects the legacy <Status>ERROR</Status> element form", () => {
  assert.throws(
    () => assertNamecheapOk("namecheap.domains.create", "<Response><Status>ERROR</Status></Response>"),
    /failed/,
  );
});

test("an error envelope throws even when the error text is empty", () => {
  // Number-only: still a failure, and the number is what ops needs to look up.
  assert.throws(
    () =>
      assertNamecheapOk(
        "namecheap.domains.create",
        `<ApiResponse Status="ERROR"><Errors><Error Number="0"></Error></Errors></ApiResponse>`,
      ),
    /Namecheap error 0/,
  );
  // Nothing usable in <Errors> at all: fall back to the envelope status.
  assert.throws(
    () => assertNamecheapOk("namecheap.domains.create", `<ApiResponse Status="ERROR"><Errors /></ApiResponse>`),
    /response status ERROR/,
  );
});
