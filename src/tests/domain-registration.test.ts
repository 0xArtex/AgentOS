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

const OWNER = "TESTWALLET_domreg";

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
  write: number;
  lastRefund?: any;
}

// Wrap the provided-or-default behaviour with call counting so an override (e.g.
// a throwing create, or owned=true) doesn't clobber the counter the default
// would have bumped. `over` supplies BEHAVIOUR; counting is always applied.
function makeDeps(over: Partial<DomainRegistrationDeps> = {}): { deps: DomainRegistrationDeps; calls: Calls } {
  const calls: Calls = { create: 0, owned: 0, avail: 0, refund: 0, write: 0 };
  const baseCreate = over.create ?? (async () => ({ success: true, registered: true, orderId: "ORD-1", rawSnippet: null }));
  const baseOwned = over.isOwnedAtRegistrar ?? (async () => true);
  const baseAvail = over.isAvailable ?? (async () => true);
  const baseRefund = over.refund ?? (async () => ({ ok: true, refundId: "REF-1", refundTx: "0xrefund" }));
  const baseWrite = over.writeRegistryRow ?? (() => {});
  const deps: DomainRegistrationDeps = {
    create: (d) => { calls.create++; return baseCreate(d); },
    isOwnedAtRegistrar: (d) => { calls.owned++; return baseOwned(d); },
    isAvailable: (d) => { calls.avail++; return baseAvail(d); },
    refund: (o) => { calls.refund++; calls.lastRefund = o; return baseRefund(o); },
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
  db.prepare("DELETE FROM domain_registrations WHERE owner = ?").run(OWNER);
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

// ── Throw → reconcile: provably not registered ──
test("registrar throws and domain is provably available → failed + refund", async () => {
  const id = insertPending();
  const { deps, calls } = makeDeps({
    create: async () => {
      throw new Error("network reset");
    },
    isOwnedAtRegistrar: async () => {
      throw new Error("not in account");
    },
    isAvailable: async () => true,
  });
  await runDomainRegistration(id, deps);
  const job = getRegistrationJob(id)!;
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "reconciled_not_registered");
  assert.equal(calls.refund, 1);
  assert.equal(job.refund_status, "sent");
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
