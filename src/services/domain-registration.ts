/**
 * Async domain registration.
 *
 * Namecheap's `domains.create` is a slow, money-moving, externally-side-effecting
 * call: the payer's USDC has already settled to the treasury (x402 settles
 * BEFORE the route handler runs), and registering the domain costs the operator
 * real money at the registrar. Doing it inline blocks the HTTP request for many
 * seconds and — worse — if the connection drops (Cloudflare tunnel timeout) the
 * caller never learns whether they got the domain they paid for.
 *
 * This service decouples the registration from the request, modelled on the
 * `transfers` subsystem, and adds the two things money + external side-effects
 * demand:
 *
 *   1. AUTO-REFUND on definitive failure. If the registrar declines (or never
 *      registered), the settled USDC is sent back automatically and idempotently
 *      (refundUsdcToPayer dedups on the payment signature).
 *
 *   2. RECONCILIATION on the unknown case. A registrar call that *throws*
 *      (network/timeout) or a crash mid-flight leaves us not knowing whether the
 *      domain registered. We never blind-refund (that risks paying the user back
 *      for a domain we DID buy them) and never blind-fail (that strands a domain
 *      they own). Instead we ask the registrar: `getInfo(domain)` resolves iff
 *      the domain is in our account. owned → active, not-registered → refund,
 *      ambiguous → defer to the next reconciliation pass / manual ops.
 *
 * Lifecycle:  pending → registering → (active | failed)
 *
 *   POST /domains/register → createRegistrationJob (status='pending') → 202
 *     { operation_id, status, poll_url }, worker kicked via setImmediate.
 *   Worker → flips 'registering', calls registrar, writes the `domains` registry
 *     row on success, or marks failed + refunds on definitive failure.
 *   GET /domains/operations/:id → poll until status is terminal.
 *
 * Crash recovery: on module import, recoverStuckDomainRegistrations() reconciles
 * any job left 'pending'/'registering' by a previous process — re-running ones
 * the registrar was never called for, and registrar-reconciling the rest.
 */
import { randomUUID } from "crypto";
import { db } from "../db";
import { namecheapRequest } from "./namecheap";
import { refundUsdcToPayer, RefundOpts, RefundResult } from "./refund";
import * as balanceService from "./balance";

// The registrar's domains.create can be slow but still succeed. The client
// timeout MUST sit well above typical registration latency: a create() that
// trips a short timeout THROWS, and a throw is treated as ambiguous (the domain
// may have registered past the timeout). Keeping this generous shrinks the
// window where a real registration looks like a failure. This runs in the
// background worker, off the HTTP request path, so a long budget is safe and
// stays under the STUCK_AGE_MS the recovery sweep uses to decide a job is stale.
const REGISTRAR_CREATE_TIMEOUT_MS = 90_000;

// Dashboard-balance payers are identified as `dashboard:<userId>` (set by the
// auth middleware). Unlike on-chain payers they have no payment signature/chain;
// a failed registration is made whole by crediting their internal balance back.
const DASHBOARD_OWNER_PREFIX = "dashboard:";
function dashboardUserId(owner: string): string | null {
  return owner.startsWith(DASHBOARD_OWNER_PREFIX) ? owner.slice(DASHBOARD_OWNER_PREFIX.length) : null;
}

export type DomainRegistrationStatus = "pending" | "registering" | "active" | "failed";

