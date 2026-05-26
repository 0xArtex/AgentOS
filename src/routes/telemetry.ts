import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

const MAX_EVENTS_PER_REQUEST = 100;
const MAX_STR = 128;
const MAX_LONG_STR = 256;

interface IncomingEvent {
  installId?: unknown;
  cmd?: unknown;
  exitCode?: unknown;
  durationMs?: unknown;
  cliVersion?: unknown;
  nodeVersion?: unknown;
  platform?: unknown;
  ts?: unknown;
}

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function cleanInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

/**
 * POST /telemetry
 *
 * Opt-in batched events from the CLI. No auth — callers identify themselves
 * by an anonymous installId they generated locally. We trust the body but
 * cap everything: per-request event count, per-field length, integer ranges.
 *
 * Returns 204 on success. The CLI deletes its local queue only on 2xx, so
 * a transient failure here just means the events stay queued and retry next
 * run. Don't return 5xx for partial failures — silently skip bad events.
 */
router.post("/", (req: Request, res: Response) => {
  const body = req.body;
  if (!body || !Array.isArray(body.events)) {
    return res.status(400).json({ error: "expected { events: [...] }" });
  }
  const events: IncomingEvent[] = body.events.slice(0, MAX_EVENTS_PER_REQUEST);

  const insert = db.prepare(
    `INSERT INTO cli_events (install_id, cmd, exit_code, duration_ms,
                             cli_version, node_version, platform, client_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let accepted = 0;
  const tx = db.transaction((rows: IncomingEvent[]) => {
    for (const ev of rows) {
      const installId = clean(ev.installId, 64);
      const cmd = clean(ev.cmd, MAX_STR);
      if (!installId || !cmd) continue;
      const exitCode = cleanInt(ev.exitCode);
      const durationMs = cleanInt(ev.durationMs);
      insert.run(
        installId,
        cmd,
        exitCode,
        durationMs,
        clean(ev.cliVersion, 64),
        clean(ev.nodeVersion, 64),
        clean(ev.platform, 32),
        clean(ev.ts, MAX_LONG_STR),
      );
      accepted++;
    }
  });

  try {
    tx(events);
  } catch (e: any) {
    return res.status(500).json({ error: "telemetry insert failed", message: e?.message });
  }

  res.status(204).end();
});

export default router;
