import crypto from "crypto";
import { db } from "../db";

// -------------------- Types --------------------

// Source discriminator for the i402 providers table. Values are stable enum
// markers, not brand names — 'agentos' is preserved across the Palmyr rebrand
// to match the existing DB CHECK constraint (src/db.ts) and avoid a migration.
export type I402ProviderSource =
  | "agentos"
  | "agentic_market"
  | "external"
  | "clawhub"
  | "agent_composed";

export type I402AuthScheme =
  | "internal"
  | "x402-solana"
  | "x402-base"
  | "api_key"
  | "wallet_sig";

export type I402Quality = "fast" | "cheap" | "best";

export interface I402Provider {
  id: string;
  source: I402ProviderSource;
  capability: string;
  name: string;
  description?: string;
  endpoint: string;
  method: string;
  authScheme: I402AuthScheme;
  inputSchema: unknown;
  outputSchema: unknown;
  costPerCallUsdc: number;
  p50LatencyMs?: number;
  p99LatencyMs?: number;
  successRate: number;
  reputationScore: number;
  enabled: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityClass {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  isCompound?: boolean;
}

interface ProviderRow {
  id: string;
  source: I402ProviderSource;
  capability: string;
  name: string;
  description: string | null;
  endpoint: string;
  method: string;
  auth_scheme: I402AuthScheme;
  input_schema: string;
  output_schema: string;
  cost_per_call_usdc: number;
  p50_latency_ms: number | null;
  p99_latency_ms: number | null;
  success_rate: number;
  reputation_score: number;
  enabled: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProvider(row: ProviderRow): I402Provider {
  return {
    id: row.id,
    source: row.source,
    capability: row.capability,
    name: row.name,
    description: row.description ?? undefined,
    endpoint: row.endpoint,
    method: row.method,
    authScheme: row.auth_scheme,
    inputSchema: JSON.parse(row.input_schema),
    outputSchema: JSON.parse(row.output_schema),
    costPerCallUsdc: row.cost_per_call_usdc,
    p50LatencyMs: row.p50_latency_ms ?? undefined,
    p99LatencyMs: row.p99_latency_ms ?? undefined,
    successRate: row.success_rate,
    reputationScore: row.reputation_score,
    enabled: row.enabled === 1,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// -------------------- Canonical capability classes (v0.1) --------------------

// Capability classes are the canonical action taxonomy the planner chooses from.
// Every capability here maps to one or more x402-native Palmyr endpoints.
// Non-x402 capabilities (web_search, summarize, image_gen, video_gen, tts, stt,
// embed, web_scrape) are intentionally absent until Agentic Market lands.
export const CAPABILITY_CLASSES: Record<string, CapabilityClass> = {
  // ── Phone / SMS ──
  provision_phone: {
    name: "provision_phone",
    description: "Provision a new phone number in a specified country. Returns phone_number_id + E.164 number.",
    inputSchema: { country: "string (ISO-2)", areaCode: "string?" },
    outputSchema: { id: "string (phone_number_id)", phoneNumber: "string (E.164)", country: "string", owner: "string", provisionedAt: "iso8601", active: "boolean" },
  },
  release_phone: {
    name: "release_phone",
    description: "Release (deactivate) a provisioned phone number.",
    inputSchema: { phone_number_id: "string" },
    outputSchema: { success: "boolean", message: "string" },
  },
  list_phones: {
    name: "list_phones",
    description: "List phone numbers owned by the calling wallet.",
    inputSchema: {},
    outputSchema: { numbers: "object[] (each: { id, phoneNumber, country, owner, provisionedAt, active })" },
  },
  send_sms: {
    name: "send_sms",
    description: "Send an SMS from an owned phone number.",
    inputSchema: { phone_number_id: "string (path)", to: "string (E.164)", body: "string" },
    outputSchema: { id: "string (message_id)", phoneNumberId: "string", direction: "string (outbound)", from: "string (E.164)", to: "string (E.164)", body: "string", timestamp: "iso8601" },
  },
  read_sms: {
    name: "read_sms",
    description: "Retrieve SMS messages received on an owned phone number.",
    inputSchema: { phone_number_id: "string (path)", limit: "number?", since: "iso8601?" },
    outputSchema: { messages: "object[] (each: { id, phoneNumberId, direction, from, to, body, timestamp })" },
  },

  // ── Voice ──
  start_voice_call: {
    name: "start_voice_call",
    description: "Place an outbound voice call. If you also pass `tts` (or `audioUrl`), it will play automatically when the recipient answers — prefer this over chaining a separate voice_speak step. Use voice_speak only for mid-call additional speech after the answer event.",
    inputSchema: { phone_number_id: "string (path)", to: "string (E.164)", tts: "string? (text spoken on answer via TTS — single-shot)", ttsVoice: "string? (default 'female')", audioUrl: "string? (audio clip URL played on answer instead of TTS)", record: "boolean? (start recording on answer)", timeoutSecs: "number? (ring timeout)" },
    outputSchema: { id: "string", callControlId: "string", callLegId: "string", phoneNumberId: "string", from: "string (E.164)", to: "string (E.164)", direction: "string", status: "string", startedAt: "iso8601", message: "string", hint: "string" },
  },
  list_calls: {
    name: "list_calls",
    description: "List call history for an owned phone number.",
    inputSchema: { phone_number_id: "string (path)" },
    outputSchema: { calls: "object[] (each: { id, callControlId, callLegId, phoneNumberId, from, to, direction, status, startedAt })", count: "number" },
  },
  get_call_details: {
    name: "get_call_details",
    description: "Retrieve call details by callControlId. Object is returned at the top level (not wrapped).",
    inputSchema: { call_control_id: "string (path)" },
    outputSchema: { id: "string", callControlId: "string", callLegId: "string", phoneNumberId: "string", from: "string", to: "string", direction: "string", status: "string", startedAt: "iso8601", answeredAt: "iso8601?", endedAt: "iso8601?", duration: "number?", recordingUrl: "string?" },
  },
  voice_speak: {
    name: "voice_speak",
    description: "Speak text into an ALREADY-ANSWERED call. DO NOT use for the initial message of a fresh call — pass `tts` to start_voice_call instead, which auto-speaks on answer. This capability 422s on un-answered calls. Only use it for ADDITIONAL speech after the call is established.",
    inputSchema: { call_control_id: "string (path)", text: "string", voice: "string?", language: "string?" },
    outputSchema: { success: "boolean", message: "string" },
  },
  voice_play: {
    name: "voice_play",
    description: "Play an audio clip into an active call.",
    inputSchema: { call_control_id: "string (path)", audio_url: "string" },
    outputSchema: { success: "boolean", message: "string" },
  },
  voice_dtmf: {
    name: "voice_dtmf",
    description: "Send a sequence of DTMF tones into an active call.",
    inputSchema: { call_control_id: "string (path)", digits: "string" },
    outputSchema: { success: "boolean", message: "string" },
  },
  voice_gather: {
    name: "voice_gather",
    description: "Gather DTMF input from the caller with a prompt. The HTTP response only acknowledges; the gathered digits arrive later via webhook (poll get_call_details for the result).",
    inputSchema: { call_control_id: "string (path)", prompt: "string", timeout_s: "number?", max_digits: "number?" },
    outputSchema: { success: "boolean", message: "string" },
  },
  voice_record_start: {
    name: "voice_record_start",
    description: "Start recording an active call. The recording URL arrives later via webhook (poll get_call_details for recordingUrl).",
    inputSchema: { call_control_id: "string (path)" },
    outputSchema: { success: "boolean", message: "string" },
  },
  voice_record_stop: {
    name: "voice_record_stop",
    description: "Stop recording an active call. The final recording URL arrives later via webhook (poll get_call_details for recordingUrl).",
    inputSchema: { call_control_id: "string (path)" },
    outputSchema: { success: "boolean", message: "string" },
  },
  voice_hangup: {
    name: "voice_hangup",
    description: "Disconnect an active call.",
    inputSchema: { call_control_id: "string (path)" },
    outputSchema: { success: "boolean", message: "string" },
  },
  voice_answer: {
    name: "voice_answer",
    description: "Answer an incoming call.",
    inputSchema: { call_control_id: "string (path)" },
    outputSchema: { success: "boolean", message: "string" },
  },
  voice_transfer: {
    name: "voice_transfer",
    description: "Transfer an active call to another number.",
    inputSchema: { call_control_id: "string (path)", to: "string (E.164)" },
    outputSchema: { success: "boolean", message: "string" },
  },

  // ── Email ──
  provision_email_inbox: {
    name: "provision_email_inbox",
    description: "Provision a new E2E-encrypted email inbox keyed to the caller's wallet. Defaults to {name}@palmyr.ai. To provision on a domain the wallet just registered (e.g. hello@stealthkicks.xyz), pass `domain` chained from register_domain's output — the route validates ownership and auto-sets MX/SPF/_mailchannels DNS records on that domain via Namecheap.",
    inputSchema: {
      name: "string (local-part)",
      domain: "string? (fqdn — defaults to palmyr.ai; must be a Namecheap domain registered to this wallet, e.g. $STEPS.s1.output.domain)",
      walletAddress: "string? (Solana pubkey — defaults to caller's wallet; only set when encrypting for a third party)",
    },
    outputSchema: { inbox: "object ({ id, address, walletAddress })", dnsApplied: "boolean? (true when DNS records were successfully written to a custom domain)" },
  },
  list_inboxes: {
    name: "list_inboxes",
    description: "List email inboxes owned by the calling wallet.",
    inputSchema: {},
    outputSchema: { inboxes: "object[] (each: { id, address, walletAddress })" },
  },
  send_email: {
    name: "send_email",
    description: "Send an email from an owned inbox.",
    inputSchema: { inbox_id: "string (path)", to: "string|string[]", subject: "string", body: "string", html: "string?" },
    outputSchema: { message: "object ({ id, to, subject, sentAt })" },
  },
  read_email: {
    name: "read_email",
    description: "List / read messages in an owned inbox.",
    inputSchema: { inbox_id: "string (path)", limit: "number?", since: "iso8601?" },
    outputSchema: { inbox: "string (address)", messages: "object[] (each: { id, direction, from, to, subject, body, html?, timestamp, encrypted?, e2e?, decryptionNote? })", totalMessages: "number", paidBy: "string (wallet)", e2eEnabled: "boolean", security: "string" },
  },
  list_email_threads: {
    name: "list_email_threads",
    description: "List email conversation threads in an owned inbox.",
    inputSchema: { inbox_id: "string (path)" },
    outputSchema: { threads: "object[]", totalThreads: "number" },
  },
  read_email_thread: {
    name: "read_email_thread",
    description: "Get all messages in an email thread.",
    inputSchema: { thread_id: "string (path)" },
    outputSchema: { thread: "object", messages: "object[]", totalMessages: "number" },
  },

  // ── Domain ──
  register_domain: {
    name: "register_domain",
    description: "Register a new domain via the registrar. Pricing is dynamic per TLD.",
    inputSchema: { domain: "string (fqdn)", years: "number? (default 1)" },
    outputSchema: { domain: "string", status: "string", expiresAt: "iso8601", dnsManagement: "boolean", cost: "number" },
  },
  list_domains: {
    name: "list_domains",
    description: "List domains owned by the calling wallet.",
    inputSchema: {},
    outputSchema: { owner: "string", count: "number", domains: "object[] (each: { domain, status, registrar_id, expires_at, created_at })" },
  },
  get_domain: {
    name: "get_domain",
    description: "Get the status + metadata for a single owned domain. Fields are returned flat at the top level (not wrapped).",
    inputSchema: { domain: "string (path, fqdn)" },
    outputSchema: { domain: "string (fqdn)", status: "string", expiresAt: "iso8601", createdAt: "iso8601", dnsRecords: "object[]" },
  },
  dns_manage: {
    name: "dns_manage",
    description: "Read or write DNS records on an owned domain. GET returns the records array directly at the top level; POST returns { message, records }.",
    inputSchema: { domain: "string (path)", records: "object[]? (write when present)" },
    outputSchema: { records: "object[]", message: "string? (write only)" },
  },
  transfer_domain_ownership: {
    name: "transfer_domain_ownership",
    description: "Transfer a domain's ownership to a new wallet address (Solana or EVM).",
    inputSchema: { domain: "string (path, fqdn)", new_owner: "string (wallet address)" },
    outputSchema: { message: "string", domain: "string", previous_owner: "string", new_owner: "string" },
  },
  transfer_domain_out: {
    name: "transfer_domain_out",
    description: "Initiate an IANA registrar transfer for an owned domain.",
    inputSchema: { domain: "string (path, fqdn)" },
    outputSchema: { message: "string", authCode: "string", instructions: "string" },
  },

  // ── Compute / VPS ──
  create_ssh_key: {
    name: "create_ssh_key",
    description: "Register an SSH public key on the cloud account. Caller supplies the publicKey; the server does not generate a keypair.",
    inputSchema: { name: "string?", publicKey: "string (OpenSSH public key)" },
    outputSchema: { id: "number (hcloud ssh_key id)", name: "string", message: "string" },
  },
  list_ssh_keys: {
    name: "list_ssh_keys",
    description: "List SSH keys owned by the wallet.",
    inputSchema: {},
    outputSchema: { sshKeys: "object[] (each: { id, name, fingerprint })" },
  },
  delete_ssh_key: {
    name: "delete_ssh_key",
    description: "Delete an SSH key.",
    inputSchema: { ssh_key_id: "string (path)" },
    outputSchema: { deleted: "boolean", id: "string" },
  },
  deploy_vps: {
    name: "deploy_vps",
    description: "Provision a new cloud VPS with cloud-init + SSH key. Returns server_id + public IPs.",
    inputSchema: {
      name: "string",
      serverType: "string (current Hetzner shared types — typically cax11/cpx11 (smallest) up to cax41/cpx51 (largest). The active list is fetched live from Hetzner; pick cax* for ARM (cheapest, EU only) or cpx* for x86 (global). The route 400s with the live valid list if you pass an unknown/deprecated type.)",
      image: "string? (default ubuntu-24.04)",
      sshKeyIds: "number[]?",
      installOpenClaw: "boolean? (default true)",
    },
    outputSchema: { id: "string (server_id)", name: "string", serverType: "string", image: "string", status: "string", ipv4: "string|null", ipv6: "string|null", owner: "string", priceMonthly: "number", createdAt: "iso8601", rootPassword: "string|null", message: "string", note: "string" },
  },
  list_vps: {
    name: "list_vps",
    description: "List VPS instances owned by the wallet.",
    inputSchema: {},
    outputSchema: { servers: "object[]", count: "number" },
  },
  get_vps: {
    name: "get_vps",
    description: "Get details for a single VPS. Fields are returned flat at the top level (not wrapped).",
    inputSchema: { server_id: "string (path)" },
    outputSchema: { id: "string", name: "string", serverType: "string", image: "string", status: "string", ipv4: "string|null", ipv6: "string|null", owner: "string", priceMonthly: "number", createdAt: "iso8601", rootPassword: "string|null" },
  },
  vps_action: {
    name: "vps_action",
    description: "Execute a lifecycle action on a VPS: reboot / poweron / poweroff / rebuild / reset.",
    inputSchema: {
      server_id: "string (path)",
      action: "string (reboot|poweron|poweroff|rebuild|reset)",
    },
    outputSchema: { action: "string", serverId: "string", status: "string", message: "string" },
  },
  vps_resize: {
    name: "vps_resize",
    description: "Resize a VPS to a new server-type tier.",
    inputSchema: { server_id: "string (path)", serverType: "string" },
    outputSchema: { action: "string", serverId: "string", newType: "string", status: "string", message: "string" },
  },
  vps_delete: {
    name: "vps_delete",
    description: "Terminate a VPS.",
    inputSchema: { server_id: "string (path)" },
    outputSchema: { deleted: "boolean", id: "string", message: "string" },
  },
  install_skill: {
    name: "install_skill",
    description: "Install a single agent skill on a VPS.",
    inputSchema: { server_id: "string (path)", skill_id: "string" },
    outputSchema: { success: "boolean", skill: "string", installed: "boolean", message: "string" },
  },
  install_skills_bulk: {
    name: "install_skills_bulk",
    description: "Install a batch of skills on a VPS.",
    inputSchema: { server_id: "string (path)", skill_ids: "string[]" },
    outputSchema: { success: "boolean", installed: "number (count)", failed: "number (count)", total: "number", results: "object[] (each: { skill, status, error? })" },
  },
  remove_skill: {
    name: "remove_skill",
    description: "Remove an installed skill from a VPS.",
    inputSchema: { server_id: "string (path)", skill_id: "string" },
    outputSchema: { success: "boolean", skill: "string", message: "string" },
  },
  configure_openclaw: {
    name: "configure_openclaw",
    description: "Configure the OpenClaw agent runtime on a VPS.",
    inputSchema: { server_id: "string (path)", config: "object" },
    outputSchema: { success: "boolean", running: "boolean", message: "string", config: "object ({ model, channel, gateway_port })" },
  },
  configure_vps_wallet: {
    name: "configure_vps_wallet",
    description: "Wire a wallet into the agent runtime on a VPS (for signing x402 from within the VPS).",
    inputSchema: { server_id: "string (path)", wallet_config: "object" },
    outputSchema: { success: "boolean", message: "string" },
  },

  // ── Social: Twitter / X ──
  // All social ops return an OpResult envelope: { success, data?, error?, error_code? }.
  // Chain via $STEPS.sN.output.data.FIELD (NOT $STEPS.sN.output.FIELD).
  //
  // Sessions are managed entirely by the client-side executor: it resolves
  // the account by handle, ensures a fresh session via the local vault, and
  // injects cookies/credentials at HTTP time. Login is NOT a planner step,
  // and cookies/login/password NEVER appear in step inputs.
  twitter_post: {
    name: "twitter_post",
    description: "Post a tweet from an owned X account. Optional community_id scopes the post to that X community.",
    inputSchema: {
      handle: "string (no @)",
      text: "string",
      community_id: "string? (numeric X community ID, 15-30 digits, e.g. '1493446837214187523')",
    },
    outputSchema: { success: "boolean", data: "object ({ tweet_id: string, tweet_url: string })" },
  },
  twitter_post_thread: {
    name: "twitter_post_thread",
    description: "Post a chain of 2-25 tweets as a native X thread from one composed session. Optional community_id scopes the thread to that X community.",
    inputSchema: {
      handle: "string (no @)",
      texts: "array of strings (each ≤280 chars, length 1-25)",
      community_id: "string? (numeric X community ID, 15-30 digits)",
    },
    outputSchema: { success: "boolean", data: "object ({ tweet_ids: string[], tweet_urls: string[] })" },
  },
  twitter_post_media: {
    name: "twitter_post_media",
    description: "Post a tweet with 1-4 images OR 1 video attached. Use twitter_post for text-only. Optional community_id scopes to a community.",
    inputSchema: {
      handle: "string (no @)",
      text: "string (≤280 chars)",
      media: "array of {image_url|image_base64|video_url|video_base64} — 1-4 images OR exactly 1 video, never mix",
      community_id: "string? (numeric X community ID, 15-30 digits)",
    },
    outputSchema: { success: "boolean", data: "object ({ tweet_id: string, tweet_url: string })" },
  },
  twitter_reply: {
    name: "twitter_reply",
    description: "Reply to a tweet.",
    inputSchema: { handle: "string (no @)", tweet_url: "string", text: "string" },
    outputSchema: { success: "boolean", data: "object ({ tweet_id?: string, tweet_url?: string })" },
  },
  twitter_like: {
    name: "twitter_like",
    description: "Like a tweet.",
    inputSchema: { handle: "string (no @)", tweet_url: "string" },
    outputSchema: { success: "boolean", data: "object? ({ already_liked?: boolean })" },
  },
  twitter_retweet: {
    name: "twitter_retweet",
    description: "Retweet.",
    inputSchema: { handle: "string (no @)", tweet_url: "string" },
    outputSchema: { success: "boolean", data: "object? ({ already_retweeted?: boolean })" },
  },
  twitter_follow: {
    name: "twitter_follow",
    description: "Follow a user on X.",
    inputSchema: { handle: "string (no @)", target_user: "string (handle)" },
    outputSchema: { success: "boolean", data: "object? ({ already_following?: boolean })" },
  },
  twitter_unfollow: {
    name: "twitter_unfollow",
    description: "Unfollow a user on X.",
    inputSchema: { handle: "string (no @)", target_user: "string (handle)" },
    outputSchema: { success: "boolean", data: "object? ({ already_not_following?: boolean })" },
  },
  twitter_delete_post: {
    name: "twitter_delete_post",
    description: "Delete an own tweet.",
    inputSchema: { handle: "string (no @)", tweet_url: "string" },
    outputSchema: { success: "boolean" },
  },
  twitter_update_profile: {
    name: "twitter_update_profile",
    description: "Update profile fields (bio, display name, location, website).",
    inputSchema: { handle: "string (no @)", bio: "string?", display_name: "string?", location: "string?", website: "string?" },
    outputSchema: { success: "boolean", data: "object (echoes fields actually updated: { bio?, display_name?, location?, website? })" },
  },
  twitter_update_avatar: {
    name: "twitter_update_avatar",
    description: "Update profile picture.",
    inputSchema: { handle: "string (no @)", image_base64: "string?", image_url: "string?" },
    outputSchema: { success: "boolean", data: "object ({ kind: 'avatar', observed_posts: string[] })" },
  },
  twitter_update_banner: {
    name: "twitter_update_banner",
    description: "Update X profile banner image.",
    inputSchema: { handle: "string (no @)", image_base64: "string?", image_url: "string?" },
    outputSchema: { success: "boolean", data: "object ({ kind: 'banner', observed_posts: string[] })" },
  },
  twitter_change_username: {
    name: "twitter_change_username",
    description: "Change the Twitter handle. The executor injects the vault password automatically.",
    inputSchema: { handle: "string (no @)", new_username: "string" },
    outputSchema: { success: "boolean", data: "object ({ new_username: string })" },
  },
  twitter_buy_account: {
    name: "twitter_buy_account",
    description: "Buy a warmed X account from the Palmyr pool.",
    inputSchema: { country: "string?", age_category: "string?" },
    outputSchema: { success: "boolean", account: "object ({ id, platform, username, country, age_category, proxy_session_id, credentials: object, cookies: object[] })" },
  },
  twitter_list_my_tweets: {
    name: "twitter_list_my_tweets",
    description: "List the agent's own tweets in oldest-first order. Use this before bulk-deleting or referencing specific tweets by index.",
    inputSchema: { handle: "string (no @)", limit: "number? (default 20, max 50)" },
    outputSchema: { success: "boolean", data: "object ({ tweets: [{ tweet_url, tweet_id, posted_at, text }] })" },
  },

  // ── Social: TikTok ──
  // Same model as Twitter: sessions are client-managed. Login is not a
  // planner step; cookies/login/password never appear in step inputs.
  tiktok_post: {
    name: "tiktok_post",
    description: "Post a video to TikTok.",
    inputSchema: { handle: "string (no @)", caption: "string", video_base64: "string?", video_url: "string?", privacy: "number?", allow_comments: "boolean?", allow_duet: "boolean?", allow_stitch: "boolean?" },
    outputSchema: { success: "boolean", data: "object ({ video_id: string, video_url: string })" },
  },
  tiktok_follow: {
    name: "tiktok_follow",
    description: "Follow a TikTok user.",
    inputSchema: { handle: "string (no @)", target_user: "string" },
    outputSchema: { success: "boolean", data: "object ({ followed: boolean })" },
  },
  tiktok_like: {
    name: "tiktok_like",
    description: "Like a TikTok video.",
    inputSchema: { handle: "string (no @)", video_url: "string" },
    outputSchema: { success: "boolean", data: "object ({ liked: boolean })" },
  },
  tiktok_delete_post: {
    name: "tiktok_delete_post",
    description: "Delete an own TikTok video.",
    inputSchema: { handle: "string (no @)", video_url: "string" },
    outputSchema: { success: "boolean", data: "object ({ deleted: boolean })" },
  },
  tiktok_update_profile: {
    name: "tiktok_update_profile",
    description: "Update TikTok profile (bio, display name).",
    inputSchema: { handle: "string (no @)", bio: "string?", display_name: "string?" },
    outputSchema: { success: "boolean", data: "object ({ updated: string[] })" },
  },
  tiktok_update_avatar: {
    name: "tiktok_update_avatar",
    description: "Update TikTok avatar.",
    inputSchema: { handle: "string (no @)", image_base64: "string?", image_url: "string?" },
    outputSchema: { success: "boolean", data: "object ({ updated: boolean })" },
  },

  // ── Compound capabilities ──
  launch_product: {
    name: "launch_product",
    description: "End-to-end product launch: domain, landing page on a VPS, email inbox, social presence, and launch posts.",
    isCompound: true,
    inputSchema: { niche: "string", target_audience: "string?", region: "string?" },
    outputSchema: { artifacts: "object[]" },
  },
  grow_audience: {
    name: "grow_audience",
    description: "Publish coordinated content across owned social accounts.",
    isCompound: true,
    inputSchema: { topic: "string", platforms: "string[]", cadence: "string?" },
    outputSchema: { posts: "object[]" },
  },

  // ── Social account provisioning (legacy-named, platform-dispatch) ──
  social_account_provision: {
    name: "social_account_provision",
    description: "Provision a pre-warmed social account from the pool, transferred to the caller's wallet.",
    inputSchema: { platform: "string (x|tiktok|reddit|linkedin)", country: "string?", age_category: "string?" },
    outputSchema: { account_id: "string", platform: "string", handle: "string" },
  },
  social_post: {
    name: "social_post",
    description: "Publish a post to an owned social account. Routes to platform-specific provider under the hood.",
    inputSchema: { platform: "string (x|tiktok)", account_id: "string", cookies: "object[]", content: "string", media_urls: "string[]?", proxy_session_id: "string?" },
    outputSchema: { post_id: "string", url: "string" },
  },
};

export function listCapabilities(): CapabilityClass[] {
  return Object.values(CAPABILITY_CLASSES);
}

export function getCapability(name: string): CapabilityClass | undefined {
  return CAPABILITY_CLASSES[name];
}

// -------------------- Registry CRUD --------------------

export interface RegisterProviderInput {
  id?: string;
  source: I402ProviderSource;
  capability: string;
  name: string;
  description?: string;
  endpoint: string;
  method?: string;
  authScheme: I402AuthScheme;
  inputSchema: unknown;
  outputSchema: unknown;
  costPerCallUsdc: number;
  p50LatencyMs?: number;
  p99LatencyMs?: number;
  reputationScore?: number;
  metadata?: Record<string, unknown>;
}

export function registerProvider(input: RegisterProviderInput): I402Provider {
  if (!CAPABILITY_CLASSES[input.capability]) {
    throw new Error(`Unknown capability class: ${input.capability}`);
  }
  const id = input.id ?? `${input.source}.${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT OR IGNORE INTO i402_providers (
      id, source, capability, name, description, endpoint, method, auth_scheme,
      input_schema, output_schema, cost_per_call_usdc, p50_latency_ms, p99_latency_ms,
      success_rate, reputation_score, enabled, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    id,
    input.source,
    input.capability,
    input.name,
    input.description ?? null,
    input.endpoint,
    input.method ?? "POST",
    input.authScheme,
    JSON.stringify(input.inputSchema),
    JSON.stringify(input.outputSchema),
    input.costPerCallUsdc,
    input.p50LatencyMs ?? null,
    input.p99LatencyMs ?? null,
    1.0,
    input.reputationScore ?? 0.5,
    input.metadata ? JSON.stringify(input.metadata) : null
  );
  const provider = getProvider(id);
  if (!provider) throw new Error(`Failed to register provider ${id}`);
  return provider;
}

export function getProvider(id: string): I402Provider | undefined {
  const row = db.prepare(`SELECT * FROM i402_providers WHERE id = ?`).get(id) as ProviderRow | undefined;
  return row ? rowToProvider(row) : undefined;
}

export function listProviders(filter: { capability?: string; source?: I402ProviderSource; enabledOnly?: boolean } = {}): I402Provider[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.capability) {
    clauses.push("capability = ?");
    params.push(filter.capability);
  }
  if (filter.source) {
    clauses.push("source = ?");
    params.push(filter.source);
  }
  if (filter.enabledOnly !== false) {
    clauses.push("enabled = 1");
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM i402_providers ${where} ORDER BY reputation_score DESC, cost_per_call_usdc ASC`).all(...params) as ProviderRow[];
  return rows.map(rowToProvider);
}

export function setProviderEnabled(id: string, enabled: boolean): void {
  db.prepare(`UPDATE i402_providers SET enabled = ?, updated_at = datetime('now','utc') WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export interface MetricsUpdate {
  latencyMs?: number;
  success?: boolean;
}

/**
 * Update rolling metrics for a provider after a step executes against it.
 * success_rate uses exponential moving average (alpha 0.1) so recent behavior dominates.
 */
export function updateProviderMetrics(id: string, metrics: MetricsUpdate): void {
  const provider = getProvider(id);
  if (!provider) return;
  const alpha = 0.1;
  let newSuccessRate = provider.successRate;
  if (metrics.success !== undefined) {
    newSuccessRate = provider.successRate * (1 - alpha) + (metrics.success ? 1 : 0) * alpha;
  }
  let newP50 = provider.p50LatencyMs ?? null;
  if (metrics.latencyMs !== undefined) {
    newP50 = provider.p50LatencyMs
      ? Math.round(provider.p50LatencyMs * (1 - alpha) + metrics.latencyMs * alpha)
      : metrics.latencyMs;
  }
  db.prepare(
    `UPDATE i402_providers SET success_rate = ?, p50_latency_ms = ?, updated_at = datetime('now','utc') WHERE id = ?`
  ).run(newSuccessRate, newP50, id);
}

// -------------------- Scoring / ranking --------------------

/**
 * Score and rank providers for a capability given a quality preference.
 * Weights depend on quality hint. Lower cost and lower latency are better.
 */
export function scoreProviders(capability: string, quality: I402Quality = "best"): I402Provider[] {
  const candidates = listProviders({ capability });
  if (candidates.length === 0) return [];

  const maxCost = Math.max(...candidates.map(c => c.costPerCallUsdc), 0.0001);
  const maxLat = Math.max(...candidates.map(c => c.p50LatencyMs ?? 1000), 1);

  const weights = {
    best: { reputation: 0.6, cost: 0.2, latency: 0.2 },
    cheap: { reputation: 0.2, cost: 0.7, latency: 0.1 },
    fast: { reputation: 0.2, cost: 0.1, latency: 0.7 },
  }[quality];

  const ranked = candidates
    .map(c => {
      const costScore = 1 - c.costPerCallUsdc / maxCost;
      const latScore = 1 - (c.p50LatencyMs ?? 1000) / maxLat;
      const relScore = c.reputationScore * c.successRate;
      const score = relScore * weights.reputation + costScore * weights.cost + latScore * weights.latency;
      return { provider: c, score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked.map(r => r.provider);
}

// -------------------- Seed: Palmyr first-party primitives --------------------

/**
 * Register every Palmyr-owned service as a provider in the i402 registry.
 * Idempotent — uses INSERT OR IGNORE so re-running leaves metrics intact.
 *
 * All endpoints use auth_scheme "x402-solana" for payment settlement, and the
 * canonical Palmyr API base is read from env or defaults to production.
 */
export function seedPalmyrPrimitives(): void {
  const base = process.env.PALMYR_API_BASE ?? "https://palmyr.ai";

  // Wipe ALL Palmyr-source rows before re-seeding. The seed is authoritative
  // for endpoint URLs, capabilities, and costs — stale rows from earlier seeds
  // (different base URL, renamed capability, old cost) would otherwise win via
  // INSERT OR IGNORE. Metrics for Palmyr-owned providers reset at each seed;
  // federated / external providers are untouched.
  db.prepare(`DELETE FROM i402_providers WHERE source = 'agentos'`).run();
  db.prepare(`DELETE FROM i402_providers WHERE auth_scheme NOT IN ('x402-solana', 'x402-base')`).run();

  // Build a provider row from a capability + endpoint. Endpoints with path
  // parameters use {field_name} placeholders; the client substitutes them at
  // execution time from the step's input. Fields consumed by substitution are
  // stripped from the body before POSTing.
  const p = (
    id: string,
    capability: string,
    endpointPath: string,
    options: {
      method?: "POST" | "GET" | "DELETE" | "PUT";
      costUsdc: number;
      p50?: number;
      p99?: number;
      reputation?: number;
      name?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }
  ): RegisterProviderInput => ({
    id,
    source: "agentos",
    capability,
    name: options.name ?? `Palmyr ${capability}`,
    description: options.description,
    endpoint: `${base}${endpointPath}`,
    method: options.method ?? "POST",
    authScheme: "x402-solana",
    inputSchema: CAPABILITY_CLASSES[capability].inputSchema,
    outputSchema: CAPABILITY_CLASSES[capability].outputSchema,
    costPerCallUsdc: options.costUsdc,
    p50LatencyMs: options.p50,
    p99LatencyMs: options.p99,
    reputationScore: options.reputation ?? 0.9,
    metadata: options.metadata,
  });

  const primitives: RegisterProviderInput[] = [
    // ── Phone / SMS ──
    p("palmyr.provision_phone", "provision_phone", "/phone/numbers", {
      costUsdc: 3.0, p50: 4000, p99: 15000,
      description: "Provision a real phone number via Telnyx (150+ countries).",
    }),
    p("palmyr.release_phone", "release_phone", "/phone/numbers/{phone_number_id}", {
      method: "DELETE", costUsdc: 0.01, p50: 500, p99: 2000,
      description: "Release a phone number.",
    }),
    p("palmyr.list_phones", "list_phones", "/phone/numbers", {
      method: "GET", costUsdc: 0.01, p50: 200,
      description: "List phone numbers owned by the calling wallet.",
    }),
    p("palmyr.send_sms", "send_sms", "/phone/numbers/{phone_number_id}/send", {
      costUsdc: 0.05, p50: 800, p99: 3000,
      description: "Send an SMS from an owned phone number.",
    }),
    p("palmyr.read_sms", "read_sms", "/phone/numbers/{phone_number_id}/messages", {
      method: "GET", costUsdc: 0.02, p50: 400, p99: 1500,
    }),

    // ── Voice ──
    p("palmyr.start_voice_call", "start_voice_call", "/phone/numbers/{phone_number_id}/call", {
      costUsdc: 0.10, p50: 2000, p99: 10000,
    }),
    p("palmyr.list_calls", "list_calls", "/phone/numbers/{phone_number_id}/calls", {
      method: "GET", costUsdc: 0.02, p50: 400,
    }),
    p("palmyr.get_call_details", "get_call_details", "/phone/calls/{call_control_id}", {
      method: "GET", costUsdc: 0.02, p50: 400,
    }),
    p("palmyr.voice_speak", "voice_speak", "/phone/calls/{call_control_id}/speak", {
      costUsdc: 0.08, p50: 500,
    }),
    p("palmyr.voice_play", "voice_play", "/phone/calls/{call_control_id}/play", {
      costUsdc: 0.08, p50: 500,
    }),
    p("palmyr.voice_dtmf", "voice_dtmf", "/phone/calls/{call_control_id}/dtmf", {
      costUsdc: 0.02, p50: 300,
    }),
    p("palmyr.voice_gather", "voice_gather", "/phone/calls/{call_control_id}/gather", {
      costUsdc: 0.08, p50: 5000,
    }),
    p("palmyr.voice_record_start", "voice_record_start", "/phone/calls/{call_control_id}/record", {
      costUsdc: 0.10, p50: 400,
    }),
    p("palmyr.voice_record_stop", "voice_record_stop", "/phone/calls/{call_control_id}/record/stop", {
      costUsdc: 0.02, p50: 400,
    }),
    p("palmyr.voice_hangup", "voice_hangup", "/phone/calls/{call_control_id}/hangup", {
      costUsdc: 0.02, p50: 300,
    }),
    p("palmyr.voice_answer", "voice_answer", "/phone/calls/{call_control_id}/answer", {
      costUsdc: 0.02, p50: 300,
    }),
    p("palmyr.voice_transfer", "voice_transfer", "/phone/calls/{call_control_id}/transfer", {
      costUsdc: 0.10, p50: 1500,
    }),

    // ── Email ──
    p("palmyr.provision_email_inbox", "provision_email_inbox", "/email/inboxes", {
      costUsdc: 2.0, p50: 1500, p99: 4000,
      description: "E2E-encrypted inbox at {name}@palmyr.ai, keyed to the caller's Solana pubkey.",
    }),
    p("palmyr.list_inboxes", "list_inboxes", "/email/inboxes", {
      method: "GET", costUsdc: 0.01, p50: 200,
      description: "List email inboxes owned by the calling wallet.",
    }),
    p("palmyr.send_email", "send_email", "/email/inboxes/{inbox_id}/send", {
      costUsdc: 0.08, p50: 900, p99: 3000,
    }),
    p("palmyr.read_email", "read_email", "/email/inboxes/{inbox_id}/messages", {
      method: "GET", costUsdc: 0.02, p50: 400,
    }),
    p("palmyr.list_email_threads", "list_email_threads", "/email/inboxes/{inbox_id}/threads", {
      method: "GET", costUsdc: 0.02, p50: 400,
    }),
    p("palmyr.read_email_thread", "read_email_thread", "/email/threads/{thread_id}/messages", {
      method: "GET", costUsdc: 0.02, p50: 400,
    }),

    // ── Domain ──
    p("palmyr.register_domain", "register_domain", "/domains/register", {
      costUsdc: 10.0, p50: 20000, p99: 90000,
      description: "Register a domain via Namecheap (dynamic per-TLD pricing; $10 is a typical .io/.co).",
    }),
    p("palmyr.list_domains", "list_domains", "/domains", {
      method: "GET", costUsdc: 0.0001, p50: 300,
      description: "List domains owned by the calling wallet (wallet-keyed).",
    }),
    p("palmyr.get_domain", "get_domain", "/domains/{domain}", {
      method: "GET", costUsdc: 0.0001, p50: 300,
    }),
    p("palmyr.dns_read", "dns_manage", "/domains/{domain}/dns", {
      method: "GET", costUsdc: 0.0001, p50: 500,
      name: "Palmyr DNS read",
    }),
    p("palmyr.dns_write", "dns_manage", "/domains/{domain}/dns", {
      method: "POST", costUsdc: 0.0001, p50: 1500,
      name: "Palmyr DNS write",
    }),
    p("palmyr.transfer_domain_ownership", "transfer_domain_ownership", "/domains/{domain}/transfer-ownership", {
      costUsdc: 0.0001, p50: 500,
      description: "Transfer a domain's ownership to a new wallet (Solana or EVM).",
    }),
    p("palmyr.transfer_domain_out", "transfer_domain_out", "/domains/{domain}/transfer", {
      costUsdc: 0.0001, p50: 2000,
    }),

    // ── Compute / VPS ──
    p("palmyr.create_ssh_key", "create_ssh_key", "/compute/ssh-keys", {
      costUsdc: 0.10, p50: 500,
    }),
    p("palmyr.list_ssh_keys", "list_ssh_keys", "/compute/ssh-keys", {
      method: "GET", costUsdc: 0.01, p50: 300,
    }),
    p("palmyr.delete_ssh_key", "delete_ssh_key", "/compute/ssh-keys/{ssh_key_id}", {
      method: "DELETE", costUsdc: 0.01, p50: 400,
    }),
    p("palmyr.deploy_vps", "deploy_vps", "/compute/servers", {
      costUsdc: 6.0, p50: 60000, p99: 180000,
      description: "Hetzner VPS with cloud-init hardening + Node.js 22 + OpenClaw pre-installed.",
    }),
    p("palmyr.list_vps", "list_vps", "/compute/servers", {
      method: "GET", costUsdc: 0.01, p50: 400,
    }),
    p("palmyr.get_vps", "get_vps", "/compute/servers/{server_id}", {
      method: "GET", costUsdc: 0.01, p50: 400,
    }),
    p("palmyr.vps_action", "vps_action", "/compute/servers/{server_id}/actions", {
      costUsdc: 0.10, p50: 3000, p99: 15000,
      description: "Lifecycle action: reboot / poweron / poweroff / rebuild / reset.",
    }),
    p("palmyr.vps_resize", "vps_resize", "/compute/servers/{server_id}/resize", {
      costUsdc: 0.10, p50: 10000, p99: 40000,
    }),
    p("palmyr.vps_delete", "vps_delete", "/compute/servers/{server_id}", {
      method: "DELETE", costUsdc: 0.10, p50: 5000,
    }),
    p("palmyr.install_skill", "install_skill", "/compute/servers/{server_id}/install-skill", {
      costUsdc: 0.01, p50: 3000,
    }),
    p("palmyr.install_skills_bulk", "install_skills_bulk", "/compute/servers/{server_id}/install-skills-bulk", {
      costUsdc: 0.01, p50: 15000, p99: 60000,
    }),
    p("palmyr.remove_skill", "remove_skill", "/compute/servers/{server_id}/remove-skill", {
      costUsdc: 0.01, p50: 2000,
    }),
    p("palmyr.configure_openclaw", "configure_openclaw", "/compute/servers/{server_id}/configure-openclaw", {
      costUsdc: 0.01, p50: 3000,
    }),
    p("palmyr.configure_vps_wallet", "configure_vps_wallet", "/compute/servers/{server_id}/configure-wallet", {
      costUsdc: 0.01, p50: 2000,
    }),

    // ── Social: Twitter / X ──
    // No twitter_login provider — sessions are managed client-side by the
    // CLI executor (see cli/sdk.ts:ensureSocialSession). Login happens
    // automatically and quietly when needed; it is not a planner step.
    p("palmyr.twitter_post", "twitter_post", "/social/twitter/post", {
      costUsdc: 0.001, p50: 5000, p99: 30000, reputation: 0.8,
    }),
    p("palmyr.twitter_post_thread", "twitter_post_thread", "/social/twitter/post-thread", {
      costUsdc: 0.005, p50: 12000, p99: 90000, reputation: 0.75,
      description: "Post a 2-25 tweet thread in one composed session.",
    }),
    p("palmyr.twitter_post_media", "twitter_post_media", "/social/twitter/post-media", {
      costUsdc: 0.005, p50: 8000, p99: 120000, reputation: 0.75,
      description: "Post a tweet with 1-4 images or 1 video attached.",
    }),
    p("palmyr.twitter_list_my_tweets", "twitter_list_my_tweets", "/social/twitter/list-my-tweets", {
      costUsdc: 0.005, p50: 5000, p99: 30000, reputation: 0.85,
    }),
    p("palmyr.twitter_reply", "twitter_reply", "/social/twitter/reply", {
      costUsdc: 0.001, p50: 5000, p99: 30000, reputation: 0.8,
    }),
    p("palmyr.twitter_like", "twitter_like", "/social/twitter/like", {
      costUsdc: 0.001, p50: 3000, reputation: 0.85,
    }),
    p("palmyr.twitter_retweet", "twitter_retweet", "/social/twitter/retweet", {
      costUsdc: 0.001, p50: 3000, reputation: 0.85,
    }),
    p("palmyr.twitter_follow", "twitter_follow", "/social/twitter/follow", {
      costUsdc: 0.001, p50: 3000, reputation: 0.85,
    }),
    p("palmyr.twitter_unfollow", "twitter_unfollow", "/social/twitter/unfollow", {
      costUsdc: 0.001, p50: 3000, reputation: 0.85,
    }),
    p("palmyr.twitter_delete_post", "twitter_delete_post", "/social/twitter/delete", {
      costUsdc: 0.001, p50: 3000, reputation: 0.85,
    }),
    p("palmyr.twitter_update_profile", "twitter_update_profile", "/social/twitter/profile", {
      costUsdc: 0.001, p50: 4000, reputation: 0.8,
    }),
    // avatar/banner are async (202 + poll): a chunked upload + crop/save +
    // verify re-read runs ~60-90s, so advertise a realistic p99.
    p("palmyr.twitter_update_avatar", "twitter_update_avatar", "/social/twitter/avatar", {
      costUsdc: 0.005, p50: 20000, p99: 120000, reputation: 0.8,
    }),
    p("palmyr.twitter_update_banner", "twitter_update_banner", "/social/twitter/banner", {
      costUsdc: 0.005, p50: 20000, p99: 120000, reputation: 0.8,
    }),
    p("palmyr.twitter_change_username", "twitter_change_username", "/social/twitter/username", {
      costUsdc: 0.005, p50: 5000, reputation: 0.75,
    }),
    p("palmyr.twitter_buy_account", "twitter_buy_account", "/social/twitter/buy", {
      costUsdc: 5.0, p50: 3000, p99: 10000, reputation: 0.85,
      description: "Buy a pre-warmed Twitter/X account from the Palmyr pool.",
    }),

    // ── Social: TikTok ──
    // Same model as Twitter: no tiktok_login provider — sessions are
    // managed client-side by the CLI executor.
    p("palmyr.tiktok_post", "tiktok_post", "/social/tiktok/post", {
      costUsdc: 0.01, p50: 30000, p99: 120000, reputation: 0.7,
    }),
    p("palmyr.tiktok_follow", "tiktok_follow", "/social/tiktok/follow", {
      costUsdc: 0.001, p50: 5000, reputation: 0.75,
    }),
    p("palmyr.tiktok_like", "tiktok_like", "/social/tiktok/like", {
      costUsdc: 0.001, p50: 5000, reputation: 0.75,
    }),
    p("palmyr.tiktok_delete_post", "tiktok_delete_post", "/social/tiktok/delete", {
      costUsdc: 0.001, p50: 5000, reputation: 0.75,
    }),
    p("palmyr.tiktok_update_profile", "tiktok_update_profile", "/social/tiktok/profile", {
      costUsdc: 0.001, p50: 5000, reputation: 0.7,
    }),
    p("palmyr.tiktok_update_avatar", "tiktok_update_avatar", "/social/tiktok/avatar", {
      costUsdc: 0.005, p50: 8000, reputation: 0.7,
    }),

    // ── Legacy platform-dispatch providers kept for the existing social_post/social_account_provision capability classes ──
    {
      id: "palmyr.x_post",
      source: "agentos",
      capability: "social_post",
      name: "Palmyr X post (platform-dispatch wrapper)",
      description: "Dispatches to /social/twitter/post under the hood.",
      endpoint: `${base}/social/twitter/post`,
      method: "POST",
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.social_post.inputSchema,
      outputSchema: CAPABILITY_CLASSES.social_post.outputSchema,
      costPerCallUsdc: 0.001,
      p50LatencyMs: 5000,
      p99LatencyMs: 30000,
      reputationScore: 0.8,
      metadata: { platform: "x" },
    },
    {
      id: "palmyr.tiktok_post_legacy",
      source: "agentos",
      capability: "social_post",
      name: "Palmyr TikTok post (platform-dispatch wrapper)",
      description: "Dispatches to /social/tiktok/post under the hood.",
      endpoint: `${base}/social/tiktok/post`,
      method: "POST",
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.social_post.inputSchema,
      outputSchema: CAPABILITY_CLASSES.social_post.outputSchema,
      costPerCallUsdc: 0.01,
      p50LatencyMs: 30000,
      p99LatencyMs: 120000,
      reputationScore: 0.7,
      metadata: { platform: "tiktok" },
    },
    {
      id: "palmyr.x_account",
      source: "agentos",
      capability: "social_account_provision",
      name: "Palmyr X account provisioning",
      description: "Buy a warmed X account from the pool. Maps to /social/twitter/buy.",
      endpoint: `${base}/social/twitter/buy`,
      method: "POST",
      authScheme: "x402-solana",
      inputSchema: CAPABILITY_CLASSES.social_account_provision.inputSchema,
      outputSchema: CAPABILITY_CLASSES.social_account_provision.outputSchema,
      costPerCallUsdc: 5.0,
      p50LatencyMs: 3000,
      p99LatencyMs: 10000,
      reputationScore: 0.85,
      metadata: { platform: "x" },
    },
  ];

  const tx = db.transaction(() => {
    for (const primitive of primitives) {
      registerProvider(primitive);
    }
  });
  tx();
}
