import { Request, Response, NextFunction } from "express";

/**
 * Global error handling middleware.
 * Must be registered after all routes.
 */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  console.error("[error]", err);

  // Known operational errors
  if (err.status || err.statusCode) {
    res.status(err.status || err.statusCode).json({
      error: err.message || "Request failed",
    });
    return;
  }

  // Validation / bad input
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON in request body" });
    return;
  }

  // Default: internal server error
  res.status(500).json({
    error: "Internal server error",
    ...(process.env.NODE_ENV === "development" && { detail: err.message }),
  });
}

/**
 * 404 handler for unmatched routes.
 */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found" });
}
