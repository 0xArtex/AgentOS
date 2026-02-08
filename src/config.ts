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
  treasuryWallet: required("TREASURY_WALLET"),
  /** USDC mint on Solana mainnet */
  usdcMint: optional("USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),

  // Twilio
  twilioAccountSid: optional("TWILIO_ACCOUNT_SID", ""),
  twilioAuthToken: optional("TWILIO_AUTH_TOKEN", ""),
  twilioPhoneNumber: optional("TWILIO_PHONE_NUMBER", ""),
  twilioWebhookSecret: optional("TWILIO_WEBHOOK_SECRET", ""),

  // Email / SendGrid
  sendgridApiKey: optional("SENDGRID_API_KEY", ""),
  emailDomain: optional("EMAIL_DOMAIN", "mail.agentos.dev"),
  sendgridWebhookSecret: optional("SENDGRID_WEBHOOK_SECRET", ""),

  // Domain registrar ("namecheap" or "cloudflare")
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