export interface DomainRegistrationRow {
  id: string;
  domain: string;
  owner: string;
  payment_signature: string | null;
  payment_chain: "solana" | "base" | null;
  charged_usdc: number | null;
  expires_at: string;
  status: DomainRegistrationStatus;
  registrar_order_id: string | null;
  error: string | null;
  error_code: string | null;
  refund_id: string | null;
  refund_status: string | null; // 'sent' | 'failed' | 'skipped' | 'manual_needed' | null
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ─── Schema ───
// Owned by this service (like refunds). The job row is the operation record; the
// `domains` table remains the registry of successfully-owned domains.
db.exec(`
  CREATE TABLE IF NOT EXISTS domain_registrations (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    owner TEXT NOT NULL,
    payment_signature TEXT,
    payment_chain TEXT,
    charged_usdc REAL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','registering','active','failed')),
    registrar_order_id TEXT,
    error TEXT,
    error_code TEXT,
    refund_id TEXT,
    refund_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','utc')),
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_domain_reg_owner ON domain_registrations(owner);
  CREATE INDEX IF NOT EXISTS idx_domain_reg_status ON domain_registrations(status);
`);
// Partial UNIQUE: at most one IN-FLIGHT or SUCCESSFUL job per domain. A second
// concurrent registration of the same domain fails this INSERT (handled by the
// caller as "already being registered"), while a fresh attempt after a 'failed'
// job is still allowed. Wrapped defensively in case a pre-existing prod DB holds
// duplicates — the route-level checks remain a backstop either way.
try {
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_domain_reg_inflight ON domain_registrations(domain) WHERE status IN ('pending','registering','active')"
  );
} catch (err) {
  console.error("[domain-registration] could not create in-flight unique index (reconcile duplicates):", err);
}

// ─── Dependency injection (testability) ───
// The state machine is pure DB + these side-effecting deps. Tests inject fakes
// to exercise every branch (success, decline, throw→reconcile, refund, recovery)
// without touching Namecheap or the treasury.
export interface RegistrarOutcome {
  success: boolean;
  registered: boolean;
  orderId: string | null;
  rawSnippet: string | null;
}

export interface DomainRegistrationDeps {
  /** Register the domain. Resolves with the registrar's verdict; throws on network/timeout/registrar-error. */
  create: (domain: string) => Promise<RegistrarOutcome>;
  /** Resolves iff the domain is in OUR registrar account; throws otherwise. The reconciliation oracle. */
  isOwnedAtRegistrar: (domain: string) => Promise<boolean>;
  /** Best-effort availability check used to disambiguate a failed getInfo. */
  isAvailable: (domain: string) => Promise<boolean>;
  /** Issue the on-chain refund (idempotent on the payment signature). */
  refund: (opts: RefundOpts) => Promise<RefundResult>;
  /**
   * Credit a dashboard-balance payer back on failure (idempotent on the job id).
   * The dashboard identity is debited up front by the auth middleware on the
   * 202; this returns it when the async registration ultimately fails — the
   * symmetric equivalent of the on-chain refund a wallet payer gets.
   */
  refundDashboard: (userId: string, amountUsdc: number, referenceId: string, reason: string) => void;
  /** Write the `domains` registry row on success. */
  writeRegistryRow: (job: DomainRegistrationRow, orderId: string | null) => void;
}

// ─── Registrant contact (WHOIS) ───
// ICANN requires ACCURATE registrant contact data. Verifiably fake WHOIS/RDAP
// (a fictitious name/address/phone) is grounds for registrar verification
// challenges and domain suspension, and the listed email/phone receive every
// transfer-approval and verification notice. So the contact block is sourced
// from the operator's configured profile (env) — never a hardcoded placeholder.
// If it isn't configured we FAIL CLOSED: we refuse to register with fabricated
// data, the worker treats the create as failed, and the payer is refunded.
// (See SECURITY_AUDIT_2026-06-28 #52.)
//
// Required env (ALL must be set to register a domain):
//   NAMECHEAP_REGISTRANT_FIRST_NAME   NAMECHEAP_REGISTRANT_LAST_NAME
//   NAMECHEAP_REGISTRANT_ADDRESS1     NAMECHEAP_REGISTRANT_CITY
//   NAMECHEAP_REGISTRANT_STATE_PROVINCE  NAMECHEAP_REGISTRANT_POSTAL_CODE
//   NAMECHEAP_REGISTRANT_COUNTRY (2-letter)  NAMECHEAP_REGISTRANT_PHONE (+NNN.NNNNNNNNN)
//   NAMECHEAP_REGISTRANT_EMAIL
//
// Optional:
//   NAMECHEAP_REGISTRANT_ORGANIZATION — the operator ORGANISATION behind the
//   contact. One registrant backs every domain this instance registers on behalf
//   of its callers, so naming the org and using a role contact ("Domain
//   Administrator") keeps a named individual out of the record while staying
//   accurate: it really is the organisation's role contact. That is the correct
//   shape for a reseller — unlike a placeholder personal name, which is
//   verifiably false and invites the very verification challenge this block
//   exists to avoid. Omitted from the request entirely when unset.
interface RegistrantContact {
  First: string; Last: string; Address1: string; City: string;
  State: string; Postal: string; Country: string; Phone: string; Email: string;
  /** Optional — absent unless NAMECHEAP_REGISTRANT_ORGANIZATION is configured. */
  Organization?: string;
}

