import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router({ mergeParams: true });

/**
 * GET /stats — Platform-wide analytics (public)
 */
router.get("/", (_req: Request, res: Response) => {
  const agents = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
  const phones = (db.prepare("SELECT COUNT(*) as c FROM phone_numbers").get() as any).c;
  const emails = (db.prepare("SELECT COUNT(*) as c FROM email_inboxes").get() as any).c;
  const servers = (db.prepare("SELECT COUNT(*) as c FROM servers").get() as any).c;
  const domains = (db.prepare("SELECT COUNT(*) as c FROM domains").get() as any).c;
  const smsTotal = (db.prepare("SELECT COUNT(*) as c FROM sms_messages").get() as any).c;
  const emailTotal = (db.prepare("SELECT COUNT(*) as c FROM email_messages").get() as any).c;

  // Last 24h activity
  const sms24h = (
    db.prepare(
      "SELECT COUNT(*) as c FROM sms_messages WHERE timestamp > datetime('now', '-24 hours')"
    ).get() as any
  ).c;
  const email24h = (
    db.prepare(
      "SELECT COUNT(*) as c FROM email_messages WHERE timestamp > datetime('now', '-24 hours')"
    ).get() as any
  ).c;
  const requests24h = (
    db.prepare(
      "SELECT COUNT(*) as c FROM request_log WHERE created_at > datetime('now', '-24 hours')"
    ).get() as any
  ).c;

  // Hackathon stats
  const hackathonAgents = (
    db.prepare("SELECT COUNT(DISTINCT agent_id) as c FROM hackathon_usage").get() as any
  ).c;

  res.json({
    platform: {
      registeredAgents: agents,
      totalResources: {
        phoneNumbers: phones,
        emailInboxes: emails,
        servers,
        domains,
      },
      totalMessages: {
        sms: smsTotal,
        email: emailTotal,
      },
    },
    last24h: {
      smsMessages: sms24h,
      emailMessages: email24h,
      apiRequests: requests24h,
    },
    hackathon: {
      uniqueAgents: hackathonAgents,
    },
    uptime: process.uptime(),
    version: "0.4.3",
  });
});

/**
 * GET /stats/requests — Request analytics breakdown
 */
router.get("/requests", (req: Request, res: Response) => {
  const hours = Math.min(Number(req.query.hours) || 24, 168); // max 7 days

  const byEndpoint = db
    .prepare(
      `SELECT endpoint, method, COUNT(*) as count, 
       AVG(response_time_ms) as avg_response_ms,
       SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END) as success,
       SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
       FROM request_log 
       WHERE created_at > datetime('now', '-${hours} hours')
       GROUP BY endpoint, method
       ORDER BY count DESC`
    )
    .all();

  const byPaymentType = db
    .prepare(
      `SELECT payment_type, COUNT(*) as count, 
       COALESCE(SUM(CAST(cost_usdc AS REAL)), 0) as total_usdc
       FROM request_log 
       WHERE created_at > datetime('now', '-${hours} hours')
       GROUP BY payment_type`
    )
    .all();

  const hourly = db
    .prepare(
      `SELECT strftime('%Y-%m-%d %H:00', created_at) as hour, COUNT(*) as count
       FROM request_log 
       WHERE created_at > datetime('now', '-${hours} hours')
       GROUP BY hour
       ORDER BY hour`
    )
    .all();

  res.json({
    period: `${hours}h`,
    byEndpoint,
    byPaymentType,
    hourlyDistribution: hourly,
  });
});

export default router;
