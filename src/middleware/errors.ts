import { Request, Response, NextFunction } from "express";

/**
 * Global error handling middleware.
 */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  console.error("[error]", err.message || err);

  // JSON parse errors
  if (err.type === "entity.parse.failed") {
    res.status(400).json({
      error: "Invalid JSON",
      message: "The request body contains invalid JSON",
      hint: "Check your JSON syntax — missing quotes, trailing commas, etc.",
    });
    return;
  }

  // Payload too large
  if (err.type === "entity.too.large") {
    res.status(413).json({
      error: "Payload Too Large",
      message: err.limit
        ? `Request body exceeds the ${Math.round(err.limit / 1024)}KB limit for this endpoint`
        : "Request body exceeds the size limit for this endpoint",
      hint: "Reduce the size of your request body",
    });
    return;
  }

  // Known operational errors
  if (err.status || err.statusCode) {
    const code = err.status || err.statusCode;
    res.status(code).json({
      error: err.name || "Request Failed",
      message: err.message || "An error occurred",
      ...(code >= 500 && { hint: "This is a server-side issue. Try again shortly." }),
    });
    return;
  }

  // Default: internal server error
  res.status(500).json({
    error: "Internal Server Error",
    message: "Something went wrong on our end",
    hint: "Try again. If the issue persists, check /health for system status.",
  });
}

/**
 * 404 handler for unmatched routes.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ 
    error: "Not Found",
    message: `No endpoint matches ${req.method} ${req.path}`,
    hint: "Check /docs for available endpoints, or GET /api for service info",
    availableRoutes: [
      "GET  /api",
      "GET  /health",
      "GET  /version",
      "GET  /pricing",
      "GET  /hackathon/status",
      "GET  /stats",
      "GET  /activity",
      "GET  /skill.md",
      "GET  /docs",
      "POST /agents/register",
      "GET  /agents/:id",
      "POST /phone/numbers",
      "POST /email/inboxes",
      "POST /compute/servers",
      "POST /messages/send",
      "GET  /demo/phone",
    ]
  });
}
