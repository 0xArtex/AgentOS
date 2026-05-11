import crypto from "crypto";
import { storage } from "./storage";
import { ApiKey, ApiKeyProvider, API_KEY_PRICING } from "../types";

/**
 * Provider-specific key provisioning stubs.
 * In production, each would call the provider's API to create a real key.
 */
const providerGenerators: Record<ApiKeyProvider, () => Promise<string>> = {
  brave_search: async () => `BSK-${crypto.randomBytes(24).toString("hex")}`,
  helius: async () => `helius-${crypto.randomBytes(20).toString("hex")}`,
  openai: async () => `sk-palmyr-${crypto.randomBytes(24).toString("hex")}`,
  anthropic: async () => `sk-ant-palmyr-${crypto.randomBytes(24).toString("hex")}`,
  elevenlabs: async () => `el-${crypto.randomBytes(20).toString("hex")}`,
  custom: async () => `key-${crypto.randomBytes(24).toString("hex")}`,
};

/**
 * Generate (provision) a new API key for a third-party service.
 */
export async function generateKey(provider: ApiKeyProvider, owner: string, label?: string): Promise<ApiKey> {
  const generator = providerGenerators[provider];
  if (!generator) throw new Error(`Unsupported provider: ${provider}`);

  const pricing = API_KEY_PRICING[provider];
  if (pricing === undefined) throw new Error(`No pricing for provider: ${provider}`);

  const secret = await generator();
  const id = crypto.randomUUID();

  const key: ApiKey = {
    id,
    provider,
    label: label ?? `${provider}-key`,
    /** Only shown once at creation time */
    secret,
    owner,
    priceUsdc: pricing,
    active: true,
    createdAt: new Date().toISOString(),
  };

  storage.setApiKey(id, key);
  return key;
}

/**
 * List all active keys for an owner.
 */
export async function listKeys(owner?: string): Promise<Omit<ApiKey, "secret">[]> {
  return storage.listApiKeys(owner).map(({ secret, ...rest }) => rest);
}

/**
 * Revoke an API key. Owner scope is enforced — only the creator can revoke.
 */
export async function revokeKey(id: string, owner?: string): Promise<void> {
  const key = storage.getApiKey(id);
  if (!key) throw new Error(`API key ${id} not found`);

  if (owner && key.owner && key.owner !== owner) {
    const err = new Error(`You do not own API key ${id}`);
    (err as any).statusCode = 403;
    throw err;
  }

  key.active = false;
  storage.setApiKey(id, key);
}
