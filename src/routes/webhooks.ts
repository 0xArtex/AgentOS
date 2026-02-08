import { Router, Request, Response } from "express";
import crypto from "crypto";
import { config } from "../config";
import { db } from "../db";

const router = Router();

/**
 * Verify Twilio webhook signature
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
function verifyTwilioSignature(req: Request): boolean {
  if (!config.twilioWebhookSecret) {
    console.warn("⚠️  TWILIO_WEBHOOK_SECRET not configured, skipping signature verification");
    return true; // Allow in development/testing
  }

  const signature = req.headers['x-twilio-signature'] as string;
  if (!signature) {
    return false;
  }

  const url = `${req.protocol}://${req.get('Host')}${req.originalUrl}`;
  const body = JSON.stringify(req.body);
  
  const expectedSignature = crypto
    .createHmac('sha1', config.twilioWebhookSecret)
    .update(url + body)
    .digest('base64');

  return signature === expectedSignature;
}

/**
 * Verify SendGrid webhook signature 
 * https://docs.sendgrid.com/for-developers/tracking-events/getting-started-event-webhook-security-features
 */
function verifySendGridSignature(req: Request): boolean {
  if (!config.sendgridWebhookSecret) {
    console.warn("⚠️  SENDGRID_WEBHOOK_SECRET not configured, skipping signature verification");
    return true; // Allow in development/testing
  }

  const signature = req.headers['x-twilio-email-event-webhook-signature'] as string;
  if (!signature) {
    return false;
  }

  const timestamp = req.headers['x-twilio-email-event-webhook-timestamp'] as string;
  if (!timestamp) {
    return false;
  }

  const payload = timestamp + JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', config.sendgridWebhookSecret)
    .update(payload, 'utf8')
    .digest('base64');

  return signature === expectedSignature;
}

/**
 * POST /webhooks/twilio/sms — Handle inbound SMS from Twilio
 */
router.post("/twilio/sms", (req: Request, res: Response) => {
  try {
    // Verify webhook signature for security
    if (!verifyTwilioSignature(req)) {
      console.warn("❌ Invalid Twilio webhook signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const {
      MessageSid,
      From,
      To,
      Body,
      NumMedia,
      MediaUrl0,
      MediaContentType0
    } = req.body;

    console.log(`📱 Inbound SMS: ${From} → ${To}: ${Body}`);

    // Store the message in database
    const stmt = db.prepare(`
      INSERT INTO inbound_sms (
        twilio_sid, from_number, to_number, body, 
        media_count, media_url, media_type, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      MessageSid,
      From,
      To,
      Body || "",
      parseInt(NumMedia || "0"),
      MediaUrl0 || null,
      MediaContentType0 || null,
      new Date().toISOString()
    );

    console.log(`✅ Stored inbound SMS in database: ${MessageSid}`);

    // Respond with TwiML (optional - for auto-reply)
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Message received by AgentOS</Message>
</Response>`);

  } catch (error: any) {
    console.error("❌ Error processing inbound SMS:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /webhooks/sendgrid/inbound — Handle inbound email from SendGrid Inbound Parse
 */
router.post("/sendgrid/inbound", (req: Request, res: Response) => {
  try {
    // Verify webhook signature for security
    if (!verifySendGridSignature(req)) {
      console.warn("❌ Invalid SendGrid webhook signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const {
      from,
      to,
      subject,
      text,
      html,
      attachments
    } = req.body;

    console.log(`📧 Inbound Email: ${from} → ${to}: ${subject}`);

    // Store the email in database
    const stmt = db.prepare(`
      INSERT INTO inbound_emails (
        from_address, to_address, subject, text_body, 
        html_body, attachment_count, raw_data, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      from,
      to,
      subject || "(no subject)",
      text || "",
      html || "",
      attachments ? parseInt(attachments) : 0,
      JSON.stringify(req.body),
      new Date().toISOString()
    );

    console.log(`✅ Stored inbound email in database from ${from}`);

    res.status(200).json({ status: "received" });

  } catch (error: any) {
    console.error("❌ Error processing inbound email:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /webhooks/test — Simple test endpoint for webhook debugging
 */
router.get("/test", (_req: Request, res: Response) => {
  res.json({ 
    status: "ok", 
    message: "Webhook endpoint is working",
    timestamp: new Date().toISOString()
  });
});

export default router;