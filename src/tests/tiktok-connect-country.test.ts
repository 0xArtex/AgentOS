/**
 * Matching the login exit to whoever is scanning.
 *
 * TikTok weighs the distance between the scanning phone and the browser being
 * authorised, because that gap is the signature of a QR phishing attack. A
 * login started on a `us` exit and scanned from the UAE was refused outright
 * with "Couldn't login. Try another login method."; the same login on an `ae`
 * exit succeeded immediately.
 *
 * So the browser is not launched until a human opens the hand-off link, at
 * which point their country is read off the request. These cover the rules that
 * decide WHICH country wins, and that the write capability never escapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientCountry } from "../middleware/client-ip";

function reqFrom(headers: Record<string, string>, peer = "127.0.0.1"): any {
  return { headers, socket: { remoteAddress: peer }, ip: peer };
}

test("reads the viewer's country from Cloudflare when the request came through the tunnel", () => {
  assert.equal(clientCountry(reqFrom({ "cf-ipcountry": "AE" })), "ae");
  assert.equal(clientCountry(reqFrom({ "cf-ipcountry": "gb" })), "gb");
});

test("ignores the header when the request did NOT arrive through the tunnel", () => {
  // Off-tunnel the header is attacker-controlled. Believing it would let a
  // caller steer which residential country an account logs in from.
  assert.equal(clientCountry(reqFrom({ "cf-ipcountry": "AE" }, "203.0.113.9")), null);
});

test("treats Cloudflare's placeholders as no answer", () => {
  // XX is "unknown" and T1 is Tor — neither is a country to launch a browser in.
  assert.equal(clientCountry(reqFrom({ "cf-ipcountry": "XX" })), null);
  assert.equal(clientCountry(reqFrom({ "cf-ipcountry": "T1" })), null);
  assert.equal(clientCountry(reqFrom({ "cf-ipcountry": "" })), null);
  assert.equal(clientCountry(reqFrom({})), null);
  assert.equal(clientCountry(reqFrom({ "cf-ipcountry": "NOTACOUNTRY" })), null);
});

test("a started connect waits for a viewer instead of launching a browser", async () => {
  const svc = await import("../services/tiktok-server-connect");
  const started = svc.startServerConnect({ accountId: "connect-country-test", baseUrl: "https://example.test" });

  const run = svc.getServerConnect(started.token)!;
  assert.equal(run.state, "awaiting_viewer", "no browser may start before anyone opens the link");
  assert.ok(started.connect_url.endsWith(`/connect/${started.token}`));
  // Holding a login browser open for a link nobody opened would burn one of
  // only two long-idling slots.
  assert.equal(run.launched, undefined);
});

test("an explicit country from the caller beats the viewer's", async () => {
  const svc = await import("../services/tiktok-server-connect");
  // An agent onboarding an account that belongs to a particular market may
  // deliberately want that market's exit even when the phone is elsewhere.
  const started = svc.startServerConnect({ accountId: "connect-country-pinned", country: "de", baseUrl: "https://example.test" });
  const run = svc.getServerConnect(started.token)!;
  assert.equal(run.country, "de");
});

test("noteConnectViewer is inert for a token with no run behind it", async () => {
  const svc = await import("../services/tiktok-server-connect");
  // The same /connect page also serves the locally-driven QR relay, where no
  // server-side run exists. It must not throw or start anything.
  assert.doesNotThrow(() => svc.noteConnectViewer("no-such-token", "ae"));
});