// The REQUIRED fields only — `Organization` is deliberately excluded so it can
// never join the fail-closed missing-config check.
const REGISTRANT_ENV: Record<Exclude<keyof RegistrantContact, "Organization">, string> = {
  First: "NAMECHEAP_REGISTRANT_FIRST_NAME",
  Last: "NAMECHEAP_REGISTRANT_LAST_NAME",
  Address1: "NAMECHEAP_REGISTRANT_ADDRESS1",
  City: "NAMECHEAP_REGISTRANT_CITY",
  State: "NAMECHEAP_REGISTRANT_STATE_PROVINCE",
  Postal: "NAMECHEAP_REGISTRANT_POSTAL_CODE",
  Country: "NAMECHEAP_REGISTRANT_COUNTRY",
  Phone: "NAMECHEAP_REGISTRANT_PHONE",
  Email: "NAMECHEAP_REGISTRANT_EMAIL",
};

export class RegistrantNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(
      `Domain registrant contact is not configured — refusing to register with placeholder WHOIS data. ` +
        `Set the operator's real, monitored contact in: ${missing.join(", ")}`
    );
    this.name = "RegistrantNotConfiguredError";
  }
}

// Resolve the registrant from env. Throws RegistrantNotConfiguredError when any
// field is missing so the caller fails closed instead of submitting fake WHOIS.
export function getRegistrant(): RegistrantContact {
  const out = {} as RegistrantContact;
  const missing: string[] = [];
  for (const field of Object.keys(REGISTRANT_ENV) as Array<keyof typeof REGISTRANT_ENV>) {
    const v = (process.env[REGISTRANT_ENV[field]] || "").trim();
    if (!v) missing.push(REGISTRANT_ENV[field]);
    else out[field] = v;
  }
  if (missing.length) throw new RegistrantNotConfiguredError(missing);
  // Optional, so it is never part of the missing-field check.
  const org = (process.env.NAMECHEAP_REGISTRANT_ORGANIZATION || "").trim();
  if (org) out.Organization = org;
  return out;
}

// The full Namecheap contact block (registrant/tech/admin/billing/auxbilling are
// all required — Namecheap errors 2010218 without AuxBilling). Whoisguard is
// enabled so the operator contact isn't exposed in public WHOIS while the
// underlying registrant data stays accurate. Throws if the registrant isn't
// configured (fail-closed — see getRegistrant).
export function namecheapCreateParams(domain: string): Record<string, string> {
  const c = getRegistrant();
  const p: Record<string, string> = {
    DomainName: domain,
    Years: "1",
    // WHOIS privacy: mask the operator's contact in public WHOIS/RDAP. The
    // registrant data above remains accurate for ICANN validation.
    AddFreeWhoisguard: "yes",
    WGEnabled: "yes",
  };
  for (const role of ["Registrant", "Tech", "Admin", "Billing", "AuxBilling"]) {
    p[`${role}FirstName`] = c.First;
    p[`${role}LastName`] = c.Last;
    p[`${role}Address1`] = c.Address1;
    p[`${role}City`] = c.City;
    p[`${role}StateProvince`] = c.State;
    p[`${role}PostalCode`] = c.Postal;
    p[`${role}Country`] = c.Country;
    p[`${role}Phone`] = c.Phone;
    p[`${role}EmailAddress`] = c.Email;
    // Only sent when configured — an empty OrganizationName is worse than none
    // (some registries reject a blank org field outright).
    if (c.Organization) p[`${role}OrganizationName`] = c.Organization;
  }
  return p;
}

