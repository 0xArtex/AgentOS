import nodemailer from "nodemailer";
import { v4 as uuid } from "uuid";
import { config } from "../config";
import { EmailInbox, EmailMessage } from "../types";

// In-memory store — replace with a database in production
const inboxes = new Map<string, EmailInbox>();
const messages = new Map<string, EmailMessage[]>();

/** Lookup table: local-part → inbox ID */
const addressIndex = new Map<string, string>();

function getTransporter(): nodemailer.Transporter {
  if (!config.smtpHost) {
    throw new Error("SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS");
  }
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });
}

/**
 * Create a new email inbox for an agent.
 * Address format: {name}@{EMAIL_DOMAIN}
 */
export function createInbox(name: string, owner: string): EmailInbox {
  const localPart = name.toLowerCase().replace(/[^a-z0-9\-_.]/g, "");
  if (!localPart) throw new Error("Invalid inbox name");

  const address = `${localPart}@${config.emailDomain}`;

  if (addressIndex.has(localPart)) {
    throw new Error(`Inbox ${address} already exists`);
  }

  const inbox: EmailInbox = {
    id: uuid(),
    address,
    localPart,
    owner,
    createdAt: new Date().toISOString(),
    active: true,
  };

  inboxes.set(inbox.id, inbox);
  messages.set(inbox.id, []);
  addressIndex.set(localPart, inbox.id);

  return inbox;
}

/**
 * Get all messages for an inbox.
 */
export function getMessages(inboxId: string): EmailMessage[] {
  const msgs = messages.get(inboxId);
  if (!msgs) throw new Error(`Inbox ${inboxId} not found`);
  return msgs;
}

/**
 * Send an email from an inbox.
 */
export async function sendEmail(
  inboxId: string,
  to: string,
  subject: string,
  body: string,
  html?: string
): Promise<EmailMessage> {
  const inbox = inboxes.get(inboxId);
  if (!inbox) throw new Error(`Inbox ${inboxId} not found`);
  if (!inbox.active) throw new Error("Inbox is deactivated");

  const transporter = getTransporter();

  await transporter.sendMail({
    from: inbox.address,
    to,
    subject,
    text: body,
    html: html ?? undefined,
  });

  const msg: EmailMessage = {
    id: uuid(),
    inboxId,
    direction: "outbound",
    from: inbox.address,
    to,
    subject,
    body,
    html,
    timestamp: new Date().toISOString(),
  };

  messages.get(inboxId)!.push(msg);
  return msg;
}

/**
 * Handle inbound email from webhook (Mailgun, SendGrid, etc.)
 * Call this from your webhook endpoint.
 */
export function handleInboundEmail(
  to: string,
  from: string,
  subject: string,
  body: string,
  html?: string
): EmailMessage | null {
  // Extract local part from the To address
  const match = to.match(/^([^@]+)@/);
  if (!match) return null;

  const localPart = match[1].toLowerCase();
  const inboxId = addressIndex.get(localPart);
  if (!inboxId) {
    console.warn(`[email] Inbound email to unknown address: ${to}`);
    return null;
  }

  const msg: EmailMessage = {
    id: uuid(),
    inboxId,
    direction: "inbound",
    from,
    to,
    subject,
    body,
    html,
    timestamp: new Date().toISOString(),
  };

  messages.get(inboxId)?.push(msg);
  return msg;
}

/**
 * Get an inbox by ID.
 */
export function getInbox(id: string): EmailInbox | undefined {
  return inboxes.get(id);
}
