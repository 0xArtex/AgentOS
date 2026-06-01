/**
 * Self-hosted single-operator mode.
 *
 * When an operator runs their own Palmyr instance there is no paywall (they own
 * the box), so `PALMYR_SELF_HOSTED=1` makes `requireAuth` pass through, skips the
 * IPRoyal-ready check, and lets the residential proxy be optional.
 *
 * This is a full auth + payment bypass, so it is **hard-gated to never engage on
 * the hosted multi-tenant production deployment**: even if the env var leaks into
 * a production config (bad .env, Docker mistake, CI), `NODE_ENV=production`
 * disables it. Local/self-host runs under development (or unset) and is
 * unaffected. A deliberate production self-host can opt in with
 * `PALMYR_SELF_HOSTED_FORCE=1`.
 */
export function isSelfHosted(): boolean {
  if (process.env.PALMYR_SELF_HOSTED !== "1") return false;
  if (process.env.NODE_ENV === "production" && process.env.PALMYR_SELF_HOSTED_FORCE !== "1") return false;
  return true;
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
      "PALMYR_SELF_HOSTED=1 is set but IGNORED (NODE_ENV=production). " +
      "Set PALMYR_SELF_HOSTED_FORCE=1 to override on a deliberate production self-host."
    );
  }
}