function defaultDeps(): DomainRegistrationDeps {
  return {
    create: async (domain) => {
      const r = await namecheapRequest("namecheap.domains.create", namecheapCreateParams(domain), {
        timeoutMs: REGISTRAR_CREATE_TIMEOUT_MS,
      });
      return {
        success: !!r.success,
        registered: !!r.registered,
        orderId: r.orderId || null,
        rawSnippet: typeof r.raw === "string" ? r.raw.slice(0, 600) : null,
      };
    },
    isOwnedAtRegistrar: async (domain) => {
      // The oracle that decides whether a payer keeps their money or gets it
      // back, so it demands POSITIVE evidence: an OK envelope (getInfo throws
      // otherwise) AND a result naming this domain AND, when the registrar says
      // so, IsOwner. It used to infer ownership from "the call resolved" alone —
      // and because the client mis-detected Namecheap's error envelope, every
      // call resolved, so every domain looked like ours. A registration that
      // failed at the registrar was finalised as active with no refund.
      const r = await namecheapRequest("namecheap.domains.getInfo", { DomainName: domain });
      if (r.isOwner === false) return false;
      const named = typeof r.domainName === "string" ? r.domainName.toLowerCase() : null;
      if (named && named !== domain.toLowerCase()) return false;
      // No parsed result at all ⇒ can't confirm. Returning false routes the job
      // to reconciliation (never a blind refund), which is the safe direction.
      return named !== null || r.isOwner === true;
    },
    isAvailable: async (domain) => {
      const r = await namecheapRequest("namecheap.domains.check", { DomainList: domain });
      return r.available === true;
    },
    refund: (opts) => refundUsdcToPayer(opts),
    refundDashboard: (userId, amountUsdc, referenceId, reason) => {
      // referenceId (the job id) makes the credit idempotent under retries.
      balanceService.refund(userId, amountUsdc, `domain registration refund: ${reason}`, referenceId);
    },
    writeRegistryRow: defaultWriteRegistryRow,
  };
}

// Insert the `domains` registry row, adapting to the variable prod schema (older
// deployments still carry extra NOT NULL columns). Mirrors the dynamic-column
// approach the synchronous handler used.
function defaultWriteRegistryRow(job: DomainRegistrationRow, orderId: string | null): void {
  const info = db.prepare("PRAGMA table_info(domains)").all() as Array<{ name: string }>;
  const have = new Set(info.map((c) => c.name));
  const cols: string[] = ["id", "domain", "owner", "status", "expires_at", "created_at", "dns_records"];
  const vals: any[] = [randomUUID(), job.domain, job.owner, "active", job.expires_at, new Date().toISOString(), "[]"];
  const tld = job.domain.split(".").slice(1).join(".");
  if (have.has("tld")) { cols.push("tld"); vals.push(tld); }
  if (have.has("registrar")) { cols.push("registrar"); vals.push("namecheap"); }
  if (have.has("registered_at")) { cols.push("registered_at"); vals.push(new Date().toISOString()); }
  if (have.has("payment_signature")) { cols.push("payment_signature"); vals.push(job.payment_signature); }
  if (have.has("registrar_id") && orderId) { cols.push("registrar_id"); vals.push(orderId); }
  const placeholders = vals.map(() => "?").join(", ");
  db.prepare(`INSERT INTO domains (${cols.join(", ")}) VALUES (${placeholders})`).run(...vals);
}

