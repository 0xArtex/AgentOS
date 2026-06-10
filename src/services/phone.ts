import Telnyx from "telnyx";
import { v4 as uuid } from "uuid";
import { config } from "../config";
import { PhoneNumber, SmsMessage } from "../types";
import { storage } from "./storage";

let _client: InstanceType<typeof Telnyx> | null = null;

function getClient(): InstanceType<typeof Telnyx> {
  if (!config.telnyxApiKey) {
    throw new Error("Telnyx API key not configured — set TELNYX_API_KEY");
  }
  if (!_client) {
    _client = new Telnyx({ apiKey: config.telnyxApiKey });
  }
  return _client;
}

/**
 * Search for available phone numbers.
 */
export async function searchNumbers(
  country: string,
  opts?: { areaCode?: string; limit?: number }
): Promise<Array<{ phoneNumber: string; region: string; type: string }>> {
  const client = getClient();
  const params: any = {
    "filter[country_code]": country,
    "filter[limit]": opts?.limit ?? 5,
  };
  if (opts?.areaCode) {
    params["filter[national_destination_code]"] = opts.areaCode;
  }

  const res = await client.availablePhoneNumbers.list(params);
  const numbers = (res as any).data || [];
  return numbers.map((n: any) => ({
    phoneNumber: n.phone_number,
    region: n.region_information?.[0]?.region_name || country,
    type: n.phone_number_type || "local",
  }));
}

/**
 * Provision (purchase) a phone number for an agent.
 */
export async function provisionNumber(
  country: string,
  owner: string,
  areaCode?: string
): Promise<PhoneNumber> {
  const client = getClient();

  // 1. Search for available numbers — prefer local over toll_free to avoid
  //    Telnyx's "freemail account" restriction on toll-free orders.
  const available = await searchNumbers(country, { areaCode, limit: 10 });
  if (available.length === 0) {
    throw new Error(
      `No available numbers in ${country}${areaCode ? ` (area code ${areaCode})` : ""}`
    );
  }

  // Prefer local numbers; fall back to whatever's available
  const local = available.find(n => n.type !== "toll_free" && n.type !== "tollfree");
  const chosen = (local || available[0]).phoneNumber;

  // 2. Create a number order to purchase
  const order = await client.numberOrders.create({
    phone_numbers: [{ phone_number: chosen }],
    messaging_profile_id: config.telnyxMessagingProfileId || undefined,
  } as any);

  const orderData = (order as any).data || order;
  const status = orderData.status;

  if (status !== "success" && status !== "pending") {
    throw new Error(`Number order failed with status: ${status}`);
  }

  // 3. If we have a messaging profile, assign it
  if (config.telnyxMessagingProfileId) {
    try {
      await client.phoneNumbers.update(chosen, {
        messaging_profile_id: config.telnyxMessagingProfileId,
      } as any);
    } catch (e: any) {
      console.warn("[phone] Could not assign messaging profile:", e.message);
    }
  }

  // 4. Store locally
  const record: PhoneNumber = {
    id: uuid(),
    phoneNumber: chosen,
    country,
    owner,
    provisionedAt: new Date().toISOString(),
    active: true,
  };

  storage.setPhoneNumber(record.id, record);
  storage.initSmsMessages(record.id);

  return record;
}

/**
 * True when `wallet` may use this number — the owner or a wallet the owner
 * shared it with. Owner-only actions (release, transfer, share) must check
 * `number.owner` directly instead.
 */
export function hasNumberAccess(number: PhoneNumber, wallet: string): boolean {
  return number.owner === wallet || (number.sharedWith || []).includes(wallet);
}

/**
 * Get all messages for a phone number. Access scope is enforced — callers
 * must present their identity; we refuse to return messages for a number
 * they neither own nor have shared access to.
 */
export function getMessages(phoneNumberId: string, owner?: string): SmsMessage[] {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  if (owner && number.owner && !hasNumberAccess(number, owner)) {
    const err = new Error(`You do not have access to phone number ${phoneNumberId}`);
    (err as any).statusCode = 403;
    throw err;
  }
  const msgs = storage.getSmsMessages(phoneNumberId);
  if (!msgs) throw new Error(`Phone number ${phoneNumberId} not found`);
  return msgs;
}


/**
 * Send an SMS from a provisioned number.
 *
 * Hard 25s ceiling on the Telnyx call. Without this, an unresponsive Telnyx
 * leaves the request hanging until Cloudflare's edge times out and returns
 * 502 HTML to the client — at which point the CLI shows
 * "Payment was submitted but server returned 502 ... with non-JSON body" and
 * the user has no idea whether they were charged. With the timeout we surface
 * a JSON error fast, which triggers the route's `refundAndRespond` path.
 */
