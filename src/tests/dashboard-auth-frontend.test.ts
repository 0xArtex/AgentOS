import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const file of ["public/dashboard.html", "public/socials.html"]) {
  test(`${file} wires verified signup without breaking inline JavaScript`, () => {
    const html = readFileSync(resolve(process.cwd(), file), "utf8");
    assert.match(html, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/);
    assert.match(html, /id="registerTurnstile"/);
    assert.match(html, /turnstileToken/);
    assert.match(html, /continuePath/);
    assert.match(html, /RESEND VERIFICATION/);
    assert.match(html, /Password \(min 10 chars\)/);
    assert.doesNotMatch(html, /Password \(min 6 chars\)/);

    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    assert.ok(inlineScripts.length > 0, "expected at least one inline script");
    for (const source of inlineScripts) {
      assert.doesNotThrow(() => new Function(source), "inline JavaScript must parse");
    }
  });
}
