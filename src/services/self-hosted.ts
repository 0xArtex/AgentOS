/**
 * Self-hosted single-operator mode.
 *
 * When an operator runs their own Palmyr instance there is no paywall (they own
 * the box), so `PALMYR_SELF_HOSTED=1` makes `requireAuth` pass through, skips the
 * IPRoyal-ready check, and lets the residential proxy be optional.
 *
 * This is a full auth + payment bypass, so it is **hard-gated to never engage on
 * the hosted multi-tenant production deployment**. The original gate inferred
 * "safe to bypass" from the mere *absence* of `NODE_ENV=production` — fragile,
 * because an unset/mistyped NODE_ENV on a prod box (while PALMYR_SELF_HOSTED=1
 * leaks in) silently disabled every paywall. The gate now:
 *
 *   1. requires the explicit positive opt-in `PALMYR_SELF_HOSTED=1`, AND
 *   2. hard-disables whenever ANY positive multi-tenant / hosted-production
 *      signal is present (NODE_ENV=production, PALMYR_MULTI_TENANT=1, or a
 *      configured treasury wallet — a hosted deploy always sets one), AND
 *   3. requires a *positive* non-production marker (NODE_ENV development/test);
 *      an ambiguous/unset environment fails closed.
 *
 * A deliberate production self-host opts in unambiguously with
 * `PALMYR_SELF_HOSTED_FORCE=1`, which overrides the prod signals above.
 */
export function isSelfHosted(): boolean {
  // (1) Explicit positive opt-in is mandatory.
  if (process.env.PALMYR_SELF_HOSTED !== "1") return false;

  // Deliberate production self-host: unambiguous, intentional override. Checked
  // first so an operator who truly wants the bypass on a prod-looking box can
  // still get it — but only by setting this on purpose.
  if (process.env.PALMYR_SELF_HOSTED_FORCE === "1") return true;

  // (2) Hard kill-switches: any positive multi-tenant / hosted-production signal
  // disables the total auth+payment bypass even if NODE_ENV is unset or
  // mistyped. A hosted deployment configures a treasury wallet (config.ts even
  // refuses to boot in prod without one), so its presence is a reliable tell.
  const multiTenantSignal =
    process.env.NODE_ENV === "production" ||
    process.env.PALMYR_MULTI_TENANT === "1" ||
    !!process.env.TREASURY_WALLET ||
    !!process.env.TREASURY_EVM_WALLET;
  if (multiTenantSignal) return false;

  // (3) Require a POSITIVE non-production marker — never infer "safe to bypass"
  // from the absence of NODE_ENV. Anything ambiguous fails closed.
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

/** Stable operator identity for self-hosted mode (used as the owning wallet on
 * ownership-scoped routes). Defaults to a sentinel; an operator running a real
 * single-user instance should set PALMYR_SELF_HOSTED_WALLET to their address so
 * account ownership/transfer works and isn't shared under a generic identifier. */
export function selfHostedIdentity(): string {
  return process.env.PALMYR_SELF_HOSTED_WALLET || "self-hosted";
}

/** One-time boot banner so an accidental activation is impossible to miss. */
export function warnIfSelfHosted(log: (m: string) => void = console.warn): void {
  if (process.env.PALMYR_SELF_HOSTED !== "1") return;
  if (isSelfHosted()) {
    log(
      "⚠️  PALMYR_SELF_HOSTED=1 — auth + x402 payment are BYPASSED for ALL requests. " +
      "Only use this on a single-operator instance you own; NEVER on a multi-tenant/hosted deployment."
    );
  } else {
    log(
      "PALMYR_SELF_HOSTED=1 is set but IGNORED — a multi-tenant/production signal is " +
      "present (NODE_ENV=production, PALMYR_MULTI_TENANT=1, or a configured treasury " +
      "wallet), or NODE_ENV is not an explicit development/test value. " +
      "Set NODE_ENV=development for a local self-host, or PALMYR_SELF_HOSTED_FORCE=1 " +
      "to override on a deliberate production self-host."
    );
  }
}
