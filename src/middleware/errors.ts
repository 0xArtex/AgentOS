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
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ 
    error: "Not Found",
    message: `No endpoint matches ${req.method} ${req.path}`,
    hint: "Check /docs for available endpoints, or /api for service info",
    availableRoutes: [
      "GET  /api",
      "GET  /health",
      "GET  /pricing",
      "GET  /hackathon/status",
      "GET  /stats",
      "GET  /skill.md",
      "GET  /docs",
      "POST /agents/register",
      "POST /phone/numbers",
      "POST /email/inboxes",
      "POST /compute/servers",
      "POST /messages/send",
      "GET  /demo/provision-phone",
    ]
  });
}