// ─── Job CRUD ───

export function getRegistrationJob(id: string): DomainRegistrationRow | null {
  const row = db.prepare("SELECT * FROM domain_registrations WHERE id = ?").get(id) as DomainRegistrationRow | undefined;
  return row || null;
}

/** True if `domain` already has an in-flight or successful registration job. */
export function hasActiveRegistration(domain: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM domain_registrations WHERE domain = ? AND status IN ('pending','registering','active') LIMIT 1")
    .get(domain);
  return !!row;
}

export interface CreateRegistrationInput {
  domain: string;
  owner: string;
  paymentSignature: string | null;
  paymentChain: "solana" | "base" | null;
  chargedUsdc: number | null;
  expiresAt: string;
}

/**
 * Insert the pending job and kick off the background worker. Returns the row so
 * the handler can respond 202 immediately. Throws `DomainInFlightError` if the
 * partial-unique index rejects a concurrent in-flight registration of the same
 * domain (the caller refunds and tells the payer it's already being registered).
 */
export class DomainInFlightError extends Error {
  constructor(public domain: string) {
    super(`A registration for ${domain} is already in flight or complete`);
    this.name = "DomainInFlightError";
  }
}

export function createRegistrationJob(
  input: CreateRegistrationInput,
  deps: DomainRegistrationDeps = defaultDeps()
): DomainRegistrationRow {
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO domain_registrations
         (id, domain, owner, payment_signature, payment_chain, charged_usdc, expires_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      id,
      input.domain,
      input.owner,
      input.paymentSignature,
      input.paymentChain,
      input.chargedUsdc,
      input.expiresAt,
      // Store created_at as ISO-8601 with a 'T' (not SQLite's space-separated
      // datetime() default) so it sorts lexicographically against the
      // toISOString() cutoff the recovery sweep compares it to. A space (0x20)
      // vs 'T' (0x54) mismatch at index 10 would otherwise make EVERY in-flight
      // job compare "older" than the cutoff and get reconciled while still live.
      new Date().toISOString()
    );
  } catch (e: any) {
    if (String(e?.code || "").startsWith("SQLITE_CONSTRAINT")) {
      throw new DomainInFlightError(input.domain);
    }
    throw e;
  }

  scheduleWorker(id, deps);
  return getRegistrationJob(id)!;
}

// Run the worker out-of-band. A throw out of the worker must never crash the
// process — persist it to the row so the poller sees a definite state (and the
// recovery sweep can still reconcile a row stuck in 'registering').
function scheduleWorker(id: string, deps: DomainRegistrationDeps): void {
  setImmediate(() => {
    runDomainRegistration(id, deps).catch((e) => {
      try {
        db.prepare(
          "UPDATE domain_registrations SET status='registering', error=?, error_code='worker_exception', started_at=COALESCE(started_at, ?) WHERE id=? AND status='pending'"
        ).run(String(e?.message || e), new Date().toISOString(), id);
      } catch {
        /* recovery sweep will reconcile */
      }
    });
  });
}

// ─── Worker ───

const nowIso = () => new Date().toISOString();

