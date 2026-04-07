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

export const config = {
  // Server
  port: parseInt(optional("PORT", "3000"), 10),
  nodeEnv: optional("NODE_ENV", "development"),

  // Solana / x402
  solanaRpcUrl: optional("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  treasuryWallet: optional("TREASURY_WALLET", "B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3"),
  treasuryEvmWallet: optional("TREASURY_EVM_WALLET", "0x7fA8aC4b42fd0C97ca983Bc73135EdbeA5bD6ab2"),
  usdcMint: optional("USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),

  // Telnyx
  telnyxApiKey: optional("TELNYX_API_KEY", ""),
  telnyxMessagingProfileId: optional("TELNYX_MESSAGING_PROFILE_ID", ""),
  telnyxWebhookSecret: optional("TELNYX_WEBHOOK_SECRET", ""),
  telnyxVoiceAppId: optional("TELNYX_VOICE_APP_ID", ""),

  // Email / SendGrid
  sendgridApiKey: optional("SENDGRID_API_KEY", ""),
  emailDomain: optional("EMAIL_DOMAIN", "agntos.dev"),
  sendgridWebhookSecret: optional("SENDGRID_WEBHOOK_SECRET", ""),
  mailWorkerUrl: optional("MAIL_WORKER_URL", ""),

  // Domain registrar
  domainRegistrar: optional("DOMAIN_REGISTRAR", "namecheap"),
  namecheapApiKey: optional("NAMECHEAP_API_KEY", ""),
  namecheapApiUser: optional("NAMECHEAP_API_USER", ""),
  cloudflareApiToken: optional("CLOUDFLARE_API_TOKEN", ""),

  // Hetzner Cloud
  hcloudToken: optional("HCLOUD_TOKEN", ""),
  hcloudLocation: optional("HCLOUD_LOCATION", "fsn1"),

  // Hackathon Mode
  hackathonMode: optional("HACKATHON_MODE", "false") === "true",
  hackathonEnd: optional("HACKATHON_END", "2026-02-12T17:00:00Z"),
} as const;
