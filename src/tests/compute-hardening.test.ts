/**
 * Regression tests for the compute-route hardening sweep (work/compute-hardening).
 *
 * Covers the three audited findings fixed in src/routes/compute.ts:
 *  - #21 SSH host-key verification: sshCmd() must PIN a per-server host key and
 *        never disable checking; the pin is keyed by server id (not IP, so
 *        Hetzner IP reuse can't false-reject), TOFU-bootstraps when unpinned and
 *        strictly rejects once pinned, and clears on rebuild/recycled-IP.
 *  - #46 assertGitUrl: must reject shell metacharacters (;, &, quotes, parens,
 *        space, $, backtick, backslash) that the REMOTE shell would interpret.
 *  - #47 per-type deploy pricing: POST /compute/servers must charge the
 *        advertised per-type price, not a flat $6.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";

// Mirror compute-preflight.test.ts's env hygiene (shared test process): keep the
// hcloud catalog importable and make sure no real treasury key is ever loaded.
process.env.HCLOUD_TOKEN = process.env.HCLOUD_TOKEN || "test-token";
process.env.HCLOUD_LOCATION = process.env.HCLOUD_LOCATION || "fsn1";
delete process.env.TREASURY_SOL_PRIVATE_KEY;
delete process.env.SVM_PRIVATE_KEY;
delete process.env.TREASURY_EVM_PRIVATE_KEY;

import {
  sshCmd,
  assertGitUrl,
  clearHostKeyPin,
  hostKeyFile,
  priceForServerType,
  deployPriceForRequest,
} from "../routes/compute";

const TEST_ID = "testpin-hardening-001";
const TEST_IP = "203.0.113.42";

describe("compute hardening", () => {
  after(() => {
    for (const id of [TEST_ID, "server-aaa", "server-bbb"]) clearHostKeyPin(id);
  });

  describe("sshCmd host-key pinning (audit #21)", () => {
    it("NEVER disables host-key checking (no StrictHostKeyChecking=no, no /dev/null)", () => {
      clearHostKeyPin(TEST_ID);
      const cmd = sshCmd(TEST_IP, TEST_ID);
      assert.ok(!/StrictHostKeyChecking=no\b/.test(cmd), cmd);
      assert.ok(!cmd.includes("UserKnownHostsFile=/dev/null"), cmd);
      assert.ok(cmd.includes("StrictHostKeyChecking="), cmd);
    });

    it("pins to a per-server known_hosts file keyed by server id, not IP", () => {
      // Same IP, different server ids → distinct pin files (Hetzner reuses IPs).
      const a = sshCmd(TEST_IP, "server-aaa");
      const b = sshCmd(TEST_IP, "server-bbb");
      assert.notEqual(hostKeyFile("server-aaa"), hostKeyFile("server-bbb"));
      assert.ok(a.includes(`UserKnownHostsFile=${hostKeyFile("server-aaa")}`), a);
      assert.ok(b.includes(`UserKnownHostsFile=${hostKeyFile("server-bbb")}`), b);
      clearHostKeyPin("server-aaa");
      clearHostKeyPin("server-bbb");
    });

    it("TOFU-bootstraps when unpinned, then strict-rejects once a pin exists", () => {
      clearHostKeyPin(TEST_ID);
      assert.match(sshCmd(TEST_IP, TEST_ID), /StrictHostKeyChecking=accept-new\b/);
      // Simulate an established pin.
      fs.writeFileSync(hostKeyFile(TEST_ID), `${TEST_IP} ssh-ed25519 AAAAEXAMPLEKEY\n`, { mode: 0o600 });
      assert.match(sshCmd(TEST_IP, TEST_ID), /StrictHostKeyChecking=yes\b/);
      clearHostKeyPin(TEST_ID);
    });

    it("clearHostKeyPin removes the pin so a rebuilt/recycled host re-TOFUs", () => {
      fs.writeFileSync(hostKeyFile(TEST_ID), "stale\n");
      assert.ok(fs.existsSync(hostKeyFile(TEST_ID)));
      clearHostKeyPin(TEST_ID);
      assert.ok(!fs.existsSync(hostKeyFile(TEST_ID)));
    });

    it("rejects a non-IP host before it can reach a shell", () => {
      assert.throws(() => sshCmd("1.2.3.4; rm -rf /", TEST_ID), /Invalid server IP/);
      assert.throws(() => sshCmd("$(curl evil)", TEST_ID), /Invalid server IP/);
    });

    it("rejects a path-traversal / unsafe server id", () => {
      assert.throws(() => hostKeyFile("../../etc/passwd"), /Invalid server id/);
      assert.throws(() => hostKeyFile("a b"), /Invalid server id/);
    });
  });

  describe("assertGitUrl (audit #46)", () => {
    it("accepts a normal https git URL", () => {
      assert.equal(
        assertGitUrl("https://github.com/owner/repo.git"),
        "https://github.com/owner/repo.git",
      );
      assert.doesNotThrow(() => assertGitUrl("https://gitlab.example.com:8443/group/sub_proj-1.git"));
    });

    it("rejects shell metacharacters the remote shell would interpret", () => {
      const bad = [
        "https://a.com/r.git;reboot",          // command separator (the audit PoC)
        "https://a.com/r.git&whoami",          // background / separator
        "https://a.com/r.git|cat",             // pipe
        "https://a.com/$(id).git",             // command substitution
        "https://a.com/`id`.git",              // backtick substitution
        "https://a.com/r.git'x'",              // single quote
        'https://a.com/r.git"x',               // double quote
        "https://a.com/r(.git)",               // parens
        "https://a.com/r.git x",               // space
        "https://a.com/\\x.git",               // backslash
        "http://a.com/r.git",                  // non-https scheme
        "ftp://a.com/r.git",                   // non-https scheme
      ];
      for (const u of bad) {
        assert.throws(() => assertGitUrl(u), /Invalid git URL/, `should reject: ${u}`);
      }
    });
  });

  describe("per-type deploy pricing (audit #47)", () => {
    const plans = [
      { type: "cpx11", priceUsdc: "7.00" },
      { type: "cpx21", priceUsdc: "15.00" },
      { type: "cpx31", priceUsdc: "26.00" },
    ];

    it("charges the advertised per-type price, not a flat $6", () => {
      assert.equal(priceForServerType("cpx11", plans), 7);
      assert.equal(priceForServerType("cpx21", plans), 15);
      assert.equal(priceForServerType("cpx31", plans), 26);
    });

    it("falls back to the flat price for an unknown/blank type (never $0, never throws)", () => {
      assert.equal(priceForServerType("does-not-exist", plans), 6.0);
      assert.equal(priceForServerType("", plans), 6.0);
    });

    it("deployPriceForRequest prices from the resolved body.serverType (re-prices substitutes)", () => {
      // Reads the same live catalog priceForServerType reads, so they must agree
      // regardless of whether the catalog is live or in static fallback.
      const req: any = { body: { serverType: "cpx31" } };
      assert.equal(deployPriceForRequest(req), priceForServerType("cpx31"));
      // Missing serverType → flat fallback, never $0.
      assert.equal(deployPriceForRequest({ body: {} } as any), 6.0);
    });
  });
});
