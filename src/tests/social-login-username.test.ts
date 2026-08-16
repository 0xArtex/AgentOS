import { test } from "node:test";
import assert from "node:assert/strict";
import { usernameFromProfileHref } from "../services/social-login";

test("usernameFromProfileHref accepts X profile links", () => {
  assert.equal(usernameFromProfileHref("/valid_handle"), "valid_handle");
  assert.equal(usernameFromProfileHref("https://x.com/Agent123"), "Agent123");
  assert.equal(usernameFromProfileHref("https://twitter.com/legacy_user"), "legacy_user");
});

test("usernameFromProfileHref rejects routes, nested paths, and foreign hosts", () => {
  assert.equal(usernameFromProfileHref("/home"), undefined);
  assert.equal(usernameFromProfileHref("/valid_handle/status/123"), undefined);
  assert.equal(usernameFromProfileHref("https://example.com/valid_handle"), undefined);
  assert.equal(usernameFromProfileHref("/this_handle_is_far_too_long"), undefined);
  assert.equal(usernameFromProfileHref(null), undefined);
});
