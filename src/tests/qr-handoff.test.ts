import { test } from "node:test";
import assert from "node:assert/strict";
import {
  putQr, getQrSession, renderQrPage, renderExpiredPage,
  createScreenSession, pushFrame, enqueueInput, getLive, sessionMode, renderScreenPage,
} from "../services/qr-handoff";

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

/* ─── Screencast (remote) mode ───────────────────────────────────────────── */

const FRAME = "Zm9vYmFyMTIz"; // valid base64
const FRAME2 = "YmF6cXV4OTk5";

test("screen session: create → waiting; pushFrame → ready + frame; getLive reflects it", () => {
  const { token, expiresInSec } = createScreenSession();
  assert.equal(expiresInSec, 900);
  assert.equal(sessionMode(token), "screen");
  const l0 = getLive(token)!;
  assert.equal(l0.state, "waiting");
  assert.equal(l0.mode, "screen");
  assert.equal(l0.frame, null);
  assert.equal(l0.seq, 0);

  const r = pushFrame(token, { frame: FRAME, vw: 800, vh: 600 });
  assert.deepEqual(r, { input: [], state: "ready" });
  const l1 = getLive(token)!;
  assert.equal(l1.state, "ready");
  assert.equal(l1.frame, FRAME);
  assert.equal(l1.seq, 1);
  assert.equal(l1.vw, 800);
  assert.equal(l1.vh, 600);

  // a new frame bumps seq so the page knows to repaint
  pushFrame(token, { frame: FRAME2 });
  assert.equal(getLive(token)!.seq, 2);
  assert.equal(getLive(token)!.frame, FRAME2);
});

test("enqueueInput validates + sanitizes; pushFrame drains the queue once", () => {
  const { token } = createScreenSession();
  enqueueInput(token, [
    { t: "m", k: "down", x: 0.5, y: 0.5, b: 0, n: 1 },
    { t: "x", s: "hello" },
    { t: "k", k: "down", key: "Enter", code: "Enter", vk: 13 },
    { t: "m", k: "move", x: 5, y: -2 }, // out-of-range coords get clamped, not dropped
    { t: "bogus" },                      // unknown type → dropped
    { nope: true },                      // malformed → dropped
  ]);
  const drained = pushFrame(token, { frame: FRAME })!.input;
  assert.equal(drained.length, 4); // 3 valid + 1 clamped; 2 junk removed
  const move = drained[3] as any;
  assert.equal(move.x, 1); // clamped to [0,1]
  assert.equal(move.y, 0);
  // queue is emptied after a drain
  assert.deepEqual(pushFrame(token, {})!.input, []);
});

test("pushFrame rejects non-base64 / oversized frames", () => {
  const { token } = createScreenSession();
  assert.throws(() => pushFrame(token, { frame: "not base64!!" }));
  assert.throws(() => pushFrame(token, { frame: "A".repeat(2_000_001) }));
});

test("done marks the screen session completed", () => {
  const { token } = createScreenSession();
  pushFrame(token, { frame: FRAME });
  const r = pushFrame(token, { done: true })!;
  assert.equal(r.state, "completed");
  assert.equal(getLive(token)!.state, "completed");
});

test("modes don't cross-contaminate; unknown tokens are null", () => {
  const screen = createScreenSession().token;
  // screen-only ops reject a QR token and vice-versa
  const qr = putQr({}).token;
  assert.equal(pushFrame(qr, { frame: FRAME }), null);
  assert.equal(enqueueInput(qr, []), null);
  // putQr must not repurpose a screencast session
  const before = getLive(screen)!.mode;
  putQr({ token: screen, dataUrl: VALID });
  assert.equal(getLive(screen)!.mode, before); // still "screen"
  assert.equal(sessionMode("deadbeef".repeat(4)), null);
  assert.equal(getLive("deadbeef".repeat(4)), null);
});

test("renderScreenPage embeds the token, polls /live, posts /input", () => {
  const page = renderScreenPage("scr33ntoken");
  assert.ok(page.includes("scr33ntoken"));
  assert.ok(page.includes("/live"));
  assert.ok(page.includes("/input"));
  assert.ok(/screencast|live|browser/i.test(page));
});