export async function runDomainRegistration(
  jobId: string,
  deps: DomainRegistrationDeps = defaultDeps()
): Promise<void> {
  const job = getRegistrationJob(jobId);
  if (!job) throw new Error(`domain_registration ${jobId} not found`);
  // Idempotency: only a fresh 'pending' job advances. A 're-run' of a job the
  // previous process already moved to 'registering' must reconcile instead
  // (handled by the recovery path), never re-call the registrar.
  if (job.status !== "pending") return;

  db.prepare("UPDATE domain_registrations SET status='registering', started_at=? WHERE id=? AND status='pending'")
    .run(nowIso(), jobId);

  let outcome: RegistrarOutcome;
  try {
    outcome = await deps.create(job.domain);
  } catch (createErr: any) {
    // Unknown AND ambiguous: a throw (especially a timeout) can mean the
    // registrar registered the domain just past our client timeout. Confirm
    // ownership if we can (getInfo) — but do NOT let the availability heuristic
    // refund right now: the registrar may still be settling our purchase, and a
    // refund on a transient "available" loses BOTH the registrar cost and the
    // USDC. Defer to the delayed recovery pass, which only refunds once the
    // registrar has had time to settle (allowAvailabilityRefund=false here).
    console.error("[domain-registration] registrar create threw — ambiguous, deferring to recovery", {
      domain: job.domain, jobId, error: createErr?.message || String(createErr),
    });
    await reconcile(jobId, deps, `registrar_call_threw: ${createErr?.message || createErr}`, {
      allowAvailabilityRefund: false,
    });
    return;
  }

  if (outcome.success) {
    finalizeActive(getRegistrationJob(jobId)!, outcome.orderId, deps);
    return;
  }

  // Registrar responded but declined — definitively not registered. Fail + refund.
  const reason = `registrar_declined: registered=${outcome.registered} orderId=${outcome.orderId ?? "null"}`;
  markFailed(jobId, "registrar_declined", reason);
  await issueRefund(getRegistrationJob(jobId)!, deps, reason);
}

// Move a job to 'active': write the registry row, then stamp the job. The
// registry write is best-effort-logged — if it throws after the registrar
// confirmed, the payer still owns the domain, so we keep the job 'active' and
// log for manual reconciliation rather than refunding a domain they own.
function finalizeActive(job: DomainRegistrationRow, orderId: string | null, deps: DomainRegistrationDeps): void {
  try {
    deps.writeRegistryRow(job, orderId);
  } catch (e: any) {
    console.error("[domain-registration] [ORPHAN] registry write failed — payer owns domain at registrar", {
      domain: job.domain, jobId: job.id, orderId, error: e?.message || String(e),
    });
  }
  db.prepare(
    "UPDATE domain_registrations SET status='active', registrar_order_id=COALESCE(?, registrar_order_id), completed_at=? WHERE id=?"
  ).run(orderId, nowIso(), job.id);
}

function markFailed(jobId: string, code: string, message: string): void {
  db.prepare(
    "UPDATE domain_registrations SET status='failed', error=?, error_code=?, completed_at=? WHERE id=?"
  ).run(message, code, nowIso(), jobId);
}

