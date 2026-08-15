import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("socials deploy modal keeps the compact layout without the removed note", () => {
  const html = readFileSync(resolve(process.cwd(), "public/socials.html"), "utf8");

  assert.match(html, /id="createScrim"[\s\S]*?class="modal lg"/);
  assert.match(html, /id="dz" role="button" tabindex="0"/);
  assert.match(html, /aria-label="Upload profile photo"/);
  assert.match(html, /aria-label="Close deploy modal"/);
  assert.match(html, /id="createPlatformIcon"/);
  assert.match(html, /id="dUsername"[^>]*maxlength="16"/);
  assert.match(html, /payload\.username=username/);
  assert.match(html, /href="https:\/\/x\.com\/\$\{encodeURIComponent\(clean\)\}" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /onclick="event\.stopPropagation\(\)"/);
  assert.match(html, /showHandle\?handleLink\(handle,true\):'ready'/);
  assert.match(html, /accounts\.map\(a=>optimistic\[a\.account_id\][\s\S]*?_opt:optimistic\[a\.account_id\]/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /setupMessage:'Warming up account'/);
  assert.match(html, /body\.progress\.message/);
  assert.match(html, /delete optimistic\[accountId\]/);
  assert.match(html, /resumePendingSetups\(\)/);
  assert.doesNotMatch(html, /tries>30/);
  assert.match(html, /\.card \.av\{[^}]*overflow:hidden[^}]*\}/);
  assert.match(html, /\.card \.av img\{[^}]*width:100%[^}]*height:100%[^}]*object-fit:cover[^}]*\}/);
  assert.doesNotMatch(html, /create-modal|create-platform-mark|UPLOAD_PLACEHOLDER/);
  assert.doesNotMatch(html, /box-shadow:0 28px 90px/);
  assert.doesNotMatch(html, /cosmetic hiccup never refunds your account/i);

  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  assert.ok(inlineScripts.length > 0, "expected at least one inline script");
  for (const source of inlineScripts) {
    assert.doesNotThrow(() => new Function(source), "inline JavaScript must parse");
  }
});
