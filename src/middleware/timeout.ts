import { Request, Response, NextFunction } from "express";

/**
 * Request timeout middleware — returns 408 if request takes too long.
 */
export function requestTimeout(ms: number = 30_000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timer = setTimeout(() => {
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