const TELNYX_SMS_TIMEOUT_MS = 25_000;

export async function sendSms(
  phoneNumberId: string,
  to: string,
  body: string
): Promise<SmsMessage> {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  if (!number.active) throw new Error("Phone number is deactivated");

  const client = getClient();

  const sendPromise = client.messages.send({
    from: number.phoneNumber,
    to,
    text: body,
    messaging_profile_id: config.telnyxMessagingProfileId || undefined,
  } as any);

  const res = await Promise.race([
    sendPromise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Telnyx SMS send timed out after ${TELNYX_SMS_TIMEOUT_MS / 1000}s`)),
        TELNYX_SMS_TIMEOUT_MS,
      ),
    ),
  ]);

  const msgData = (res as any).data || res;

  const msg: SmsMessage = {
    id: msgData.id || uuid(),
    phoneNumberId,
    direction: "outbound",
    from: number.phoneNumber,
    to,
    body,
    timestamp: new Date().toISOString(),
  };

  storage.pushSmsMessage(phoneNumberId, msg);
  return msg;
}

/**
 * Get a single SMS message by id (regardless of which phone number owns it).
 * Returns undefined when not found.
 */
export function getMessage(id: string): SmsMessage | undefined {
  return storage.getSmsMessage(id);
}

/**
 * Apply a Telnyx-supplied delivery status update to an outbound SMS. No-op
 * if the id doesn't match (row purged before the webhook arrived, or the
 * message isn't ours).
 */
export function updateOutboundDeliveryStatus(
  id: string,
  status: NonNullable<SmsMessage["deliveryStatus"]>,
  providerError?: string,
): void {
  storage.updateSmsDeliveryStatus(id, status, providerError);
}

/**
 * Handle inbound SMS webhook from Telnyx.
 * Telnyx sends webhooks as { data: { event_type, payload } }
 */
export function handleInboundSms(from: string, to: string, body: string): void {
  const found = storage.findPhoneByNumber(to);
  if (!found) {
    console.warn(`[phone] Inbound SMS to unknown number: ${to}`);
    return;
  }
  const [id] = found;
  const msg: SmsMessage = {
    id: uuid(),
    phoneNumberId: id,
    direction: "inbound",
    from,
    to,
    body,
    timestamp: new Date().toISOString(),
  };
  storage.pushSmsMessage(id, msg);
  console.log(`[phone] Inbound SMS stored: ${from} → ${to}`);
}

/**
 * Get a phone number by ID.
 */
export function getNumber(id: string): PhoneNumber | undefined {
  return storage.getPhoneNumber(id);
}

/**
 * List all phone numbers a wallet owns or has shared access to.
 */
export function listNumbers(wallet: string): PhoneNumber[] {
  return storage.getPhoneNumbersByWallet(wallet);
}

/**
 * Move a number to a new owner. Clears sharedWith — the previous owner's
 * collaborators don't travel with the number.
 */
export function transferNumber(phoneNumberId: string, newOwner: string): PhoneNumber {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  number.owner = newOwner;
  number.sharedWith = [];
  storage.setPhoneNumber(phoneNumberId, number);
  return number;
}

/** Grant a wallet shared use of a number (idempotent). Returns the updated list. */
export function shareNumber(phoneNumberId: string, wallet: string): string[] {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  const current = number.sharedWith || [];
  number.sharedWith = current.includes(wallet) ? current : [...current, wallet];
  storage.setPhoneNumber(phoneNumberId, number);
  return number.sharedWith;
}

/** Revoke a wallet's shared use of a number. Returns the updated list. */
export function unshareNumber(phoneNumberId: string, wallet: string): string[] {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  number.sharedWith = (number.sharedWith || []).filter(w => w !== wallet);
  storage.setPhoneNumber(phoneNumberId, number);
  return number.sharedWith;
}

/**
 * Delete/release a phone number.
 */
export async function deleteNumber(phoneNumberId: string): Promise<void> {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);

  const client = getClient();

  try {
    await client.phoneNumbers.delete(number.phoneNumber);
  } catch (e: any) {
    console.warn("[phone] Could not release number from Telnyx:", e.message);
  }

  // Mark inactive locally
  number.active = false;
  storage.setPhoneNumber(phoneNumberId, number);
}
