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
export function assertSshPublicKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length === 0 || trimmed.length > 16384) {
    throw new Error('sshPublicKey must be 1–16384 chars');
  }
  if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(\s+[\w.@-]+)?$/.test(trimmed)) {
    throw new Error("sshPublicKey must be an OpenSSH public key (e.g. 'ssh-ed25519 AAAA... [comment]')");
  }
  return trimmed;
}

/**
 * Bash blocks emitted into cloud-init for each named install recipe.
 *
 * Adding a new recipe is purely additive: pick a slug, drop a bash block here,
 * and the route layer's allowlist + the marker-file check (gate 4 of the CLI's
 * readiness chain) pick it up automatically.
 *
 * Recipe contracts:
 *   - Run as root, non-interactive. `set -euo pipefail` is in effect from the
 *     wrapping cloud-init script — recipes that have steps which can fail
 *     transiently must guard with `|| true` or restart the recipe explicitly.
 *   - DEBIAN_FRONTEND=noninteractive and NEEDRESTART_MODE=a are exported by
 *     the wrapping script.
 *   - Recipes should NOT exit non-zero on cosmetic failures (version probes
 *     etc.) — bubbling those up aborts the rest of cloud-init.
 *   - The wrapping script writes /etc/agentos/install-status.json on success
 *     so the CLI's wait-for-install gate has a single sentinel to poll.
 *     Per-recipe debug logs are recipe-specific (see below).
 */
