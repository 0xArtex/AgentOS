import { db } from "../db";
import os from "os";

const startTime = Date.now();

/**
 * Read the real version from the root package.json (same dist-safe pattern as
 * well-known.ts readPackageVersion): require() resolves relative to this file
 * (dist/utils or src/utils), so ../../package.json points at the project root
 * in both layouts. Read once at module load, behind a try/catch — a missing or
 * garbled package.json must never make a health request throw.
 */
function readPackageVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../package.json");
    const v = pkg && typeof pkg.version === "string" ? pkg.version : "";
    return v || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const VERSION = readPackageVersion();

export function getHealth() {
  // DB check
  let dbOk = false;
  let dbTables = 0;
  try {
    const result = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'").get() as any;
    dbOk = true;
    dbTables = result.c;
  } catch {}

  return {
    status: dbOk ? "healthy" : "degraded",
    version: VERSION,
    uptime: Math.floor(process.uptime()),
    startedAt: new Date(startTime).toISOString(),
    database: {
      status: dbOk ? "connected" : "error",
      tables: dbTables,
    },
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      rsssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    system: {
      platform: os.platform(),
      nodeVersion: process.version,
      cpus: os.cpus().length,
      freeMemMB: Math.round(os.freemem() / 1024 / 1024),
    },
  };
}

export function getVersion() {
  return {
    version: VERSION,
    name: "Palmyr",
    build: process.env.BUILD_SHA || "dev",
    nodeVersion: process.version,
  };
}