// Issue the auto-refund for a failed job and record the result on the row.
// Idempotent end-to-end: refundUsdcToPayer dedups on the payment signature, and
// re-recording the same refund_id is harmless.
async function issueRefund(job: DomainRegistrationRow, deps: DomainRegistrationDeps, reason: string): Promise<void> {
  // Dashboard-balance payer: there's no on-chain settlement to reverse. Credit
  // the internal balance back instead — the symmetric counterpart to the wallet
  // payer's on-chain refund (the auth middleware debited the reservation up
  // front on the 202; a failed registration returns it here).
  const dashUser = dashboardUserId(job.owner);
  if (dashUser) {
    if (job.charged_usdc == null || job.charged_usdc <= 0) {
      db.prepare("UPDATE domain_registrations SET refund_status='manual_needed' WHERE id=?").run(job.id);
      console.error("[domain-registration] [REFUND NEEDED] dashboard payer with no recorded charge", {
        domain: job.domain, jobId: job.id, owner: job.owner,
      });
      return;
    }
    try {
      deps.refundDashboard(dashUser, job.charged_usdc, job.id, reason);
      db.prepare("UPDATE domain_registrations SET refund_status='sent' WHERE id=?").run(job.id);
    } catch (e: any) {
      db.prepare("UPDATE domain_registrations SET refund_status='failed' WHERE id=?").run(job.id);
      console.error("[domain-registration] dashboard balance refund threw", {
        domain: job.domain, jobId: job.id, error: e?.message || String(e),
      });
    }
    return;
  }

  if (!job.payment_signature || !job.payment_chain || job.charged_usdc == null) {
    // Missing payment context (e.g. legacy payment with no chain) — we can't
    // safely auto-refund. Flag for manual handling; ops sees it via the status.
    db.prepare("UPDATE domain_registrations SET refund_status='manual_needed' WHERE id=?").run(job.id);
    console.error("[domain-registration] [REFUND NEEDED] missing payment context for auto-refund", {
      domain: job.domain, jobId: job.id, signature: job.payment_signature, chain: job.payment_chain, amount: job.charged_usdc,
    });
    return;
  }
  try {
    const result = await deps.refund({
      chain: job.payment_chain,
      payer: job.owner,
      amountUsdc: job.charged_usdc,
      originalPaymentSignature: job.payment_signature,
      reason: `domain registration failed: ${reason}`,
      endpoint: "POST /domains/register",
    });
    db.prepare("UPDATE domain_registrations SET refund_id=?, refund_status=? WHERE id=?")
      .run(result.refundId, result.ok ? "sent" : "failed", job.id);
    if (!result.ok) {
      // refundUsdcToPayer recorded a 'failed' refund row; retryFailedRefunds
      // (boot + interval) will drain it once the treasury is reachable.
      console.error("[domain-registration] auto-refund deferred (treasury issue)", {
        domain: job.domain, jobId: job.id, reason: result.reason,
      });
    }
  } catch (e: any) {
    db.prepare("UPDATE domain_registrations SET refund_status='failed' WHERE id=?").run(job.id);
    console.error("[domain-registration] auto-refund threw", { domain: job.domain, jobId: job.id, error: e?.message || String(e) });
  }
}

/**
 * Resolve a job of unknown outcome by asking the registrar. Used both when the
 * create call throws (inline) and by the delayed recovery sweep. Decision:
 *   owned at registrar      → active (no refund — payer got the domain)
 *   provably not registered → failed + refund   (ONLY when settled — see below)
 *   ambiguous/unreachable   → leave 'registering' (next pass / manual ops)
 *
 * The getInfo ownership oracle is ALWAYS trusted — if it confirms ownership we
 * finalize. The availability heuristic is only allowed to drive a REFUND when
 * `allowAvailabilityRefund` is set, i.e. from the delayed recovery pass (after
 * the stuck-age threshold, once the registrar has had time to settle). Right
 * after an inline create() throw the registrar may still be mid-settlement, so
 * a transient "available" must NOT trigger a refund (that would lose both the
 * registrar cost and the refunded USDC on a registration that actually landed).
 */
async function reconcile(
  jobId: string,
  deps: DomainRegistrationDeps,
  reasonIfFailed: string,
  opts: { allowAvailabilityRefund: boolean }
): Promise<void> {
  const job = getRegistrationJob(jobId);
  if (!job || (job.status !== "registering" && job.status !== "pending")) return;

  let owned = false;
  try {
    owned = await deps.isOwnedAtRegistrar(job.domain);
  } catch {
    owned = false; // getInfo threw — not in our account, OR registrar unreachable.
  }
  if (owned) {
    finalizeActive(job, job.registrar_order_id, deps);
    return;
  }

  // getInfo didn't confirm ownership. The availability heuristic may only refund
  // from the delayed (settled) recovery pass — never inline right after a throw.
  if (opts.allowAvailabilityRefund) {
    let available: boolean | null = null;
    try {
      available = await deps.isAvailable(job.domain);
    } catch {
      available = null; // registrar unreachable — can't decide now.
    }

    if (available === true) {
      // Provably free AND the registrar has settled ⇒ we did not register it ⇒
      // definitive failure ⇒ refund.
      markFailed(jobId, "reconciled_not_registered", reasonIfFailed);
      await issueRefund(getRegistrationJob(jobId)!, deps, reasonIfFailed);
      return;
    }
  }

  // Ambiguous: the registrar may still be settling (inline throw), the domain is
  // taken but getInfo didn't confirm it's ours, or the registrar is unreachable.
  // Never auto-refund on uncertainty (avoids the create-timeout double-loss).
  // Leave the job 'registering' with a breadcrumb; the delayed recovery pass or
  // manual ops resolves it.
  db.prepare(
    "UPDATE domain_registrations SET status='registering', error=?, error_code='reconcile_unresolved', started_at=COALESCE(started_at, ?) WHERE id=?"
  ).run(reasonIfFailed, nowIso(), jobId);
  console.error("[domain-registration] [RECONCILE UNRESOLVED] deferring to delayed recovery pass", {
    domain: job.domain, jobId, allowAvailabilityRefund: opts.allowAvailabilityRefund,
  });
}