const INSTALL_RECIPES: Record<string, { description: string; bash: string }> = {
  // OpenClaw — the original AgentOS default. Installs Node 22 + the openclaw
  // and clawhub npm packages. Writes /etc/openclaw/provision.json for
  // historical compatibility with anything that already keys off it.
  //
  // Defensive choices:
  //   - Each curl|bash and npm install is wrapped in `set +e ... PIPESTATUS`
  //     so we surface the inner exit code rather than letting our outer
  //     `set -e` mask it with a generic abort.
  //   - Tee logs to /var/log/agentos/openclaw-install.log so the CLI's
  //     diagnostic fetcher has a single known path to tail on failure.
  //   - Use absolute paths everywhere — cloud-init's bash doesn't source
  //     ~/.bashrc, so PATH may not pick up freshly-installed binaries.
  openclaw: {
    description: 'OpenClaw runtime + clawhub skill registry (Node 22)',
    bash: `# ─── Install OpenClaw ───
mkdir -p /var/log/agentos /etc/openclaw

# Install Node 22. NodeSource's setup script must be allowed to fail loudly,
# but we want the actual install.sh exit code, not bash's pipe propagation.
set +e
curl -fsSL https://deb.nodesource.com/setup_22.x 2>&1 | bash - 2>&1 | tee /var/log/agentos/openclaw-install.log
NODESOURCE_EXIT=\${PIPESTATUS[0]}
if [ "\${NODESOURCE_EXIT:-1}" -ne 0 ]; then
  echo "ERROR: NodeSource setup script failed (exit=\$NODESOURCE_EXIT)" >&2
  set -e
  exit 1
fi

apt-get install -y -qq nodejs 2>&1 | tee -a /var/log/agentos/openclaw-install.log
APT_EXIT=\${PIPESTATUS[0]}
if [ "\${APT_EXIT:-1}" -ne 0 ]; then
  echo "ERROR: apt-get install nodejs failed (exit=\$APT_EXIT)" >&2
  set -e
  exit 1
fi

# npm install can take ~60s on a small box; tee the output so the CLI
# diagnostic fetcher can show what happened on failure.
npm install -g openclaw clawhub 2>&1 | tee -a /var/log/agentos/openclaw-install.log
NPM_EXIT=\${PIPESTATUS[0]}
set -e
if [ "\${NPM_EXIT:-1}" -ne 0 ]; then
  echo "ERROR: npm install -g openclaw clawhub failed (exit=\$NPM_EXIT)" >&2
  exit 1
fi

cat > /etc/openclaw/provision.json << OPENCLAW_PROVISION_EOF
{
  "provisioned_by": "agentos",
  "provisioned_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "openclaw_installed": true
}
OPENCLAW_PROVISION_EOF

echo "OpenClaw provisioning complete" >> /var/log/agentos/openclaw-install.log
/usr/bin/openclaw --version >> /var/log/agentos/openclaw-install.log 2>&1 || true
`,
  },

  // Hermes Agent (Nous Research) — the self-improving AI agent. The official
  // installer at scripts/install.sh handles all platform detection, deps
  // (Python 3.11+ via uv, build-essential, ripgrep, ffmpeg), and creates the
  // /usr/local/bin/hermes symlink when run as root. We pass --skip-setup so
  // the user can configure their model provider after deploy via
  //   agentos compute exec <id> -- hermes setup
  // or inside an SSH session.
  //
  // Defensive choices (this recipe failed in practice on a fresh deploy):
  //   - Don't reference $HOME under `set -u` — cloud-init may not export it.
  //     The installer always lands at /usr/local/bin/hermes when run as
  //     root + Linux + non-Termux (the only path we hit in cloud-init).
  //   - Wrap the curl|bash in `set +e` and capture PIPESTATUS[0], so the
  //     real install.sh exit code is surfaced, not bash's pipe noise.
  //   - tee output (don't just redirect) so the install log is visible
  //     in /var/log/cloud-init-output.log too — easier post-mortem.
  //   - Probe with the absolute path (/usr/local/bin/hermes), not a PATH
  //     lookup. cloud-init bash doesn't have ~/.bashrc sourced, and even
  //     though /usr/local/bin is in the default PATH, being explicit
  //     removes one source of doubt.
  hermes: {
    description: 'Hermes Agent (Nous Research) — self-improving AI agent runtime',
    bash: `# ─── Install Hermes Agent ───
mkdir -p /var/log/agentos

# install.sh sets its own \`set -e\` and handles platform detection internally.
# We disable our outer \`set -e\` only around the curl|bash + tee chain so
# PIPESTATUS gives us the real exit code instead of tee's success.
set +e
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh 2>&1 \\
  | bash -s -- --skip-setup 2>&1 \\
  | tee /var/log/agentos/hermes-install.log
INSTALL_EXIT=\${PIPESTATUS[1]}
set -e

# Probe the canonical root-FHS path. The installer only uses ~/.local/bin
# when running as a non-root user; in cloud-init we're always root.
if [ ! -x /usr/local/bin/hermes ]; then
  echo "ERROR: hermes binary not at /usr/local/bin/hermes after install (install.sh exit=\$INSTALL_EXIT)" >&2
  echo "--- last 80 lines of /var/log/agentos/hermes-install.log ---" >&2
  tail -80 /var/log/agentos/hermes-install.log >&2 || true
  exit 1
fi

# --version is a sanity check, not load-bearing. If a future Hermes release
# changes its CLI, don't abort the whole install over it.
/usr/local/bin/hermes --version > /var/log/agentos/hermes-version.log 2>&1 || true
`,
  },
};

export function listInstallRecipes(): Array<{ name: string; description: string }> {
  return Object.entries(INSTALL_RECIPES).map(([name, r]) => ({ name, description: r.description }));
}

export function isKnownRecipe(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(INSTALL_RECIPES, name);
}

/**
 * Build a cloud-init `user_data` script.
 *
 * Always emits the security-hardening preamble (sshd config, UFW, unattended
 * upgrades). Then runs each install recipe in `installs` in the order given.
 * Finally writes `/etc/agentos/install-status.json` so the CLI's gate-4
 * readiness check has a single file to poll.
 *
 * Caller is responsible for validating that every entry in `installs` is in
 * `INSTALL_RECIPES` (the route layer does this so the 400 surfaces cleanly).
 */
