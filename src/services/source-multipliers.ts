/**
 * Optional pricing multipliers per account `source` ('web', 'mobile', …).
 * Applied on top of `country_prices` at buy time: final USDC charge =
 * country_price * source_multiplier (or 1.0 when no row exists for the
 * source). Lets the admin signal that, say, web-registered accounts are
 * priced 1.2x mobile across all countries — without forcing an N×M
 * (country × source) pricing matrix.
 *
 * Sources are stored lowercased to match the column normalization done in
 * twitter-api.ts and the buy filter in poolBuy.
 */
import { db } from "../db";

function normalize(source: string): string {
  return source.trim().toLowerCase();
}

export interface SourceMultiplier {
  source: string;
  multiplier: number;
  updated_at: string;
}

export function setSourceMultiplier(source: string, multiplier: number): SourceMultiplier {
  const s = normalize(source);
  if (!s) throw new Error("source must be a non-empty string (e.g. 'web', 'mobile')");
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error(`multiplier must be a positive number — got ${multiplier}`);
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO source_multipliers (source, multiplier, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      multiplier = excluded.multiplier,
      updated_at = excluded.updated_at
  `).run(s, multiplier, now);
  return { source: s, multiplier, updated_at: now };
}

/** Returns null when no row exists. Callers must default to 1.0 themselves. */
export function getSourceMultiplier(source: string): number | null {
  if (!source) return null;
  const s = normalize(source);
  const row = db
    .prepare("SELECT multiplier FROM source_multipliers WHERE source = ?")
    .get(s) as { multiplier: number } | undefined;
  return row ? row.multiplier : null;
}

export function listSourceMultipliers(): SourceMultiplier[] {
  return db
    .prepare("SELECT source, multiplier, updated_at FROM source_multipliers ORDER BY source")
    .all() as SourceMultiplier[];
}

export function deleteSourceMultiplier(source: string): boolean {
  const s = normalize(source);
  const r = db.prepare("DELETE FROM source_multipliers WHERE source = ?").run(s);
  return r.changes === 1;
}
