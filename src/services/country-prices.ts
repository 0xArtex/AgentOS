/**
 * Admin-set per-country pricing for `palmyr twitter buy --country US`.
 *
 * One row per ISO 3166-1 alpha-2 country code, with the USDC amount the buy
 * route charges. Decoupled from per-account `sale_price_usdc` so adding a
 * fresh batch of accounts doesn't require re-pricing each one — the country
 * tag set at seed time (browser-detected or admin-declared) is enough.
 *
 * Lookups happen on the hot path in the buy route's auth middleware, so
 * we keep this layer dependency-free (no async, no I/O beyond SQLite).
 */
import { db } from "../db";

const ISO_ALPHA2 = /^[A-Z]{2}$/;

function normalize(country: string): string {
  return country.trim().toUpperCase();
}

export interface CountryPrice {
  country: string;
  price_usdc: number;
  updated_at: string;
}

/**
 * Insert or update the price for a country. Idempotent. Throws on invalid
 * input so the route can surface a clean 400 to the admin CLI.
 */
export function setCountryPrice(country: string, price: number): CountryPrice {
  const c = normalize(country);
  if (!ISO_ALPHA2.test(c)) {
    throw new Error(`country must be ISO 3166-1 alpha-2 (e.g. US, GB, DE) — got "${country}"`);
  }
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new Error(`price must be a positive number (USDC) — got ${price}`);
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO country_prices (country, price_usdc, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(country) DO UPDATE SET
      price_usdc = excluded.price_usdc,
      updated_at = excluded.updated_at
  `).run(c, price, now);
  return { country: c, price_usdc: price, updated_at: now };
}

/** null when no price is configured for the country. */
export function getCountryPrice(country: string): number | null {
  if (!country) return null;
  const c = normalize(country);
  if (!ISO_ALPHA2.test(c)) return null;
  const row = db
    .prepare("SELECT price_usdc FROM country_prices WHERE country = ?")
    .get(c) as { price_usdc: number } | undefined;
  return row ? row.price_usdc : null;
}

export function listCountryPrices(): CountryPrice[] {
  return db
    .prepare("SELECT country, price_usdc, updated_at FROM country_prices ORDER BY country")
    .all() as CountryPrice[];
}

export function deleteCountryPrice(country: string): boolean {
  const c = normalize(country);
  const r = db.prepare("DELETE FROM country_prices WHERE country = ?").run(c);
  return r.changes === 1;
}
