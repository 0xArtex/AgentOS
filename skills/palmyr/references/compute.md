> Fetch this when deploying a VPS, running commands on one, or bootstrapping an agent runtime.

# Palmyr — Compute (VPS)

Hetzner Cloud servers, deployed and paid per action via x402.

## CLI

```bash
palmyr compute plans [--location fsn1]                     # List VPS plans (free); optional location filter
palmyr compute locations                                   # Datacenters + per-location server-type availability (free)
palmyr compute install-recipes                             # List bootstrappable agent runtimes (free)
palmyr compute deploy --type cx23 --json                   # Golden path: auto-key, wait, verified ($6 + monthly)
palmyr compute deploy --type cx23 --install hermes --json  # Deploy + bootstrap Hermes Agent (Nous Research)
palmyr compute deploy --type cax11 --location fsn1 --json   # Pin to a specific datacenter
palmyr compute deploy --type cx23 --install hermes,openclaw --json  # Multiple recipes
palmyr compute deploy --type cx23 --no-install --json      # Vanilla Ubuntu (password auth on)
palmyr compute deploy --type cx23 --ssh-key 12345 --json   # Use a pre-uploaded Hetzner key
palmyr compute deploy --type cx23 --no-wait --json         # Fire-and-forget
palmyr compute ssh-key add <PUBKEY_PATH>                   # Upload YOUR public key to Hetzner ($0.10) — returns numeric id
palmyr compute ssh-key list                                # List uploaded keys ($0.01)
palmyr compute wait <name|id> [--install hermes]           # Block until ready (gates: status=running, port 22, SSH, install marker)
palmyr compute ssh <name|id>                               # SSH in (TTY) or print the ssh command (agent mode)
palmyr compute exec <name|id> -- <command> [args...]       # Run command pre-handoff ($0.05)
palmyr compute rename <name|id> <new-name>                 # Rename ($0.01, no reboot)
palmyr compute reset-password <name|id>                    # Rotate root password ($0.10)
palmyr compute console <name|id>                           # noVNC URL — break-glass when SSH broken ($0.10)
palmyr compute reboot|poweroff|poweron|reset|rebuild <name|id>   # Lifecycle actions ($0.10)
palmyr compute setup-ssh <id> --pubkey-file <PUBKEY_PATH>  # Inject YOUR key post-deploy ($0.01)
palmyr compute list                                        # List servers
palmyr compute delete <name|id>                            # Delete server ($0.10)
```

## VPS golden path

`palmyr compute deploy --type cx23 --json` is a one-liner that:

1. Generates an ed25519 keypair locally (`~/.palmyr/ssh/<name>/id_ed25519`).
2. Pays $6 USDC via x402, deploys via Hetzner Cloud.
3. Runs cloud-init (security hardening + the requested install recipe).
4. Waits until `status=running`, port 22 is open, `ssh -i <key> root@<ip> 'true'` returns 0, and `/etc/palmyr/install-status.json` reports `ok`.
5. Returns JSON with a top-level `sshCommand` and a `readiness` block showing each gate.

Then `palmyr compute ssh <name>` drops you in (TTY) or prints the ssh command (agent mode) — everything resolves from a local cache, no paid round-trip. Server provision is async: `POST /compute/servers` returns a `poll_url` (`/compute/servers/:id`) — poll it, don't re-pay.

## Bootstrap an agent runtime

```bash
palmyr compute deploy --type cx23 --install hermes --json
```

Cloud-init runs the recipe at first boot. Available recipes (live list at `GET /compute/install-recipes`):

- `openclaw` — Node 22 + the `openclaw` and `clawhub` npm packages. The historical default.
- `hermes` — [Hermes Agent](https://github.com/NousResearch/hermes-agent), Nous Research's self-improving AI agent, installed via the official `scripts/install.sh --skip-setup`. After deploy, run `palmyr compute exec <name> -- hermes setup` to pick a model provider.

Recipe validation is **pre-payment**: typos return `EXIT.BAD_INPUT` (2) without charging USDC.

## API

| Action | Endpoint | Cost (USDC) |
|---|---|---|
| List plans | `GET /compute/plans` (optional `?location=fsn1`; rows include `availableLocations[]`) | Free |
| List locations | `GET /compute/locations` | Free |
| List install recipes | `GET /compute/install-recipes` | Free |
| Upload SSH key | `POST /compute/ssh-keys` | 0.10 |
| List SSH keys | `GET /compute/ssh-keys` | 0.01 |
| Delete SSH key | `DELETE /compute/ssh-keys/:id` | 0.01 |
| Create server | `POST /compute/servers` (accepts `sshPublicKey`, `sshKeyIds[]`, `install`, `location`; pre-payment validates name + type/location compat; returns `sshAccess` + `installs`) | dynamic (per server type; base 6.00) |
| List servers | `GET /compute/servers` | 0.01 |
| Server status | `GET /compute/servers/:id` | 0.01 |
| Rename server | `PUT /compute/servers/:id` (metadata-only, no reboot) | 0.01 |
| Server action | `POST /compute/servers/:id/actions` (reboot, poweron, poweroff, reset, rebuild, reset_password, request_console) | 0.10 |
| Run command (pre-handoff) | `POST /compute/servers/:id/exec` | 0.05 |
| SSH key handoff | `POST /compute/servers/:id/setup-ssh` | 0.01 |
| Resize server | `POST /compute/servers/:id/resize` | 0.10 |
| Delete server | `DELETE /compute/servers/:id` | 0.10 |
| Browse skills catalog | `GET /compute/skills/catalog` | Free |
| Skill security scan | `GET /compute/skills/:slug/security` | Free |
