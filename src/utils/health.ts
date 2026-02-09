import { db } from "../db";
import { config } from "../config";
import os from "os";

const startTime = Date.now();
const VERSION = "0.4.3";

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
    hackathon: {
      active: config.hackathonMode && new Date() < new Date(config.hackathonEnd),
      deadline: config.hackathonEnd,
    },
  };
}

export function getVersion() {
  return {
    version: VERSION,
    name: "AgentOS",
    build: process.env.BUILD_SHA || "dev",
    nodeVersion: process.version,
  };
}