function generateCloudInit(opts: { userPubkey?: string; installs: string[] }): string {
  const platformPubKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAeOkVwRfQpLUemQ6HwbglAPjv1WioahHED/SXSaK7r+ agentos-platform-temp';
  // userPubkey was already validated by the route layer via assertSshPublicKey;
  // it cannot contain shell metacharacters by construction. We still wrap it in
  // single quotes so the worst-case typo doesn't break the heredoc.
  const userKeyLine = opts.userPubkey
    ? `echo '${opts.userPubkey}' >> /root/.ssh/authorized_keys`
    : '# (no user public key provided at deploy time — call POST /compute/servers/:id/setup-ssh to inject one)';

  const recipeBlocks = opts.installs
    .map(name => INSTALL_RECIPES[name]?.bash ?? `# (unknown recipe '${name}' — skipping; route layer should have rejected this before generateCloudInit)`)
    .join('\n');

  const installsJsonArray = JSON.stringify(opts.installs);

  return `#!/bin/bash
# Deliberate: 'set -eo pipefail' (not -u). cloud-init doesn't always export
# HOME or other vars our recipes reference, and an unbound-variable abort
# masks the real failure with a confusing "HOME: unbound" message. Recipes
# that want stricter hygiene set their own 'set -u' locally.
set -eo pipefail

# Suppress apt's interactive prompts and the needrestart noise that would
# otherwise pause cloud-init for "which services should I restart?" dialogs.
# Also ensure HOME is set — some Hermes/installer code paths fall back to it
# even when running as root, and cloud-init's user_data shell sometimes
# inherits an empty HOME.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export HOME="\${HOME:-/root}"

# Make every step's stdout/stderr land in the cloud-init log AND a file we
# control so the CLI's diagnostic fetcher has a deterministic path to tail
# regardless of which Hetzner image variant we're on.
mkdir -p /var/log/agentos
exec > >(tee -a /var/log/agentos/cloud-init.log) 2>&1
echo "[agentos] cloud-init user_data starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── Security Hardening ───
# Inject platform temp key for provisioning (removed during SSH handoff)
mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo '${platformPubKey}' >> /root/.ssh/authorized_keys
${userKeyLine}
chmod 600 /root/.ssh/authorized_keys

# Clear Hetzner's forced password change (blocks SSH key auth otherwise)
chage -d "$(date +%Y-%m-%d)" root 2>/dev/null || true
passwd -u root 2>/dev/null || true

# Disable password auth but allow pubkey
sed -i 's/#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/#\\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true

# Firewall. apt update can fail transiently on a fresh box (mirror DNS races,
# dpkg locks) — try twice before giving up so we don't abort cloud-init over
# a one-shot transient.
apt-get update -qq || (sleep 5 && apt-get update -qq)
apt-get install -y -qq ufw unattended-upgrades
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo 'Unattended-Upgrade::Allowed-Origins { "\${distro_id}:\${distro_codename}-security"; };' > /etc/apt/apt.conf.d/50unattended-upgrades-local

echo "[agentos] preamble done, starting recipes: ${JSON.stringify(opts.installs)}"

${recipeBlocks}

# ─── AgentOS install marker ───
# The CLI's deploy --wait readiness chain polls this file as gate 4 when the
# user requested any install. Single sentinel; absent → CLI surfaces a
# "install did not complete" timeout; present → CLI returns ready: true.
mkdir -p /etc/agentos
cat > /etc/agentos/install-status.json << AGENTOS_INSTALL_EOF
{
  "installs": ${installsJsonArray},
  "completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "ok"
}
AGENTOS_INSTALL_EOF
echo "[agentos] cloud-init complete"
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
 *   - `installs`: list of named install recipes from `INSTALL_RECIPES`. When
 *     non-empty, cloud-init runs and disables password auth — the password
 *     Hetzner returns is then useless after first boot. Caller must hand in
 *     a key (`sshKeyIds` or `sshPublicKey`), or use `setup-ssh` after the
 *     fact, or accept that they'll only access the box through the
 *     AgentOS-managed APIs.
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
  installs?: string[],
  location?: string,
  sshPublicKey?: string
): Promise<Server & { passwordUsable: boolean; installs: string[] }> {
  if (!isValidServerType(serverType)) {
    const valid = getServerPlans().map(p => p.type).join(", ");
    throw new Error(`Unknown or deprecated server type '${serverType}'. Valid types right now: ${valid}`);
  }
  const pricing = getServerPricing()[serverType] ?? "0.00";

  // Sanitize and validate the install list. Dedup, drop empty strings, then
  // bail on anything outside the allowlist — we don't want shell snippets
  // we didn't author landing in cloud-init.
  const resolvedInstalls = Array.from(new Set((installs ?? []).filter(s => typeof s === 'string' && s.length > 0)));
  for (const r of resolvedInstalls) {
    if (!isKnownRecipe(r)) {
      const known = Object.keys(INSTALL_RECIPES).join(', ');
      throw new Error(`Unknown install recipe '${r}'. Known recipes: ${known}`);
    }
  }

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

  if (resolvedInstalls.length > 0) {
    payload.user_data = generateCloudInit({ userPubkey: safeUserKey, installs: resolvedInstalls });
  }

  const data = await hcloud("POST", "/servers", payload);
  const s = data.server;

  // Cloud-init disables password auth — once it runs, the password Hetzner
  // returned is no good. Tell the caller so they don't ship it to the user.
  const passwordUsable = resolvedInstalls.length === 0;

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
  return { ...server, passwordUsable, installs: resolvedInstalls };
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

  // reset_password is the only action besides create that hands back a usable
  // root password. Persist it so `compute setup-ssh`'s pre-handoff sentinel
  // (root_password != null in the DB) still works after a password rotation,
  // and so a follow-up `compute info` can show the current password.
  if (action === "reset_password" && data.root_password) {
    server.rootPassword = data.root_password;
    storage.setServer(id, server);
  }

  // Hetzner returns auxiliary fields alongside the action object on a couple
  // of action endpoints (root_password on reset_password, wss_url + password
  // on request_console). Forwarding the whole top-level response — instead
  // of just `data.action` — lets the route layer surface those fields
  // without us having to special-case here.
  return data;
}

/**
 * Run a single command on a freshly-deployed server via the platform's
 * temporary SSH key. Pre-handoff only: once `setup-ssh` has run, the platform
 * key is gone and `root_password` is NULL in the DB — caller gets 410 from
 * the route layer in that state.
 *
 * `command` and `args` are passed as separate argv elements through ssh's
 * remote-shell layer. We POSIX-quote each element on this side so the remote
 * shell sees them as distinct words; we never let user-supplied bytes
 * interpolate into our own shell.
 */
export async function execOnServer(
  id: string,
  command: string,
  args: string[],
  opts: { timeoutSec?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const server = storage.getServer(id);
  if (!server) throw new Error(`Server ${id} not found`);
  if (!server.ipv4) throw new Error(`Server ${id} has no public IPv4 yet`);

  const { spawnSync } = await import("child_process");
  const PLATFORM_KEY = "/root/.ssh/id_ed25519_platform";
  const timeoutSec = Math.max(1, Math.min(120, opts.timeoutSec ?? 30));

  // POSIX shell-quote every argv element. Single-quote-wrap and escape
  // embedded single quotes via the standard `'\''` trick. Anything that
  // matches our safe-char set is passed through bare — purely cosmetic, the
  // semantics are identical.
  const quote = (s: string): string => {
    if (/^[A-Za-z0-9._/:@%+=-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  };
  const remoteCmd = [command, ...args].map(quote).join(" ");

  // -q (quiet) + -T (no PTY): same defensive flags as the CLI's
  // sshProbe/sshRun. Without these, a remote login shell can leak
  // "tcsetattr: Inappropriate ioctl for device" + "logout" through stderr
  // (issue #85). Non-interactive ssh doesn't need a tty.
  const r = spawnSync(
    "ssh",
    [
      "-i", PLATFORM_KEY,
      "-q",
      "-T",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${Math.min(15, timeoutSec)}`,
      `root@${server.ipv4}`,
      remoteCmd,
    ],
    { timeout: timeoutSec * 1000, stdio: "pipe", maxBuffer: 1024 * 1024 },
  );

  return {
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
    // status === null when the process was killed by timeout; surface that as
    // 124 (the conventional `timeout(1)` exit code) rather than `null`.
    exitCode: r.status === null ? 124 : r.status,
    durationMs: 0, // route layer fills this from a wall-clock measurement
  };
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