// ─── Crash recovery ───
//
// On startup, resolve jobs left dangling by a previous process. We never blind-
// fail/refund (could strand or double-pay a domain the user owns) — every
// recovery path goes through the registrar.
//   - 'pending' jobs (worker never ran): the registrar was never called, so it's
//     safe to simply re-run the worker (fresh attempt; payment already settled).
//   - 'registering' jobs (worker may have called the registrar): reconcile.
const STUCK_AGE_MS = 2 * 60 * 1000;

// Don't let two sweeps overlap (startup + interval, or a slow sweep + the next
// tick): reconcile makes external registrar/refund calls, and overlapping passes
// could double-process the same job.
let recoveryInFlight = false;

export async function recoverStuckDomainRegistrations(
  deps: DomainRegistrationDeps = defaultDeps()
): Promise<void> {
  if (recoveryInFlight) return;
  recoveryInFlight = true;
  try {
    const cutoff = new Date(Date.now() - STUCK_AGE_MS).toISOString();
    const stuck = db
      .prepare(
        "SELECT * FROM domain_registrations WHERE status IN ('pending','registering') AND created_at < ? ORDER BY created_at ASC"
      )
      .all(cutoff) as DomainRegistrationRow[];
    if (stuck.length === 0) return;

    console.log(`[domain-registration] reconciling ${stuck.length} stuck registration(s)`);
    for (const job of stuck) {
      try {
        if (job.status === "pending") {
          // Force the pending-guard to apply: re-run the worker.
          await runDomainRegistration(job.id, deps);
        } else {
          // This is the DELAYED pass: the job has sat past STUCK_AGE_MS, so the
          // registrar has had time to settle and the availability heuristic is
          // now trustworthy enough to drive a refund when getInfo can't confirm
          // ownership.
          await reconcile(job.id, deps, "server_restarted_mid_registration", {
            allowAvailabilityRefund: true,
          });
        }
      } catch (e: any) {
        console.error("[domain-registration] recovery pass failed for job", { jobId: job.id, error: e?.message || String(e) });
      }
    }
  } finally {
    recoveryInFlight = false;
  }
}

// How often the delayed recovery pass runs after boot. A job deferred inline by
// an ambiguous create() throw sits in 'registering' until a sweep reconciles it;
// without a periodic pass it would wait until the next restart. 5 minutes is
// comfortably past STUCK_AGE_MS so a freshly-deferred job settles on the very
// next tick rather than lingering for a redeploy.
const RECOVERY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Recovery is NOT an import side-effect: it makes external registrar/refund
// calls and must not fire merely because a route (or a test) imported this
// module. The server triggers it explicitly once at startup, then on an interval
// so inline-deferred jobs are reconciled without waiting for a redeploy.
export function startDomainRegistrationRecovery(): void {
  setImmediate(() => {
    recoverStuckDomainRegistrations().catch((e) =>
      console.error("[domain-registration] startup recovery error:", e?.message || String(e))
    );
  });
  setInterval(() => {
    recoverStuckDomainRegistrations().catch((e) =>
      console.error("[domain-registration] periodic recovery error:", e?.message || String(e))
    );
  }, RECOVERY_SWEEP_INTERVAL_MS).unref();
}
