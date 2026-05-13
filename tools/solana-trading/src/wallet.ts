import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import bs58 from "bs58";
import { readFileSync } from "fs";

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export function makeConnection(rpcUrl?: string): Connection {
  const url = rpcUrl || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(url, "confirmed");
}

export function loadKeypairFromEnv(): Keypair {
  const secretKeyB58 = process.env.WALLET_SECRET_KEY?.trim();
  const keypairPath = process.env.WALLET_KEYPAIR_PATH?.trim();
  if (secretKeyB58) return Keypair.fromSecretKey(bs58.decode(secretKeyB58));
  if (keypairPath) {
    const raw = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  throw new Error(
    "No wallet configured. Set WALLET_SECRET_KEY (base58) or WALLET_KEYPAIR_PATH (JSON file path).",
  );
}

export async function getSolBalance(connection: Connection, owner: PublicKey): Promise<number> {
  const lamports = await connection.getBalance(owner, "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

export async function getSplTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<{ raw: bigint; ui: number; decimals: number }> {
  let decimals = 0;
  try {
    const mintInfo = await getMint(connection, mint);
    decimals = mintInfo.decimals;
  } catch {
    return { raw: 0n, ui: 0, decimals: 0 };
  }
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const account = await getAccount(connection, ata, "confirmed");
    return {
      raw: account.amount,
      ui: Number(account.amount) / Math.pow(10, decimals),
      decimals,
    };
  } catch {
    return { raw: 0n, ui: 0, decimals };
  }
}
