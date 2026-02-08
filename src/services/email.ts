import sgMail from "@sendgrid/mail";
import { v4 as uuid } from "uuid";
import { config } from "../config";
import { EmailInbox, EmailMessage } from "../types";
import { storage } from "./storage";

function initSendGrid(): void {
  if (!config.sendgridApiKey) {
    throw new Error("SendGrid not configured — set SENDGRID_API_KEY");
  }
  sgMail.setApiKey(config.sendgridApiKey);
}

/**
 * Create a new email inbox for an agent.
 * Address format: {name}@{EMAIL_DOMAIN}
 */
export function createInbox(name: string, owner: string): EmailInbox {
  const localPart = name.toLowerCase().replace(/[^a-z0-9\-_.]/g, "");
  if (!localPart) throw new Error("Invalid inbox name");

  const address = `${localPart}@${config.emailDomain}`;

  if (storage.hasEmailLocalPart(localPart)) {
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

  storage.setEmailInbox(inbox.id, inbox);
  storage.initEmailMessages(inbox.id);

  return inbox;
}

/**
 * Get all messages for an inbox.
 */
export function getMessages(inboxId: string): EmailMessage[] {
  const msgs = storage.getEmailMessages(inboxId);
  if (!msgs) throw new Error(`Inbox ${inboxId} not found`);
  return msgs;
}

/**
 * Send an email from an inbox via SendGrid.
 */
export async function sendEmail(
  inboxId: string,
  to: string,
  subject: string,
  body: string,
  html?: string
): Promise<EmailMessage> {
  const inbox = storage.getEmailInbox(inboxId);
  if (!inbox) throw new Error(`Inbox ${inboxId} not found`);
  if (!inbox.active) throw new Error("Inbox is deactivated");

  initSendGrid();

  await sgMail.send({
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

  storage.pushEmailMessage(inboxId, msg);
  return msg;
}

/**
 * Handle inbound email from SendGrid Inbound Parse webhook.
 * SendGrid POSTs multipart form data with fields: to, from, subject, text, html, etc.
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
  const inboxId = storage.getEmailInboxByLocalPart(localPart);
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

  storage.pushEmailMessage(inboxId, msg);
  return msg;
}

/**
 * Get an inbox by ID.
 */
export function getInbox(id: string): EmailInbox | undefined {
  return storage.getEmailInbox(id);
}
