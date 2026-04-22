import OpenAI from "openai";
import { db } from "../db";
import { listProviders } from "./i402-providers";
import type { I402Provider } from "./i402-providers";

// -------------------- OpenAI client (lazy) --------------------

const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536 dimensions
const EMBEDDING_DIM = 1536;

let _openai: OpenAI | null = null;

function openai(): OpenAI | null {
  if (_openai) return _openai;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  _openai = new OpenAI({ apiKey });
  return _openai;
}

export function resetOpenAIClient(): void {
  _openai = null;
}

export function embeddingsAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

// -------------------- Float32 <-> Buffer conversion for SQLite BLOB --------------------

function vectorToBlob(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

function blobToVector(blob: Buffer): number[] {
  const out = new Array<number>(blob.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = blob.readFloatLE(i * 4);
  return out;
}

// -------------------- Embedding computation --------------------

export async function embed(text: string): Promise<number[]> {
  const client = openai();
  if (!client) throw new Error("OPENAI_API_KEY not set — embeddings unavailable");

  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  const vec = res.data[0]?.embedding;
  if (!vec) throw new Error("OpenAI returned no embedding");
  return vec;
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const client = openai();
  if (!client) throw new Error("OPENAI_API_KEY not set");

  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return res.data.map(d => d.embedding);
}

// -------------------- Cosine similarity --------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// -------------------- Provider embedding cache --------------------

interface ProviderEmbeddingRow {
  id: string;
  embedding: Buffer | null;
}

function providerDocumentText(p: I402Provider): string {
  const parts = [p.name, p.capability, p.description ?? ""].filter(Boolean);
  return parts.join(" — ");
}

/**
 * Ensure every enabled provider has an embedding stored in i402_providers.embedding.
 * Skipped silently if OPENAI_API_KEY is absent. Safe to call repeatedly.
 */
export async function ensureProviderEmbeddings(): Promise<{ computed: number; skipped: number }> {
  if (!embeddingsAvailable()) return { computed: 0, skipped: 0 };

  const rows = db
    .prepare(`SELECT id, embedding FROM i402_providers WHERE enabled = 1`)
    .all() as ProviderEmbeddingRow[];

  const missing: I402Provider[] = [];
  for (const row of rows) {
    if (!row.embedding) {
      const p = listProviders().find(x => x.id === row.id);
      if (p) missing.push(p);
    }
  }

  if (missing.length === 0) return { computed: 0, skipped: rows.length };

  // Batch in groups of 32 to stay under OpenAI per-call limits
  const batchSize = 32;
  let computed = 0;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const texts = batch.map(providerDocumentText);
    const vectors = await embedMany(texts);
    const upsert = db.prepare(`UPDATE i402_providers SET embedding = ? WHERE id = ?`);
    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        upsert.run(vectorToBlob(vectors[j]), batch[j].id);
        computed++;
      }
    });
    tx();
  }

  return { computed, skipped: rows.length - computed };
}

// -------------------- Two-stage retrieval --------------------

export interface RetrievalOptions {
  capability?: string;
  topN?: number;
}

/**
 * Narrow the provider set for an intent. Two-stage:
 * 1. Compute intent embedding (or fall back to string match if no API key)
 * 2. Rank all candidate providers by cosine similarity
 * 3. Return top-N
 *
 * If embeddings are unavailable, falls back to simple capability-name matching
 * (returns all providers for the matching capability).
 */
export async function narrowProvidersForIntent(
  intent: string,
  options: RetrievalOptions = {}
): Promise<I402Provider[]> {
  const topN = options.topN ?? parseInt(process.env.I402_RETRIEVAL_TOP_N ?? "20", 10);

  const candidates = listProviders(
    options.capability ? { capability: options.capability, enabledOnly: true } : { enabledOnly: true }
  );
  if (candidates.length === 0) return [];

  if (!embeddingsAvailable()) {
    // Degradation path: no embeddings. Return highest-reputation providers first.
    return candidates.slice(0, topN);
  }

  const intentVec = await embed(intent);

  // Load any missing embeddings before ranking
  await ensureProviderEmbeddings();

  const rows = db
    .prepare(
      `SELECT id, embedding FROM i402_providers
       WHERE enabled = 1 AND id IN (${candidates.map(() => "?").join(",")})`
    )
    .all(...candidates.map(c => c.id)) as ProviderEmbeddingRow[];

  const embeddingById = new Map<string, number[]>();
  for (const row of rows) {
    if (row.embedding) embeddingById.set(row.id, blobToVector(row.embedding));
  }

  const scored = candidates
    .map(p => {
      const vec = embeddingById.get(p.id);
      const sim = vec ? cosineSimilarity(intentVec, vec) : 0;
      return { provider: p, sim };
    })
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topN);

  return scored.map(s => s.provider);
}
