/**
 * Async domain registration state machine.
 *
 * Money-critical: every branch either registers the domain, refunds the payer,
 * or defers to reconciliation — and must never both keep the money AND fail to
 * deliver, nor refund a domain we actually registered. These tests inject fake
 * registrar/refund deps so every path is exercised deterministically without
 * touching Namecheap or the treasury.
 */
import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "crypto";
import { db } from "../db";
import {
  runDomainRegistration,
  createRegistrationJob,
  getRegistrationJob,
  hasActiveRegistration,
  recoverStuckDomainRegistrations,
  DomainInFlightError,
  DomainRegistrationDeps,
  DomainRegistrationRow,
} from "../services/domain-registration";
import { resolveRegisterPrice } from "../routes/domains";

const OWNER = "TESTWALLET_domreg";
const DASH_OWNER = `dashboard:${OWNER}`;

function uniqueDomain(): string {
  return `t-${randomUUID().slice(0, 12)}.com`;
}

// Insert a pending job directly (bypassing the auto-scheduled worker) so worker
// tests run runDomainRegistration() deterministically.
function insertPending(over: Partial<DomainRegistrationRow> = {}): string {
  const id = over.id ?? randomUUID();
  db.prepare(
    `INSERT INTO domain_registrations
       (id, domain, owner, payment_signature, payment_chain, charged_usdc, expires_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    over.domain ?? uniqueDomain(),
    over.owner ?? OWNER,
    over.payment_signature === undefined ? `sig-${id}` : over.payment_signature,
    over.payment_chain === undefined ? "solana" : over.payment_chain,
    over.charged_usdc === undefined ? 10 : over.charged_usdc,
    over.expires_at ?? new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    over.status ?? "pending",
    over.created_at ?? new Date().toISOString()
  );
  return id;
}

interface Calls {
  create: number;
  owned: number;
  avail: number;
  refund: number;
  refundDashboard: number;
  write: number;
  lastRefund?: any;
  lastDashboardRefund?: any;
}

// Wrap the provided-or-default behaviour with call counting so an override (e.g.
// a throwing create, or owned=true) doesn't clobber the counter the default
// would have bumped. `over` supplies BEHAVIOUR; counting is always applied.
function makeDeps(over: Partial<DomainRegistrationDeps> = {}): { deps: DomainRegistrationDeps; calls: Calls } {
  const calls: Calls = { create: 0, owned: 0, avail: 0, refund: 0, refundDashboard: 0, write: 0 };
  const baseCreate = over.create ?? (async () => ({ success: true, registered: true, orderId: "ORD-1", rawSnippet: null }));
  const baseOwned = over.isOwnedAtRegistrar ?? (async () => true);
  const baseAvail = over.isAvailable ?? (async () => true);
  const baseRefund = over.refund ?? (async () => ({ ok: true, refundId: "REF-1", refundTx: "0xrefund" }));
  const baseRefundDashboard = over.refundDashboard ?? (() => {});
  const baseWrite = over.writeRegistryRow ?? (() => {});
  const deps: DomainRegistrationDeps = {
    create: (d) => { calls.create++; return baseCreate(d); },
    isOwnedAtRegistrar: (d) => { calls.owned++; return baseOwned(d); },
    isAvailable: (d) => { calls.avail++; return baseAvail(d); },
    refund: (o) => { calls.refund++; calls.lastRefund = o; return baseRefund(o); },
    refundDashboard: (uid, amt, ref, reason) => {
      calls.refundDashboard++;
      calls.lastDashboardRefund = { userId: uid, amountUsdc: amt, referenceId: ref, reason };
      baseRefundDashboard(uid, amt, ref, reason);
    },
    writeRegistryRow: (j, oid) => { calls.write++; baseWrite(j, oid); },
  };
  return { deps, calls };
}

async function waitForStatus(id: string, status: string, timeoutMs = 2000): Promise<DomainRegistrationRow> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = getRegistrationJob(id)!;
    if (job.status === status) return job;
    if (Date.now() > deadline) {
      assert.fail(`job ${id} never reached '${status}' (stuck at '${job.status}')`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

test.after(() => {
  db.prepare("DELETE FROM domain_registrations WHERE owner IN (?, ?)").run(OWNER, DASH_OWNER);
});

// ── Happy path ──
test("success → active, writes the registry row, never refunds", async () => {
  const id = insertPending();
  const { deps, calls } = makeDeps();
  await runDomainRegistration(id, deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "active");
  assert.equal(job.registrar_order_id, "ORD-1");
  assert.equal(calls.create, 1);
  assert.equal(calls.write, 1, "registry row written exactly once");
  assert.equal(calls.refund, 0, "a successful registration must never refund");
  assert.ok(job.completed_at);
});

// ── Definitive registrar decline ──
test("registrar declines → failed + auto-refund", async () => {
  const id = insertPending();
  const { deps, calls } = makeDeps({
    create: async () => ({ success: false, registered: false, orderId: null, rawSnippet: "<error/>" }),
  });
  await runDomainRegistration(id, deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "registrar_declined");
  assert.equal(calls.refund, 1, "a declined registration must refund");
  assert.equal(job.refund_status, "sent");
  assert.equal(job.refund_id, "REF-1");
  assert.equal(calls.write, 0, "no registry row on failure");
  // Refund must target the payer for the exact settled amount/chain.
  assert.equal(calls.lastRefund.payer, OWNER);
  assert.equal(calls.lastRefund.chain, "solana");
  assert.equal(calls.lastRefund.amountUsdc, 10);
  assert.ok(calls.lastRefund.originalPaymentSignature);
});

// ── Throw → reconcile: we DID own it (post-registration hiccup) ──
test("registrar throws but reconcile shows we own it → active, no refund", async () => {
  const id = insertPending();
  const { deps, calls } = makeDeps({
    create: async () => {
      throw new Error("ETIMEDOUT after submit");
    },
    isOwnedAtRegistrar: async () => true,
  });
  await runDomainRegistration(id, deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "active", "reconciliation must not refund a domain we own");
  assert.equal(calls.owned, 1);
  assert.equal(calls.refund, 0);
  assert.equal(calls.write, 1);
});

// ── Throw → reconcile: AMBIGUOUS even when "available" (no blind refund) ──
// An inline create() throw is ambiguous: the registrar may have registered the
// domain just past our client timeout, so a transient "available" must NOT
// trigger a refund (that would lose BOTH the registrar cost and the USDC).
// The inline path defers; the delayed recovery pass does the refund (below).
test("registrar throws inline → defers to 'registering' even if 'available' (no double-loss)", async () => {
  const id = insertPending();
  const { deps, calls } = makeDeps({
    create: async () => {
      throw new Error("ETIMEDOUT after submit");
    },
    isOwnedAtRegistrar: async () => {
      throw new Error("not in account yet");
    },
    isAvailable: async () => true, // looks free — but the registrar may still be settling
  });
  await runDomainRegistration(id, deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "registering", "an inline create() throw must defer, never refund on availability");
  assert.equal(job.error_code, "reconcile_unresolved");
  assert.equal(calls.refund, 0, "no refund on an ambiguous create timeout");
});

// ── Two-phase: inline defer, then the DELAYED recovery pass refunds ──
test("inline-deferred job is refunded by the delayed (settled) recovery pass", async () => {
  const id = insertPending();
  const phase1 = makeDeps({
    create: async () => { throw new Error("timeout"); },
    isOwnedAtRegistrar: async () => { throw new Error("not ours"); },
    isAvailable: async () => true,
  });
  await runDomainRegistration(id, phase1.deps);
  assert.equal(getRegistrationJob(id)!.status, "registering");
  assert.equal(phase1.calls.refund, 0, "inline pass never refunds");

  // Backdate past the stuck-age cutoff so the recovery sweep treats it as
  // settled, then run the delayed pass — now availability may drive the refund.
  db.prepare("UPDATE domain_registrations SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 10 * 60 * 1000).toISOString(), id);
  const phase2 = makeDeps({
    isOwnedAtRegistrar: async () => { throw new Error("still not ours"); },
    isAvailable: async () => true,
  });
  await recoverStuckDomainRegistrations(phase2.deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "failed", "the delayed pass resolves the deferred job");
  assert.equal(job.error_code, "reconciled_not_registered");
  assert.equal(phase2.calls.refund, 1, "the settled pass refunds a provably-unregistered domain");
});

// ── Throw → reconcile: ambiguous (taken but not provably ours) → defer ──
test("registrar throws and outcome ambiguous → stays 'registering', never refunds on uncertainty", async () => {
  const id = insertPending();
  const { deps, calls } = makeDeps({
    create: async () => {
      throw new Error("timeout");
    },
    isOwnedAtRegistrar: async () => {
      throw new Error("getInfo error");
    },
    isAvailable: async () => false, // taken, but getInfo didn't confirm it's ours
  });
  await runDomainRegistration(id, deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "registering", "must defer, not blind-fail/refund");
  assert.equal(job.error_code, "reconcile_unresolved");
  assert.equal(calls.refund, 0, "never auto-refund when the outcome is uncertain");
});

// ── Throw → reconcile: registrar fully unreachable → defer ──
test("registrar throws and registrar unreachable → stays 'registering', no refund", async () => {
  const id = insertPending();
  const { deps, calls } = makeDeps({
    create: async () => {
      throw new Error("timeout");
    },
    isOwnedAtRegistrar: async () => {
      throw new Error("unreachable");
    },
    isAvailable: async () => {
      throw new Error("unreachable");
    },
  });
  await runDomainRegistration(id, deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "registering");
  assert.equal(calls.refund, 0);
});

// ── Idempotency ──
test("re-running a non-pending job is a no-op (no double registrar call / refund)", async () => {
  const id = insertPending({ status: "active" });
  const { deps, calls } = makeDeps();
  await runDomainRegistration(id, deps);
  assert.equal(calls.create, 0, "must not call the registrar for an already-terminal job");
  assert.equal(calls.refund, 0);
  assert.equal(getRegistrationJob(id)!.status, "active");
});

// ── Missing payment context can't auto-refund ──
test("failure with missing payment context flags refund_status='manual_needed' (no blind refund)", async () => {
  const id = insertPending({ payment_chain: null });
  const { deps, calls } = makeDeps({
    create: async () => ({ success: false, registered: false, orderId: null, rawSnippet: null }),
  });
  await runDomainRegistration(id, deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "failed");
  assert.equal(job.refund_status, "manual_needed");
  assert.equal(calls.refund, 0, "cannot auto-refund without chain — flag for ops instead");
});

// ── Dashboard-balance payer refund symmetry ──
// A dashboard payer is debited up front by the auth middleware on the 202; a
// failed async registration must credit that balance back (the symmetric
// counterpart to the wallet payer's on-chain refund), NOT issue an on-chain tx.
test("dashboard payer: declined registration credits the dashboard balance back (not on-chain)", async () => {
  const id = insertPending({
    owner: DASH_OWNER,
    payment_signature: null,
    payment_chain: null,
    charged_usdc: 12,
  });
  const { deps, calls } = makeDeps({
    create: async () => ({ success: false, registered: false, orderId: null, rawSnippet: null }),
  });
  await runDomainRegistration(id, deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "failed");
  assert.equal(job.refund_status, "sent");
  assert.equal(calls.refund, 0, "dashboard payer must NOT get an on-chain refund");
  assert.equal(calls.refundDashboard, 1, "dashboard payer is credited back on their balance");
  assert.equal(calls.lastDashboardRefund.userId, OWNER, "credited the underlying user id (prefix stripped)");
  assert.equal(calls.lastDashboardRefund.amountUsdc, 12);
  assert.equal(calls.lastDashboardRefund.referenceId, id, "keyed on the job id for idempotency");
});

test("dashboard payer with no recorded charge → manual_needed (no blind credit)", async () => {
  const id = insertPending({
    owner: DASH_OWNER,
    payment_signature: null,
    payment_chain: null,
    charged_usdc: null,
  });
  const { deps, calls } = makeDeps({
    create: async () => ({ success: false, registered: false, orderId: null, rawSnippet: null }),
  });
  await runDomainRegistration(id, deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "failed");
  assert.equal(job.refund_status, "manual_needed");
  assert.equal(calls.refundDashboard, 0, "no amount recorded — flag for ops, never guess");
});

test("dashboard payer: successful registration keeps the charge (no credit-back)", async () => {
  const id = insertPending({
    owner: DASH_OWNER,
    payment_signature: null,
    payment_chain: null,
    charged_usdc: 12,
  });
  const { deps, calls } = makeDeps();
  await runDomainRegistration(id, deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "active");
  assert.equal(calls.refundDashboard, 0, "a successful registration must not credit back");
  assert.equal(calls.refund, 0);
});

// ── TLD allowlist / premium pricing policy (money path) ──
test("register pricing: an unsupported TLD is refused, not floored", async () => {
  const r = await resolveRegisterPrice("luxury", async () => 800);
  assert.ok("error" in r, "an exotic TLD must be refused outright");
  assert.equal((r as any).code, "unsupported_tld");
});

test("register pricing: an allowlisted TLD whose live price can't resolve is refused (not floored)", async () => {
  const r = await resolveRegisterPrice("ai", async () => null);
  assert.ok("error" in r, "must refuse rather than charge a stale floor");
  assert.equal((r as any).code, "price_unavailable");
});

test("register pricing: an allowlisted TLD with a live price → live base + 25% markup", async () => {
  const r = await resolveRegisterPrice("com", async () => 18.48);
  assert.ok(!("error" in r));
  const priced = r as { basePrice: number; finalPrice: number };
  assert.equal(priced.basePrice, 18.48, "operator-side base price is the live registrar price");
  assert.equal(priced.finalPrice, Math.round(18.48 * 1.25 * 100) / 100, "customer price applies the markup");
});

test("register pricing: a zero/garbage live price is refused (not charged)", async () => {
  const r = await resolveRegisterPrice("io", async () => 0);
  assert.ok("error" in r);
  assert.equal((r as any).code, "price_unavailable");
});

// ── Concurrency guard ──
test("a second in-flight registration of the same domain is rejected", async () => {
  const domain = uniqueDomain();
  insertPending({ domain }); // first job in flight
  assert.equal(hasActiveRegistration(domain), true);
  assert.throws(
    () =>
      createRegistrationJob({
        domain,
        owner: OWNER,
        paymentSignature: "sig-2",
        paymentChain: "solana",
        chargedUsdc: 10,
        expiresAt: new Date(Date.now() + 1e10).toISOString(),
      }),
    (e: unknown) => e instanceof DomainInFlightError,
    "concurrent same-domain registration must throw DomainInFlightError"
  );
});

// ── Full create → scheduled worker → active ──
test("createRegistrationJob schedules the worker and reaches 'active'", async () => {
  const domain = uniqueDomain();
  const { deps, calls } = makeDeps();
  const job = createRegistrationJob(
    {
      domain,
      owner: OWNER,
      paymentSignature: "sig-x",
      paymentChain: "base",
      chargedUsdc: 12,
      expiresAt: new Date(Date.now() + 1e10).toISOString(),
    },
    deps
  );
  assert.equal(job.status, "pending");
  const done = await waitForStatus(job.id, "active");
  assert.equal(done.status, "active");
  assert.equal(calls.create, 1);
  assert.equal(calls.write, 1);
});

// ── Crash recovery ──
test("recovery re-runs a stale 'pending' job (registrar was never called)", async () => {
  const id = insertPending({ created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  const { deps, calls } = makeDeps();
  await recoverStuckDomainRegistrations(deps);
  assert.equal(getRegistrationJob(id)!.status, "active");
  assert.equal(calls.create, 1, "a never-started job is safe to register");
});

test("recovery reconciles a stale 'registering' job via the registrar (owned → active)", async () => {
  const id = insertPending({
    status: "registering",
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  const { deps, calls } = makeDeps({ isOwnedAtRegistrar: async () => true });
  await recoverStuckDomainRegistrations(deps);
  assert.equal(getRegistrationJob(id)!.status, "active");
  assert.equal(calls.create, 0, "a job that may have registered must reconcile, not re-register");
  assert.equal(calls.owned, 1);
});

test("recovery refunds a stale 'registering' job that provably never registered", async () => {
  const id = insertPending({
    status: "registering",
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  const { deps, calls } = makeDeps({
    isOwnedAtRegistrar: async () => {
      throw new Error("not ours");
    },
    isAvailable: async () => true,
  });
  await recoverStuckDomainRegistrations(deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "failed");
  assert.equal(calls.refund, 1);
});
