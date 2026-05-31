import { test } from "node:test";
import assert from "node:assert/strict";
import { putQr, getQr, renderQrPage, renderExpiredPage } from "../services/qr-handoff";

const VALID = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("putQr stores and getQr retrieves the same data-URL", () => {
  const { token, expiresInSec } = putQr(VALID);
  assert.ok(token.length >= 16);
  assert.equal(expiresInSec, 300);
  assert.equal(getQr(token), VALID);
});

test("getQr returns null for an unknown token", () => {
  assert.equal(getQr("deadbeef".repeat(4)), null);
});

test("putQr rejects non-image / malformed data-URLs", () => {
  assert.throws(() => putQr("https://example.com/x.png"));
  assert.throws(() => putQr("data:text/html;base64,PHNjcmlwdD4="));
  assert.throws(() => putQr("not a url"));
});

test("putQr rejects oversized payloads", () => {
  const huge = "data:image/png;base64," + "A".repeat(200_001);
  assert.throws(() => putQr(huge));
});

test("renderQrPage embeds the QR and renderExpiredPage explains expiry", () => {
  const page = renderQrPage(VALID);
  assert.ok(page.includes(VALID));
  assert.ok(/TikTok/.test(page));
  assert.ok(/expired/i.test(renderExpiredPage()));
});
