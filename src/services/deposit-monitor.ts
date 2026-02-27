import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "../db";
import { deposit } from "./balance";
import { getSolanaKeypair } from "./deposit-wallets";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TREASURY_SOL = "B1YEboAH3ZDscqni7cyVnGkcDroB2kqLXCwLs3Ez8oX3";
const POLL_INTERVAL = 60_000; // 60 seconds

// Use public RPC — swap for Helius if needed
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

async function checkSolanaDeposits(): Promise<void> {
  const wallets = db.prepare("SELECT * FROM deposit_wallets").all() as any[];
  if (!wallets.length) return;

  for (const w of wallets) {
    try {
      const pubkey = new PublicKey(w.solana_address);
      
      // Get USDC token accounts
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: USDC_MINT });
      
      for (const ta of tokenAccounts.value) {
        const info = ta.account.data.parsed?.info;
        const amount = info?.tokenAmount?.uiAmount || 0;
        
        if (amount > 0) {
          // Credit user balance
          const refId = `sol_deposit_${w.solana_address}_${Date.now()}`;
          try {
            deposit(w.user_id, amount, refId, `Solana USDC deposit: ${amount} USDC`);
            console.log(`💰 Credited ${amount} USDC to ${w.user_id} from Solana deposit`);
            
            // TODO: Sweep funds to treasury
            // const keypair = getSolanaKeypair(w.derivation_index);
            // Transfer USDC from deposit wallet → TREASURY_SOL
            console.log(`📤 TODO: Sweep ${amount} USDC from ${w.solana_address} to ${TREASURY_SOL}`);
          } catch (e: any) {
            if (e.message?.includes("Duplicate")) continue; // Already credited
            console.error(`Failed to credit deposit for ${w.user_id}:`, e.message);
          }
        }
      }
    } catch (e: any) {
      // RPC errors are expected with public endpoint rate limits
      if (!e.message?.includes("429")) {
        console.error(`Deposit check failed for ${w.solana_address}:`, e.message);
      }
    }
  }
}

// TODO: Add Base/EVM USDC checking when needed
// async function checkEvmDeposits(): Promise<void> { ... }

let intervalId: NodeJS.Timeout | null = null;

export function startDepositMonitor(): void {
  console.log("👀 Deposit monitor started (polling every 60s)");
  
  // Initial check after 10s
  setTimeout(() => checkSolanaDeposits().catch(console.error), 10_000);
  
  // Then every 60s
  intervalId = setInterval(() => {
    checkSolanaDeposits().catch(console.error);
  }, POLL_INTERVAL);
}

export function stopDepositMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
