import { Router, Request, Response } from "express";
import {
  listCapabilities,
  listProviders,
  CAPABILITY_CLASSES,
  type CapabilityClass,
  type I402Provider,
} from "../services/i402-providers";

const router = Router();

interface CapabilityGroup {
  key: string;
  label: string;
  test: (name: string) => boolean;
}

const GROUPS: CapabilityGroup[] = [
  { key: "phone",    label: "Phone",    test: n => /^(provision_phone|release_phone|send_sms|read_sms)$/.test(n) },
  { key: "voice",    label: "Voice",    test: n => /^(start_voice_call|list_calls|get_call_details|voice_)/.test(n) },
  { key: "email",    label: "Email",    test: n => /^(provision_email_inbox|send_email|read_email|list_email_threads|read_email_thread)$/.test(n) },
  { key: "domain",   label: "Domain",   test: n => /^(register_domain|list_domains|get_domain|dns_manage|transfer_domain)/.test(n) },
  { key: "compute",  label: "Compute",  test: n => /^(deploy_vps|list_vps|get_vps|vps_|create_ssh_key|list_ssh_keys|delete_ssh_key|install_skill|install_skills_bulk|remove_skill|configure_openclaw|configure_vps_wallet)$/.test(n) },
  { key: "twitter",  label: "Twitter",  test: n => n.startsWith("twitter_") },
  { key: "tiktok",   label: "TikTok",   test: n => n.startsWith("tiktok_") },
  { key: "compound", label: "Compound", test: n => !!CAPABILITY_CLASSES[n]?.isCompound },
  { key: "dispatch", label: "Dispatch", test: n => n === "social_post" || n === "social_account_provision" },
];

const FALLBACK_GROUP: CapabilityGroup = { key: "other", label: "Other", test: () => true };

function groupOf(capabilityName: string): CapabilityGroup {
  for (const g of GROUPS) if (g.test(capabilityName)) return g;
  return FALLBACK_GROUP;
}

function toPathSlug(groupKey: string, capName: string): string {
  const prefix = `${groupKey}_`;
  const suffix = `_${groupKey}`;
  let s = capName;
  if (s.startsWith(prefix)) s = s.slice(prefix.length);
  if (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  return s || capName;
}

const NETWORK_LABELS: Record<string, string> = {
  "x402-base":   "Base",
  "x402-solana": "Solana",
  "internal":    "Internal",
  "api_key":     "API Key",
  "wallet_sig":  "Wallet Sig",
};

function networkLabel(authScheme: string): string {
  return NETWORK_LABELS[authScheme] ?? authScheme;
}

interface ToolJson {
  id: string;
  name: string;
  description: string;
  category: string;
  categoryLabel: string;
  path: string;
  networks: string[];
  networkLabels: string[];
  minCostUsdc: number;
  maxCostUsdc: number;
  providerCount: number;
  providers: Array<{
    id: string;
    name: string;
    network: string;
    networkLabel: string;
    costUsdc: number;
    method: string;
    endpoint: string;
  }>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  isCompound: boolean;
}

function toToolJson(cap: CapabilityClass, providers: I402Provider[]): ToolJson {
  const group = groupOf(cap.name);
  const slug = toPathSlug(group.key, cap.name);
  const networks = Array.from(new Set(providers.map(p => p.authScheme)));
  const minCost = providers.length ? Math.min(...providers.map(p => p.costPerCallUsdc)) : 0;
  const maxCost = providers.length ? Math.max(...providers.map(p => p.costPerCallUsdc)) : 0;
  return {
    id: `${group.key}/${slug}`,
    name: cap.name,
    description: cap.description,
    category: group.key,
    categoryLabel: group.label,
    path: `${group.key}/${slug}`,
    networks,
    networkLabels: networks.map(networkLabel),
    minCostUsdc: minCost,
    maxCostUsdc: maxCost,
    providerCount: providers.length,
    providers: providers.map(p => ({
      id: p.id,
      name: p.name,
      network: p.authScheme,
      networkLabel: networkLabel(p.authScheme),
      costUsdc: p.costPerCallUsdc,
      method: p.method,
      endpoint: p.endpoint.replace(/^https?:\/\/[^/]+/, ""),
    })),
    inputSchema: cap.inputSchema,
    outputSchema: cap.outputSchema,
    isCompound: !!cap.isCompound,
  };
}

router.get("/", (_req: Request, res: Response) => {
  const capabilities = listCapabilities();
  const providers = listProviders({ enabledOnly: true });

  const providersByCap = new Map<string, I402Provider[]>();
  for (const p of providers) {
    if (!providersByCap.has(p.capability)) providersByCap.set(p.capability, []);
    providersByCap.get(p.capability)!.push(p);
  }

  const tools = capabilities
    .map(cap => toToolJson(cap, providersByCap.get(cap.name) ?? []))
    .sort((a, b) => a.path.localeCompare(b.path));

  const usedGroupKeys = new Set(tools.map(t => t.category));
  const categories = [...GROUPS, FALLBACK_GROUP]
    .filter(g => usedGroupKeys.has(g.key))
    .map(g => ({ key: g.key, label: g.label }));

  const usedNetworks = new Set<string>();
  for (const t of tools) for (const n of t.networks) usedNetworks.add(n);
  const networks = Array.from(usedNetworks).map(key => ({ key, label: networkLabel(key) }));

  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({
    stats: {
      totalTools: tools.length,
      totalProviders: providers.length,
      totalCategories: categories.length,
      totalNetworks: networks.length,
    },
    categories,
    networks,
    tools,
  });
});

export default router;
