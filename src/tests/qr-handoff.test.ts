import { test } from "node:test";
import assert from "node:assert/strict";
import { putQr, getQrSession, renderQrPage, renderExpiredPage } from "../services/qr-handoff";

const VALID = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const VALID2 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

test("create session → waiting; update → ready with the QR", () => {
  const { token, expiresInSec } = putQr({});
  assert.ok(token.length >= 16);
  assert.equal(expiresInSec, 900);
  assert.equal(getQrSession(token)!.state, "waiting");
  assert.equal(getQrSession(token)!.qr, null);
  putQr({ dataUrl: VALID, token });
  assert.equal(getQrSession(token)!.state, "ready");
  assert.equal(getQrSession(token)!.qr, VALID);
});

test("update refreshes the QR on the same token; done → completed", () => {
  const { token } = putQr({ dataUrl: VALID });
  assert.equal(getQrSession(token)!.qr, VALID);
  putQr({ dataUrl: VALID2, token });
  assert.equal(getQrSession(token)!.qr, VALID2); // rotated QR is reflected
  putQr({ token, done: true });
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
