import { test } from "node:test";
import assert from "node:assert/strict";
import { putQr, getQrSession, renderQrPage, renderExpiredPage } from "../services/qr-handoff";

const VALID = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const VALID2 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

test("create session → waiting; update with the writer credential → ready with the QR", () => {
  const { token, writer, expiresInSec } = putQr({});
  assert.ok(token.length >= 16);
  assert.equal(expiresInSec, 900);
  assert.equal(getQrSession(token)!.state, "waiting");
  assert.equal(getQrSession(token)!.qr, null);
  putQr({ dataUrl: VALID, token: writer });
  assert.equal(getQrSession(token)!.state, "ready");
  assert.equal(getQrSession(token)!.qr, VALID);
});

test("update refreshes the QR on the same session; done → completed", () => {
  const { token, writer } = putQr({ dataUrl: VALID });
  assert.equal(getQrSession(token)!.qr, VALID);
  putQr({ dataUrl: VALID2, token: writer });
  assert.equal(getQrSession(token)!.qr, VALID2); // rotated QR is reflected
  putQr({ token: writer, done: true });
  assert.equal(getQrSession(token)!.state, "completed");
});

test("getQrSession returns null for an unknown token", () => {
  assert.equal(getQrSession("deadbeef".repeat(4)), null);
});

test("putQr rejects non-image / malformed data-URLs", () => {
  assert.throws(() => putQr({ dataUrl: "https://example.com/x.png" }));
  assert.throws(() => putQr({ dataUrl: "data:text/html;base64,PHNjcmlwdD4=" }));
  assert.throws(() => putQr({ dataUrl: "not a url" }));
});

test("putQr rejects oversized payloads", () => {
  assert.throws(() => putQr({ dataUrl: "data:image/png;base64," + "A".repeat(200_001) }));
});

test("renderQrPage embeds the token + polls; renderExpiredPage explains expiry", () => {
  const page = renderQrPage("abc123token");
  assert.ok(page.includes("abc123token"));
  assert.ok(page.includes("/status"));
  assert.ok(/TikTok/.test(page));
  assert.ok(/expired/i.test(renderExpiredPage()));
});

// ── Capability split (security regression for the QR-swap takeover) ──

test("writer credential is separate from the public read token", () => {
  const { token, writer } = putQr({});
  assert.notEqual(writer, token);
  assert.ok(writer.startsWith(token + ".")); // <readToken>.<secret>
  assert.ok(writer.length > token.length + 1); // carries a real secret half
  // The /connect page (all a human gets) embeds only the read token, never the
  // writer credential — so forwarding the link never leaks the write capability.
  const page = renderQrPage(token);
  assert.ok(page.includes(token));
  assert.ok(!page.includes(writer));
});

test("the public read token alone cannot write the QR (no QR-swap takeover)", () => {
  const { token, writer } = putQr({});
  putQr({ dataUrl: VALID, token: writer }); // legit agent sets the QR
  assert.equal(getQrSession(token)!.qr, VALID);
  // An attacker who only has the forwarded /connect/<token> link tries to swap
  // in their own login QR using the read token — must be rejected, QR unchanged.
  assert.throws(() => putQr({ dataUrl: VALID2, token }));
  assert.equal(getQrSession(token)!.qr, VALID);
});

test("a forged writer secret on a known read token is rejected", () => {
  const { token, writer } = putQr({});
  putQr({ dataUrl: VALID, token: writer });
  const forged = token + "." + "f".repeat(64);
  assert.throws(() => putQr({ dataUrl: VALID2, token: forged }));
  assert.equal(getQrSession(token)!.qr, VALID); // not swapped
});

test("marking done requires the writer credential (read token can't abort onboarding)", () => {
  const { token, writer } = putQr({});
  putQr({ dataUrl: VALID, token: writer });
  assert.throws(() => putQr({ token, done: true })); // attacker with only the link
  assert.equal(getQrSession(token)!.state, "ready"); // not aborted
  putQr({ token: writer, done: true }); // legit agent
  assert.equal(getQrSession(token)!.state, "completed");
});
