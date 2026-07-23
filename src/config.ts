import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

// Treasury addresses receive every agent's USDC payment, so a missing env var
// must NEVER silently fall back to a hardcoded (and now stale) address — that
// would route all funds to a wallet the operator no longer controls and break
// refunds. In real production (NODE_ENV=production, not self-hosted) we refuse
// to boot when the env var is absent; dev/test/self-hosted keep a labeled
// throwaway default so the suite and local runs work without secrets.
const PROD_REQUIRES_SECRETS =
  process.env.NODE_ENV === "production" &&
  !(process.env.PALMYR_SELF_HOSTED === "1" || process.env.PALMYR_SELF_HOSTED === "true");

function requiredInProd(key: string, devFallback: string): string {
  const val = process.env[key];
  if (val) return val;
  if (PROD_REQUIRES_SECRETS) {
    throw new Error(
      `Refusing to boot: ${key} is unset in production. Set it explicitly — there is no hardcoded fallback for treasury addresses (a stale default would silently misroute every payment and break refunds).`,
    );
  }
  return devFallback;
}

const EMAIL_DOMAIN = optional("EMAIL_DOMAIN", "palmyr.ai");

// Disposable temp inboxes are minted on THESE domains (comma-separated), never
// on EMAIL_DOMAIN. Keeping "disposable" traffic off the apex protects it (and
// the owned $2 inboxes) from disposable-email blocklists — the apex getting
// listed would reject every {name}@palmyr.ai address at signup. Treat pool
// domains as rotatable, sacrificial inventory. Falls back to [EMAIL_DOMAIN] so
// dev / test / self-hosted keep working with no extra env.
const TEMP_EMAIL_DOMAINS = (process.env.TEMP_EMAIL_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export const config = {
  // Server
  port: parseInt(optional("PORT", "3000"), 10),
  nodeEnv: optional("NODE_ENV", "development"),

  // Solana / x402
  solanaRpcUrl: optional("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  treasuryWallet: requiredInProd("TREASURY_WALLET", "B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3"),
  treasuryEvmWallet: requiredInProd("TREASURY_EVM_WALLET", "0x7fA8aC4b42fd0C97ca983Bc73135EdbeA5bD6ab2"),
  usdcMint: optional("USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),

  // Telnyx
  telnyxApiKey: optional("TELNYX_API_KEY", ""),
  telnyxMessagingProfileId: optional("TELNYX_MESSAGING_PROFILE_ID", ""),
  telnyxWebhookSecret: optional("TELNYX_WEBHOOK_SECRET", ""),
  telnyxVoiceAppId: optional("TELNYX_VOICE_APP_ID", ""),

  // Email
  emailDomain: EMAIL_DOMAIN,
  // Disposable temp-inbox pool domains (see TEMP_EMAIL_DOMAINS above).
  tempEmailDomains: TEMP_EMAIL_DOMAINS.length ? TEMP_EMAIL_DOMAINS : [EMAIL_DOMAIN],

  // Domain registrar
  domainRegistrar: optional("DOMAIN_REGISTRAR", "namecheap"),
  namecheapApiKey: optional("NAMECHEAP_API_KEY", ""),
  namecheapApiUser: optional("NAMECHEAP_API_USER", ""),
  cloudflareApiToken: optional("CLOUDFLARE_API_TOKEN", ""),

  // Hetzner Cloud
  hcloudToken: optional("HCLOUD_TOKEN", ""),
  hcloudLocation: optional("HCLOUD_LOCATION", "fsn1"),

  // Laso Finance prepaid cards (feature-gated on LASO_PAYER_EVM_PRIVATE_KEY,
  // which is read lazily in services/laso.ts like the treasury keys).
  lasoApiBase: optional("LASO_API_BASE", "https://laso.finance"),
  lasoCardFeePct: parseFloat(optional("LASO_CARD_FEE_PCT", "0.03")),
  lasoCardFeeMinUsdc: parseFloat(optional("LASO_CARD_FEE_MIN_USDC", "0.50")),
  lasoMinCardUsd: parseFloat(optional("LASO_MIN_CARD_USD", "5")),
  lasoMaxCardUsd: parseFloat(optional("LASO_MAX_CARD_USD", "1000")),
  lasoDailyMaxUsd: parseFloat(optional("LASO_DAILY_MAX_USD", "2000")),
  lasoAgentDailyMaxUsd: parseFloat(optional("LASO_AGENT_DAILY_MAX_USD", "500")),
  // Laso's confirmed per-wallet issuance limit is 6 cards / $6k daily
  // (2026-07-09). Each agent is its own wallet upstream, so we mirror the
  // count here; the dollar side is already bounded far below $6k by
  // LASO_AGENT_DAILY_MAX_USD.
  lasoAgentDailyMaxCards: parseInt(optional("LASO_AGENT_DAILY_MAX_CARDS", "6"), 10),
} as const;

/**
 * True if `domain` is a Palmyr-operated email domain — the default apex or any
 * temp-inbox pool domain. Used to protect SHARED pool domains from teardown:
 * the inbox-delete route deregisters a Mailgun domain once its last inbox is
 * gone, which must never fire for a pool domain (it would kill inbound for
 * every other agent still leasing a temp inbox on it).
 */
export function isSystemEmailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  return d === config.emailDomain.toLowerCase()
    || config.tempEmailDomains.some((p) => p.toLowerCase() === d);
}
