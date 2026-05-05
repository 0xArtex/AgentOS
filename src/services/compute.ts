import { config } from "../config";
import { storage } from "./storage";
import { Server, ServerType, ServerAction } from "../types";
import { getServerPlans, getServerPricing, isValidServerType } from "./hcloud-types";
import crypto from "crypto";

const HCLOUD_API = "https://api.hetzner.cloud/v1";

/**
 * Validate an OpenSSH public key string before splicing it into cloud-init.
 * Cloud-init runs as root on a fresh box — we MUST NOT let arbitrary input
 * land in the shell heredoc. Any invalid byte → throw, caller turns it into a
 * 400 before the Hetzner API is touched.
 *
 * Allowed key types match what `routes/compute.ts:setup-ssh` already accepts.
 * Stripped to single-line; comment field is allowed (alphanum + . _ - @).
 */
function assertSshPublicKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length === 0 || trimmed.length > 16384) {
    throw new Error('sshPublicKey must be 1–16384 chars');
  }
  if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(\s+[\w.@-]+)?$/.test(trimmed)) {
    throw new Error("sshPublicKey must be an OpenSSH public key (e.g. 'ssh-ed25519 AAAA... [comment]')");
  }
  return trimmed;
}

function generateCloudInit(opts: { userPubkey?: string } = {}): string {
  const platformPubKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAeOkVwRfQpLUemQ6HwbglAPjv1WioahHED/SXSaK7r+ agentos-platform-temp';
  // userPubkey was already validated by the route layer via assertSshPublicKey;
  // it cannot contain shell metacharacters by construction. We still wrap it in
  // single quotes so the worst-case typo doesn't break the heredoc.
  const userKeyLine = opts.userPubkey
    ? `echo '${opts.userPubkey}' >> /root/.ssh/authorized_keys`
    : '# (no user public key provided at deploy time — call POST /compute/servers/:id/setup-ssh to inject one)';
  return `#!/bin/bash
set -euo pipefail

# ─── Security Hardening ───
# Inject platform temp key for provisioning (removed during SSH handoff)
mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo '${platformPubKey}' >> /root/.ssh/authorized_keys
${userKeyLine}
chmod 600 /root/.ssh/authorized_keys

# Clear Hetzner's forced password change (blocks SSH key auth otherwise)
chage -d $(date +%Y-%m-%d) root 2>/dev/null || true
passwd -u root 2>/dev/null || true

# Disable password auth but allow pubkey
sed -i 's/#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/#\\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh || systemctl restart sshd

# Firewall
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Auto security updates
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades
echo 'Unattended-Upgrade::Allowed-Origins { "\${distro_id}:\${distro_codename}-security"; };' > /etc/apt/apt.conf.d/50unattended-upgrades-local

# ─── Install OpenClaw ───
# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

# Install OpenClaw
npm install -g openclaw clawhub

# Mark setup complete
mkdir -p /etc/openclaw
cat > /etc/openclaw/provision.json << 'PROVISION_EOF'
{
  "provisioned_by": "agentos",
  "provisioned_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "openclaw_installed": true,
  "hardened": true,
  "firewall": "ufw",
  "ssh": "key-only"
}
PROVISION_EOF

echo "OpenClaw provisioning complete" > /var/log/openclaw-provision.log
openclaw --version >> /var/log/openclaw-provision.log 2>&1 || true
`;
}

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
 *
 * SSH access model:
 *   - `sshKeyIds`: numeric IDs of keys already uploaded via `POST /compute/ssh-keys`.
 *     Hetzner injects these into `authorized_keys` *before* cloud-init runs.
 *   - `sshPublicKey`: a raw OpenSSH public key string. Spliced into cloud-init so
 *     it lands in `authorized_keys` while we're already touching the file there.
 *     Validated by `assertSshPublicKey` at the route boundary; do not pass
 *     untrusted input straight to this argument.
 *   - `installOpenClaw=true`: cloud-init runs and **disables password auth**.
 *     Password Hetzner returns is therefore useless after first boot. Caller
 *     must hand in a key (`sshKeyIds` or `sshPublicKey`), or use the
 *     `setup-ssh` route after the fact, or accept that they'll only access
 *     the box through the OpenClaw API/gateway.
 *
 * `passwordUsable` in the return payload is the source of truth for the route
 * layer: false → strip `rootPassword` from the API response, surface handoff
 * guidance instead.
 */
export async function createServer(
  name: string,
  serverType: ServerType,
  image: string,
  owner: string,
  sshKeyIds?: number[],
  installOpenClaw?: boolean,
  location?: string,
  sshPublicKey?: string
): Promise<Server & { passwordUsable: boolean }> {
  if (!isValidServerType(serverType)) {
    const valid = getServerPlans().map(p => p.type).join(", ");
    throw new Error(`Unknown or deprecated server type '${serverType}'. Valid types right now: ${valid}`);
  }
  const pricing = getServerPricing()[serverType] ?? "0.00";

  const payload: any = {
    name,
    server_type: serverType,
    image,
    location: location || config.hcloudLocation,
    labels: { managed_by: "agentos" },
  };

  if (sshKeyIds?.length) {
    payload.ssh_keys = sshKeyIds;
  }

  // Validate before we touch any external API. assertSshPublicKey throws on
  // shell-metachar input — caller must turn that into a 400.
  const safeUserKey = sshPublicKey ? assertSshPublicKey(sshPublicKey) : undefined;

  if (installOpenClaw) {
    payload.user_data = generateCloudInit({ userPubkey: safeUserKey });
  }

  const data = await hcloud("POST", "/servers", payload);
  const s = data.server;

  // Cloud-init disables password auth — once it runs, the password Hetzner
  // returned is no good. Tell the caller so they don't ship it to the user.
  const passwordUsable = !installOpenClaw;

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
    // We always store the password locally — `setup-ssh` uses its presence as
    // a "pre-handoff" sentinel. The route layer decides whether to expose it
    // to the API caller based on `passwordUsable`.
    rootPassword: data.root_password ?? null,
  };

  storage.setServer(server.id, server);
  return { ...server, passwordUsable };
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

  const body: any = {};
  if (action === "rebuild") {
    body.image = image || server.image || "ubuntu-24.04";
  }

  const data = await hcloud("POST", `/servers/${id}/actions/${action}`, body);
  return data.action;
}

export async function resizeServer(id: string, serverType: ServerType, upgradeDisk: boolean = false): Promise<any> {
  const server = storage.getServer(id);
  if (!server) throw new Error(`Server ${id} not found`);

  // Server must be off to resize
  const data = await hcloud("POST", `/servers/${id}/actions/change_type`, {
    server_type: serverType,
    upgrade_disk: upgradeDisk,
  });

  // Update local record
  const pricing = getServerPricing()[serverType];
  if (pricing) {
    server.serverType = serverType;
    server.priceMonthly = pricing;
    storage.setServer(id, server);
  }

  return data.action;
}

export function getPlans() {
  return getServerPlans().map(p => ({
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
