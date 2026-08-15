import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("socials deploy modal uses the refreshed accessible layout", () => {
  const html = readFileSync(resolve(process.cwd(), "public/socials.html"), "utf8");

  assert.match(html, /class="modal lg create-modal"/);
  assert.match(html, /id="createPlatformMark"/);
  assert.match(html, /class="upload-placeholder"/);
  assert.match(html, /aria-label="Upload profile photo"/);
  assert.match(html, /aria-label="Close deploy modal"/);
  assert.match(html, /UPLOAD_PLACEHOLDER/);
  assert.doesNotMatch(html, /cosmetic hiccup never refunds your account/i);

  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  assert.ok(inlineScripts.length > 0, "expected at least one inline script");
  for (const source of inlineScripts) {
    assert.doesNotThrow(() => new Function(source), "inline JavaScript must parse");
  }
});
