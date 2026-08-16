import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loginFailureForPhase,
  TWITTER_PASSWORD_SELECTOR,
  usernameFromProfileHref,
} from "../services/social-login";

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

test("loginFailureForPhase reports only the safe phase and timeout class", () => {
  const secret = "private-account-password";
  const failure = loginFailureForPhase("fill_password", new Error(`Timeout 30000ms exceeded while filling ${secret}`));
  assert.equal(failure.error_code, "LOGIN_TIMEOUT");
  assert.equal(failure.diagnostics?.phase, "fill_password");
  assert.equal(JSON.stringify(failure).includes(secret), false);
});

test("every X password selector branch excludes aria-hidden autofill decoys", () => {
  const branches = TWITTER_PASSWORD_SELECTOR.split(",").map((value) => value.trim());
  assert.ok(branches.length >= 2);
  assert.ok(branches.every((value) => value.includes(':not([aria-hidden="true"])')));
});
