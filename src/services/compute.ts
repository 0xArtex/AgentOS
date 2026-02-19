import { config } from "../config";
import { storage } from "./storage";
import { Server, ServerType, ServerAction, SERVER_PRICING, SERVER_PLANS } from "../types";
import crypto from "crypto";

const HCLOUD_API = "https://api.hetzner.cloud/v1";

function headers() {
  return {
    Authorization: `Bearer ${config.hcloudToken}`,
    "Content-Type": "application/json",
  };
}

async function hcloud(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${HCLOUD_API}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hetzner API ${method} ${path} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Create a server on Hetzner Cloud.
 */
export async function createServer(
  name: string,
  serverType: ServerType,
  image: string,
  owner: string,
  sshKeyIds?: number[]
): Promise<Server> {
  const pricing = SERVER_PRICING[serverType];
  if (!pricing) throw new Error(`Unknown server type: ${serverType}`);

  const payload: any = {
    name,
    server_type: serverType,
    image,
    location: config.hcloudLocation,
    labels: { managed_by: "agentos", owner },
  };

  if (sshKeyIds?.length) {
    payload.ssh_keys = sshKeyIds;
  }

  const data = await hcloud("POST", "/servers", payload);
  const s = data.server;

  const server: Server = {
    id: String(s.id),
    name: s.name,
    serverType,
    image,
    status: s.status,
    ipv4: s.public_net?.ipv4?.ip ?? null,
    ipv6: s.public_net?.ipv6?.ip ?? null,
    owner,
    priceMonthly: pricing,
    createdAt: s.created,
    rootPassword: data.root_password ?? null,
  };

  storage.setServer(server.id, server);
  return server;
}

/**
 * Delete / terminate a server.
 */
export async function deleteServer(id: string): Promise<void> {
  const server = storage.getServer(id);
  if (!server) throw new Error(`Server ${id} not found`);

  await hcloud("DELETE", `/servers/${id}`);
  storage.deleteServer(id);
}

/**
 * Get server status (refreshes from Hetzner API).
 */
export async function getServer(id: string): Promise<Server> {
  const local = storage.getServer(id);
  if (!local) throw new Error(`Server ${id} not found`);

  try {
    const data = await hcloud("GET", `/servers/${id}`);
    const s = data.server;
    local.status = s.status;
    local.ipv4 = s.public_net?.ipv4?.ip ?? local.ipv4;
    local.ipv6 = s.public_net?.ipv6?.ip ?? local.ipv6;
    storage.setServer(id, local);
  } catch {
    // Return cached data if API is unreachable
  }

  return local;
}

/**
 * List all servers for a given owner (or all if no owner specified).
 */
export async function listServers(owner?: string): Promise<Server[]> {
  return storage.listServers(owner);
}

// ── SSH Key Management ────────────────────────────────────────

export async function uploadSshKey(name: string, publicKey: string): Promise<number> {
  const data = await hcloud("POST", "/ssh_keys", { name, public_key: publicKey });
  return data.ssh_key.id;
}

export async function listSshKeys(): Promise<any[]> {
  const data = await hcloud("GET", "/ssh_keys");
  return data.ssh_keys;
}

export async function deleteSshKey(id: number): Promise<void> {
  await hcloud("DELETE", `/ssh_keys/${id}`);
}

// ── Server Actions ────────────────────────────────────────────

export async function serverAction(id: string, action: ServerAction, image?: string): Promise<any> {
  const server = storage.getServer(id);
  if (!server) throw new Error(`Server ${id} not found`);

  const body: any = { type: action };
  if (action === "rebuild" && image) {
    body.image = image;
  }

  const data = await hcloud("POST", `/servers/${id}/actions`, body);
  return data.action;
}

export async function resizeServer(id: string, serverType: ServerType, upgradeDisk: boolean = false): Promise<any> {
  const server = storage.getServer(id);
  if (!server) throw new Error(`Server ${id} not found`);

  // Server must be off to resize
  const data = await hcloud("POST", `/servers/${id}/actions`, {
    type: "change_type",
    server_type: serverType,
    upgrade_disk: upgradeDisk,
  });

  // Update local record
  const pricing = SERVER_PRICING[serverType];
  if (pricing) {
    server.serverType = serverType;
    server.priceMonthly = pricing;
    storage.setServer(id, server);
  }

  return data.action;
}

export function getPlans() {
  return SERVER_PLANS.map(p => ({
    type: p.type,
    vcpu: p.vcpu,
    ramGb: p.ram,
    diskGb: p.disk,
    trafficTb: p.traffic,
    arch: p.arch,
    priceUsdc: p.priceUsdc,
    priceUsdcMonthly: p.priceUsdc,
  }));
}
