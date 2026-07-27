/**
 * Per-account device identity.
 *
 * Every operation used to launch a throwaway browser, so the platform saw the
 * same account arriving from a brand-new device on every single action — a
 * louder automation signal than the IP, and one that condemns each account on
 * its own rather than merely linking them.
 *
 * These cover the parts that are testable without driving a real browser: the
 * profile directory is stable and private, same-account work serialises while
 * different accounts stay parallel, and the flag genuinely gates the behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "fs";
import { join } from "path";

const FLAG = "SOCIAL_PERSISTENT_DEVICE";

async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  }
}

test("the flag gates persistent-device mode, and it is off by default", async () => {
  const rt = await import("../services/social-runtime");
  await withFlag(undefined, async () => assert.equal(rt.persistentDeviceEnabled(), false));
  await withFlag("0", async () => assert.equal(rt.persistentDeviceEnabled(), false));
  await withFlag("1", async () => assert.equal(rt.persistentDeviceEnabled(), true));
});

test("an account's profile directory is stable, per-account, and private", async () => {
  const rt = await import("../services/social-runtime");
  const a1 = rt.profileDirFor("acct-alpha");
  const a2 = rt.profileDirFor("acct-alpha");
  const b = rt.profileDirFor("acct-beta");

  assert.equal(a1, a2, "the same account must map to the same profile every time — that is the whole point");
  assert.notEqual(a1, b, "different accounts must never share a profile");

  // The directory holds live session cookies in plaintext, so it must not be
  // world-readable. (Permission bits are a POSIX concept; skip on Windows.)
  if (process.platform !== "win32") {
    const mode = statSync(a1).mode & 0o777;
    assert.equal(mode & 0o077, 0, `profile dir should not be group/other accessible, got ${mode.toString(8)}`);
  }
});

test("a hostile account id cannot escape the profile root", async () => {
  const rt = await import("../services/social-runtime");
  const dir = rt.profileDirFor("../../etc/passwd");
  assert.ok(!dir.includes(".."), "path traversal must not survive into the profile path");
  assert.ok(dir.includes(join("social-profiles", "______etc_passwd")) || /social-profiles/.test(dir));
});

test("same-account sessions serialise; different accounts run in parallel", async () => {
  // A Chrome profile may only be open by one process at a time, so two ops on
  // one account must queue. Two ops on DIFFERENT accounts must not.
  const rt: any = await import("../services/social-runtime");
  const acquire = rt.__testAcquireAccountLock;
  assert.ok(typeof acquire === "function", "test hook for the account lock should be exported");

  const order: string[] = [];
  const releaseA1 = await acquire("same-account");
  order.push("a1-acquired");

  let a2Acquired = false;
  const a2 = acquire("same-account").then((rel: () => void) => {
    a2Acquired = true;
    order.push("a2-acquired");
    return rel;
  });

  // A different account must not be blocked by the one held above.
  const releaseB = await acquire("other-account");
  order.push("b-acquired");

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a2Acquired, false, "a second op on the SAME account must wait");

  releaseA1();
  const releaseA2 = await a2;
  assert.equal(a2Acquired, true, "it must proceed once the first releases");

  releaseA2();
  releaseB();
  assert.deepEqual(order, ["a1-acquired", "b-acquired", "a2-acquired"]);
});

test("releasing an account lock twice is harmless", async () => {
  const rt: any = await import("../services/social-runtime");
  const release = await rt.__testAcquireAccountLock("double-release");
  release();
  release(); // a close() path that runs twice must not free someone else's turn
  const second = await rt.__testAcquireAccountLock("double-release");
  second();
});
