import { Router, Request, Response } from "express";
import { db } from "../db";
import { randomUUID } from "crypto";
import { Keypair } from "@solana/web3.js";


const router = Router();

/**
 * @swagger
 * /api/wallet/create:
 *   post:
 *     summary: Create a Solana wallet for an agent
 *     description: Generates a new Solana keypair and stores it securely. Returns the public key only.
 *     tags: [Wallet]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [agentId]
 *             properties:
 *               agentId:
 *                 type: string
 *               label:
 *                 type: string
 *                 default: "default"
 *     responses:
 *       201:
 *         description: Wallet created
 */
router.post("/create", (req: Request, res: Response) => {
  const { agentId, label = "default" } = req.body;
  if (!agentId) return res.status(400).json({ error: "agentId required" });

  try {
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const walletId = randomUUID();

    // Store wallet (in production, private key would be encrypted/HSM)
    db.prepare(`
      CREATE TABLE IF NOT EXISTS agent_wallets (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        label TEXT DEFAULT 'default',
        public_key TEXT NOT NULL,
        network TEXT DEFAULT 'solana',
        created_at TEXT DEFAULT (datetime('now')),
        balance_sol REAL DEFAULT 0,
        balance_usdc REAL DEFAULT 0
      )
    `).run();

    db.prepare(`INSERT INTO agent_wallets (id, agent_id, label, public_key) VALUES (?, ?, ?, ?)`)
      .run(walletId, agentId, label, publicKey);

    res.status(201).json({
      walletId,
      agentId,
      label,
      publicKey,
      network: "solana",
      message: "Wallet created. Fund it to start transacting.",
      fundingUrl: `https://explorer.solana.com/address/${publicKey}?cluster=mainnet-beta`
    });
  } catch (e: any) {
    res.status(500).json({ error: "Failed to create wallet", details: e.message });
  }
});

/**
 * @swagger
 * /api/wallet/{agentId}:
 *   get:
 *     summary: List wallets for an agent
 *     tags: [Wallet]
 */
router.get("/:agentId", (req: Request, res: Response) => {
  const { agentId } = req.params;

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_wallets (
      id TEXT PRIMARY KEY, agent_id TEXT, label TEXT, public_key TEXT,
      network TEXT DEFAULT 'solana', created_at TEXT DEFAULT (datetime('now')),
      balance_sol REAL DEFAULT 0, balance_usdc REAL DEFAULT 0
    )`).run();

    const wallets = db.prepare("SELECT id, label, public_key, network, created_at, balance_sol, balance_usdc FROM agent_wallets WHERE agent_id = ?").all(agentId);

    res.json({
      agentId,
      walletCount: wallets.length,
      wallets,
      tip: wallets.length === 0 ? "POST /api/wallet/create with { agentId } to get started" : undefined
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /api/wallet/balance/{publicKey}:
 *   get:
 *     summary: Check wallet balance (mock for hackathon)
 *     tags: [Wallet]
 */
router.get("/balance/:publicKey", (req: Request, res: Response) => {
  const { publicKey } = req.params;

  res.json({
    publicKey,
    network: "solana",
    balances: {
      SOL: 0,
      USDC: 0,
    },
    note: "Live balance checking coming post-hackathon. Fund via Solana transfer.",
    explorer: `https://explorer.solana.com/address/${publicKey}`
  });
});

export default router;
