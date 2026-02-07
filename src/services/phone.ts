import twilio from "twilio";
import { v4 as uuid } from "uuid";
import { config } from "../config";
import { PhoneNumber, SmsMessage } from "../types";

// In-memory store — replace with a database in production
const numbers = new Map<string, PhoneNumber>();
const messages = new Map<string, SmsMessage[]>();

function getClient(): twilio.Twilio {
  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    throw new Error("Twilio credentials not configured");
  }
  return twilio(config.twilioAccountSid, config.twilioAuthToken);
}

/**
 * Provision a new phone number for an agent.
 */
export async function provisionNumber(
  country: string,
  owner: string,
  areaCode?: string
): Promise<PhoneNumber> {
  const client = getClient();

  // Search for available numbers
  const searchParams: any = { limit: 1 };
  if (areaCode) searchParams.areaCode = areaCode;

  const available = await client
    .availablePhoneNumbers(country)
    .local.list(searchParams);

  if (available.length === 0) {
    throw new Error(`No available numbers in ${country}${areaCode ? ` (area code ${areaCode})` : ""}`);
  }

  // Purchase the number
  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    // TODO: Set SMS webhook URL for inbound messages
    // smsUrl: `${BASE_URL}/webhooks/twilio/sms`,
  });

  const record: PhoneNumber = {
    id: uuid(),
    phoneNumber: purchased.phoneNumber,
    country,
    owner,
    provisionedAt: new Date().toISOString(),
    active: true,
  };

  numbers.set(record.id, record);
  messages.set(record.id, []);

  return record;
}

/**
 * Get all messages for a phone number.
 */
export function getMessages(phoneNumberId: string): SmsMessage[] {
  const msgs = messages.get(phoneNumberId);
  if (!msgs) throw new Error(`Phone number ${phoneNumberId} not found`);
  return msgs;
}

/**
 * Send an SMS from a provisioned number.
 */
export async function sendSms(
  phoneNumberId: string,
  to: string,
  body: string
): Promise<SmsMessage> {
  const number = numbers.get(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  if (!number.active) throw new Error("Phone number is deactivated");

  const client = getClient();

  await client.messages.create({
    from: number.phoneNumber,
    to,
    body,
  });

  const msg: SmsMessage = {
    id: uuid(),
    phoneNumberId,
    direction: "outbound",
    from: number.phoneNumber,
    to,
    body,
    timestamp: new Date().toISOString(),
  };

  messages.get(phoneNumberId)!.push(msg);
  return msg;
}

/**
 * Handle inbound SMS webhook from Twilio.
 */
export function handleInboundSms(from: string, to: string, body: string): void {
  // Find the number record by phone number
  for (const [id, num] of numbers) {
    if (num.phoneNumber === to) {
      const msg: SmsMessage = {
        id: uuid(),
        phoneNumberId: id,
        direction: "inbound",
        from,
        to,
        body,
        timestamp: new Date().toISOString(),
      };
      messages.get(id)?.push(msg);
      return;
    }
  }
  console.warn(`[phone] Inbound SMS to unknown number: ${to}`);
}

/**
 * Get a phone number by ID.
 */
export function getNumber(id: string): PhoneNumber | undefined {
  return numbers.get(id);
}
