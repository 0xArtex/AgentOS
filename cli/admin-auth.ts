/**
 * Builds the three headers required by the server's pool-admin middleware:
 *   X-Admin-Pubkey / X-Admin-Timestamp / X-Admin-Signature
 *
 * The admin signs `<method>:<path>:<timestamp>` with the Solana key derived
 * from the configured admin wallet. No secrets transit the network.
 */
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadConfig } from './config.js'
import { signMessageLocal } from './vault.js'

function resolveAdminWalletId(): string {
  const fromEnv = process.env.AGENTOS_POOL_ADMIN_WALLET
  if (fromEnv) return fromEnv
  const cfg = loadConfig()
  const id = (cfg as any).defaultPayWalletId
  if (!id) {
    throw new Error(
      'No admin wallet configured. Set AGENTOS_POOL_ADMIN_WALLET to a wallet ID, or ' +
      'run: agentos wallet use <ID> --chain solana'
    )
  }
  return id
}

export function buildAdminHeaders(method: string, path: string): Record<string, string> {
  const walletId = resolveAdminWalletId()
  const vaultDir = process.env.AGENTOS_WALLET_PATH || join(homedir(), '.agentos', 'wallet')
  const walletsDir = join(vaultDir, 'wallets')
  if (!existsSync(walletsDir)) throw new Error(`Vault directory not found: ${walletsDir}`)

  let pubkey = ''
  for (const f of readdirSync(walletsDir).filter(n => n.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(join(walletsDir, f), 'utf8')) as any
    if (data.id === walletId || data.name === walletId) {
      const sol = (data.accounts || []).find((a: any) =>
        a.chainId === 'solana' || String(a.chainId || '').startsWith('solana:')
      )
      if (sol) pubkey = sol.address
      break
    }
  }
  if (!pubkey) throw new Error(`Wallet "${walletId}" not found or has no Solana address`)

  const timestamp = Date.now().toString()
  const message = `${method.toUpperCase()}:${path}:${timestamp}`
  const { signature } = signMessageLocal(walletId, 'solana', message)

  return {
    'X-Admin-Pubkey': pubkey,
    'X-Admin-Timestamp': timestamp,
    'X-Admin-Signature': signature,
  }
}
