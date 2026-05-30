import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveElement, axSnapshot } from "../services/social-selectors";

/** Fake Playwright locator whose waitFor resolves or rejects on demand. */
function loc(ok: boolean) {
  return { first: () => ({ waitFor: async () => { if (!ok) throw new Error("miss"); } }) };
}

test("resolveElement returns the first strategy that resolves", async () => {
  const r = await resolveElement({} as any, [
    { name: "a", build: () => loc(false) },
    { name: "b", build: () => loc(true) },
    { name: "c", build: () => loc(true) },
  ], { perStrategyMs: 50 });
  assert.equal(r?.strategy, "b");
});

test("resolveElement returns null when every strategy misses", async () => {
  const r = await resolveElement({} as any, [
    { name: "a", build: () => loc(false) },
    { name: "b", build: () => loc(false) },
  ], { perStrategyMs: 20 });
  assert.equal(r, null);
});

test("resolveElement prefers the earliest strategy even if later ones also match", async () => {
  const r = await resolveElement({} as any, [
    { name: "first", build: () => loc(true) },
    { name: "second", build: () => loc(true) },
  ], { perStrategyMs: 50 });
  assert.equal(r?.strategy, "first");
});

test("axSnapshot flattens interactive nodes and applies the limit", async () => {
  const page: any = {
    accessibility: {
      snapshot: async () => ({
        role: "WebArea", name: "root",
        children: [
          { role: "button", name: "Post" },
          { role: "text", name: "ignore me" },
          { role: "textbox", name: "Caption", children: [{ role: "link", name: "hashtag" }] },
        ],
      }),
    },
  };
  const els = await axSnapshot(page, 2);
  assert.equal(els.length, 2);
  assert.deepEqual(els[0], { role: "button", name: "Post" });
  assert.ok(els.every((e) => e.role !== "text"));
});

test("axSnapshot is best-effort and returns [] on failure", async () => {
  const page: any = { accessibility: { snapshot: async () => { throw new Error("no ax"); } } };
  assert.deepEqual(await axSnapshot(page), []);
});
