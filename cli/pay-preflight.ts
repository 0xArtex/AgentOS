/**
 * Wallet/payment preflight for x402 paid commands.
 *
 * Answers the five-question checklist an agent needs BEFORE attempting any
 * paid CLI call:
 *
 *   1. Which pay chain is selected?           (solana | base)
 *   2. Which wallet id will sign?             (config, env, or auto-pick)
 *   3. Can it decrypt / sign right now?       (yes | no + why)
 *   4. USDC balance + ATA status              (only when checkBalance=true)
 *   5. Exact fix if anything's off            (one-line, copy-pasteable)
 *
 * Two surfaces:
 *
 *   - `localPreflight(opts)` — no RPC. Runs at the top of paidRequest /
 *     paidStreamRequest so config + decryption failures bail out before the
 *     paid round-trip. Cheap enough to enable by default.
 *
 *   - `fullPreflight(opts)` — `localPreflight` + USDC balance + ATA status
 *     via RPC. Used by `palmyr wallet pay-preflight`. Skip in hot paths —
 *     the Solana public RPC tends to 429 if you hammer it.
 */

import { loadConfig } from './config.js'
import {
  hasVaultWallets,
  listVaultWallets,
  getVaultEvmWallet,
  getVaultSolanaKeypair,
} from './vault.js'

/** Canonical USDC mint / contract for each chain. */
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

export type PayChain = 'solana' | 'base'

export interface PayPreflightReport {
  /** True only when every check that ran returned a pass. */
  ok: boolean
  payChain: PayChain
  walletId: string | null
  walletAddress: string | null
  canSign: boolean
  /** Populated only by `fullPreflight` (or when checkBalance=true). */
  usdc: {
    balance: number | null
    requiredMin: number
    /** Solana-only — Base has no separate ATA concept. */
    ataStatus?: 'exists' | 'missing' | 'unknown'
  } | null
  /** One-line, copy-pasteable next step when ok=false. */
  fix: string | null
}

export interface PreflightOpts {
  /** Override `config.defaultPayChain`. */
  chain?: PayChain
  /** Override `config.defaultPayWalletId` / `PALMYR_PAY_WALLET` env. */
  walletRef?: string
  /** Passphrase for vault decryption (also reads `PALMYR_WALLET_PASSPHRASE`). */
  passphrase?: string
  /** USDC threshold for the balance check (full preflight only). Default 0. */
  minUsdc?: number
}

interface InternalOpts extends PreflightOpts {
  checkBalance: boolean
}

