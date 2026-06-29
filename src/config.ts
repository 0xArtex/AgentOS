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
  emailDomain: optional("EMAIL_DOMAIN", "palmyr.ai"),

  // Domain registrar
  domainRegistrar: optional("DOMAIN_REGISTRAR", "namecheap"),
  namecheapApiKey: optional("NAMECHEAP_API_KEY", ""),
  namecheapApiUser: optional("NAMECHEAP_API_USER", ""),
  cloudflareApiToken: optional("CLOUDFLARE_API_TOKEN", ""),

  // Hetzner Cloud
  hcloudToken: optional("HCLOUD_TOKEN", ""),
  hcloudLocation: optional("HCLOUD_LOCATION", "fsn1"),
} as const;
