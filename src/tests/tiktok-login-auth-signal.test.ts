/**
 * Regression for security audit #71 — TikTok login reported false success on a
 * dead/anonymous session. The left-nav profile/upload links also render for
 * logged-out users, so a positive race result alone is not proof of auth.
 * isAuthenticatedTikTokState() now requires the top-right profile avatar AND the
 * absence of any login affordance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAuthenticatedTikTokState } from "../services/tiktok-login";

test("a genuine login (avatar present, no login button) is authenticated", () => {
  assert.equal(
    isAuthenticatedTikTokState({
      authSignal: true,
      loginAffordanceVisible: false,
      profileAvatarVisible: true,
    }),
    true
  );
});

test("anonymous false positive: nav links won the race but a login button is present", () => {
  assert.equal(
    isAuthenticatedTikTokState({
      authSignal: true,
      loginAffordanceVisible: true,
      profileAvatarVisible: false,
    }),
    false
  );
});

test("authed signal but missing avatar is NOT trusted", () => {
  assert.equal(
    isAuthenticatedTikTokState({
      authSignal: true,
      loginAffordanceVisible: false,
      profileAvatarVisible: false,
    }),
    false
  );
});

test("a login button still present overrides the avatar", () => {
  assert.equal(
    isAuthenticatedTikTokState({
      authSignal: true,
      loginAffordanceVisible: true,
      profileAvatarVisible: true,
    }),
    false
  );
});

test("a negative or timed-out race is never authenticated", () => {
  assert.equal(
    isAuthenticatedTikTokState({
      authSignal: false,
      loginAffordanceVisible: false,
      profileAvatarVisible: true,
    }),
    false
  );
  assert.equal(
    isAuthenticatedTikTokState({
      authSignal: null,
      loginAffordanceVisible: false,
      profileAvatarVisible: true,
    }),
    false
  );
});
