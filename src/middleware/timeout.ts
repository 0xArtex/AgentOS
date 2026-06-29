import { Request, Response, NextFunction } from "express";

/**
 * Request timeout middleware — replies 408 if the request outlives `ms`.
 *
 * WHAT THIS CAN AND CANNOT DO — read before relying on it:
 * Node/Express has no preemption: a JavaScript handler that is mid-execution
 * cannot be forcibly cancelled from here, and we do not (and must not, from this
 * generic layer) reach into every upstream SDK call. So firing 408 does NOT by
 * itself stop the work already in flight (Telnyx / Mailgun / Namecheap / Hetzner
 * etc.) — that work keeps running until it finishes or its own call returns.
 *
 * What we DO provide so a timeout can actually free resources:
 *   • `req.timedOut` is set true, and an `AbortController` is aborted, on expiry.
 *   • `req.timeoutSignal` exposes that controller's signal. Any handler or
 *     upstream call that opts in — `fetch(url, { signal: req.timeoutSignal })`,
 *     or an early `if (req.timedOut) return;` before a second expensive step —
 *     will then bail out and release its connection instead of running to
 *     completion behind an already-answered request.
 *
 * The 408 body is still sent (once, guarded by headersSent) so the client gets a
 * definitive answer rather than hanging. The timer is cleared on finish/close so
 * a completed request never trips it.
 */

// Express's Request type has no slot for these; declare them so callers get
// types instead of reaching through `any`.
declare module "express-serve-static-core" {
  interface Request {
    timedOut?: boolean;
    timeoutSignal?: AbortSignal;
  }
}

export function requestTimeout(ms: number = 30_000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const controller = new AbortController();
    req.timeoutSignal = controller.signal;

    const timer = setTimeout(() => {
      req.timedOut = true;
      // Signal any opted-in upstream call / handler step to abort and free its
      // resources. Cannot force-cancel work that ignores the signal.
      controller.abort();
      if (!res.headersSent) {
        res.status(408).json({
          error: "Request Timeout",
          message: `Request exceeded ${ms / 1000}s time limit`,
          hint: "Try again with a simpler request, or check /health for system status",
        });
      }
    }, ms);

    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));

    next();
  };
}