async function runPreflight(opts: InternalOpts): Promise<PayPreflightReport> {
  const cfg = loadConfig()
  const payChain: PayChain = opts.chain || ((cfg as any).defaultPayChain || 'solana')
  const minUsdc = opts.minUsdc ?? 0

  // ── 1. Resolve wallet id — mirrors pay.ts auto-pick fallback ──────────────
  // Filters auto-picked candidates by chain so a Solana-only vault wallet
  // never gets picked for a Base preflight (it would just fail at signing).
  let walletId =
    opts.walletRef ||
    (cfg as any).defaultPayWalletId ||
    process.env.PALMYR_PAY_WALLET ||
    null

  if (!walletId && hasVaultWallets()) {
    const wallets = listVaultWallets()
    const candidate = payChain === 'base'
      ? wallets.find((w) => w.evmAddress)
      : wallets.find((w) => w.solanaAddress)
    if (candidate) walletId = candidate.id
  }

  if (!walletId) {
    return {
      ok: false,
      payChain,
      walletId: null,
      walletAddress: null,
      canSign: false,
      usdc: null,
      fix: noWalletFix(payChain),
    }
  }

  // ── 2. Try to decrypt & derive the chain-specific address (= can sign) ────
  // Any throw from the vault helpers (missing keychain secret, wrong
  // passphrase) is treated as "cannot sign" — we surface the underlying
  // message in `fix` so the agent knows which knob to turn.
  let walletAddress: string | null = null
  let canSign = false
  let signError: string | null = null

  try {
    if (payChain === 'base') {
      const w = getVaultEvmWallet(walletId, opts.passphrase)
      walletAddress = String(w.address)
    } else {
      const k = getVaultSolanaKeypair(walletId, opts.passphrase)
      walletAddress = k.publicKey.toBase58()
    }
    canSign = true
  } catch (err: any) {
    signError = err?.message || 'decrypt failed'
  }

  if (!canSign) {
    return {
      ok: false,
      payChain,
      walletId,
      walletAddress: null,
      canSign: false,
      usdc: null,
      fix: `Cannot decrypt wallet ${walletId} (${signError}). Set PALMYR_WALLET_PASSPHRASE=<phrase> in the env, or pass --passphrase <phrase> on the command.`,
    }
  }

  // ── 3. Local-only preflight stops here ────────────────────────────────────
  if (!opts.checkBalance) {
    return {
      ok: true,
      payChain,
      walletId,
      walletAddress,
      canSign: true,
      usdc: null,
      fix: null,
    }
  }

  // ── 4. USDC balance + ATA status (one RPC per chain) ──────────────────────
  let usdcBalance: number | null = null
  let ataStatus: 'exists' | 'missing' | 'unknown' | undefined
  let balanceError: string | null = null

  try {
    if (payChain === 'base') {
      const { ethers } = await import('ethers')
      const provider = new ethers.JsonRpcProvider(
        process.env.PALMYR_BASE_RPC || 'https://mainnet.base.org',
      )
      const erc20 = new ethers.Contract(
        BASE_USDC,
        ['function balanceOf(address) view returns (uint256)'],
        provider,
      )
      // Non-null assertion — we returned early above if canSign was false.
      const wei: bigint = await erc20.balanceOf(walletAddress!)
      usdcBalance = Number(wei) / 1e6
    } else {
      const { Connection, PublicKey } = await import('@solana/web3.js')
      const splToken = await import('@solana/spl-token')
      const conn = new Connection(
        process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
        'confirmed',
      )
      const owner = new PublicKey(walletAddress!)
      const mint = new PublicKey(SOLANA_USDC_MINT)
      const ata = splToken.getAssociatedTokenAddressSync(mint, owner)
      try {
        const account = await splToken.getAccount(conn, ata, 'confirmed')
        usdcBalance = Number(account.amount) / 1e6
        ataStatus = 'exists'
      } catch (e: any) {
        // `@solana/spl-token` exports several typed errors for the missing-ATA
        // case; rather than matching all of them, recognize the signature
        // ("could not find account" / "TokenAccountNotFound") and treat
        // anything else as a generic RPC failure (ataStatus=unknown).
        const msg = String(e?.message || '')
        if (
          /TokenAccountNotFound/i.test(msg) ||
          /could not find account/i.test(msg) ||
          e?.name === 'TokenAccountNotFoundError'
        ) {
          ataStatus = 'missing'
          usdcBalance = 0
        } else {
          ataStatus = 'unknown'
          balanceError = msg || 'balance check failed'
        }
      }
    }
  } catch (err: any) {
    balanceError = err?.message || 'balance check failed'
  }

  // ── 5. Compute final verdict + fix ────────────────────────────────────────
  let ok = false
  let fix: string | null = null

  if (balanceError) {
    fix = `USDC balance check failed on ${payChain}: ${balanceError}. ${payChain === 'solana' ? 'Set SOLANA_RPC_URL=<url> to a less rate-limited endpoint and retry.' : 'Set PALMYR_BASE_RPC=<url> to a private RPC and retry.'}`
  } else if (ataStatus === 'missing') {
    // ATA missing is functionally "balance = 0 and you cannot receive
    // SPL transfers yet". The first inbound transfer auto-creates the ATA,
    // so the fix is simply "fund the wallet".
    fix = `Solana USDC associated-token-account (ATA) not created yet for ${walletAddress}. The first inbound USDC transfer creates it automatically — fund the wallet with any amount of USDC on Solana, then retry.`
  } else if (usdcBalance !== null && usdcBalance < minUsdc) {
    fix = `USDC balance ${usdcBalance.toFixed(6)} on ${payChain} < required ${minUsdc.toFixed(6)}. Fund ${walletAddress} with at least ${(minUsdc - usdcBalance).toFixed(6)} more USDC on ${payChain}.`
  } else if (usdcBalance !== null) {
    ok = true
  }

  return {
    ok,
    payChain,
    walletId,
    walletAddress,
    canSign: true,
    usdc: {
      balance: usdcBalance,
      requiredMin: minUsdc,
      ...(payChain === 'solana' ? { ataStatus } : {}),
    },
    fix,
  }
}

/**
 * Build the fix string for the "no wallet resolvable" branch. Three states:
 *   - no vault wallets at all
 *   - vault wallets exist but none expose the selected chain's address
 *   - (impossible after auto-pick lands a hit, but kept as final fallback)
 */
function noWalletFix(payChain: PayChain): string {
  if (!hasVaultWallets()) {
    return 'No vault wallets found. Create one with: palmyr wallet create (a single mnemonic produces both Solana + Base addresses).'
  }
  const chainName = payChain === 'base' ? 'Base/EVM' : 'Solana'
  return `Vault has wallets, but none expose a ${chainName} address. Re-create with: palmyr wallet create (or re-import with --${payChain} to materialize that chain).`
}

/** Cheap, no-RPC preflight. Safe to run before every paid command. */
export async function localPreflight(opts: PreflightOpts = {}): Promise<PayPreflightReport> {
  return runPreflight({ ...opts, checkBalance: false })
}

/** Full preflight including USDC balance + ATA status via RPC. */
export async function fullPreflight(opts: PreflightOpts = {}): Promise<PayPreflightReport> {
  return runPreflight({ ...opts, checkBalance: true })
}
