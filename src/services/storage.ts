import { PhoneNumber, SmsMessage, EmailInbox, EmailMessage, Domain, DnsRecord, Server, ApiKey } from "../types";

/**
 * In-memory storage with a clean interface for future DB migration.
 * Each collection is a Map keyed by entity ID.
 */
class Storage {
  // ── Phone ─────────────────────────────────────────────────
  private phoneNumbers = new Map<string, PhoneNumber>();
  private smsMessages = new Map<string, SmsMessage[]>();

  setPhoneNumber(id: string, record: PhoneNumber): void { this.phoneNumbers.set(id, record); }
  getPhoneNumber(id: string): PhoneNumber | undefined { return this.phoneNumbers.get(id); }
  findPhoneByNumber(phoneNumber: string): [string, PhoneNumber] | undefined {
    for (const [id, num] of this.phoneNumbers) {
      if (num.phoneNumber === phoneNumber) return [id, num];
    }
    return undefined;
  }

  initSmsMessages(phoneNumberId: string): void { this.smsMessages.set(phoneNumberId, []); }
  getSmsMessages(phoneNumberId: string): SmsMessage[] | undefined { return this.smsMessages.get(phoneNumberId); }
  pushSmsMessage(phoneNumberId: string, msg: SmsMessage): void { this.smsMessages.get(phoneNumberId)?.push(msg); }

  // ── Email ─────────────────────────────────────────────────
  private emailInboxes = new Map<string, EmailInbox>();
  private emailMessages = new Map<string, EmailMessage[]>();
  private emailAddressIndex = new Map<string, string>(); // localPart → inbox ID

  setEmailInbox(id: string, inbox: EmailInbox): void {
    this.emailInboxes.set(id, inbox);
    this.emailAddressIndex.set(inbox.localPart, id);
  }
  getEmailInbox(id: string): EmailInbox | undefined { return this.emailInboxes.get(id); }
  getEmailInboxByLocalPart(localPart: string): string | undefined { return this.emailAddressIndex.get(localPart); }
  hasEmailLocalPart(localPart: string): boolean { return this.emailAddressIndex.has(localPart); }

  initEmailMessages(inboxId: string): void { this.emailMessages.set(inboxId, []); }
  getEmailMessages(inboxId: string): EmailMessage[] | undefined { return this.emailMessages.get(inboxId); }
  pushEmailMessage(inboxId: string, msg: EmailMessage): void { this.emailMessages.get(inboxId)?.push(msg); }

  // ── Domains ───────────────────────────────────────────────
  private domains = new Map<string, Domain>();

  setDomain(id: string, domain: Domain): void { this.domains.set(id, domain); }
  getDomain(id: string): Domain | undefined { return this.domains.get(id); }
  findDomainByName(name: string): Domain | undefined {
    for (const d of this.domains.values()) {
      if (d.domain === name) return d;
    }
    return undefined;
  }
  // ── Compute ────────────────────────────────────────────────
  private servers = new Map<string, Server>();

  setServer(id: string, server: Server): void { this.servers.set(id, server); }
  getServer(id: string): Server | undefined { return this.servers.get(id); }
  deleteServer(id: string): void { this.servers.delete(id); }
  listServers(owner?: string): Server[] {
    const all = Array.from(this.servers.values());
    return owner ? all.filter((s) => s.owner === owner) : all;
  }

  // ── API Keys ──────────────────────────────────────────────
  private apiKeys = new Map<string, ApiKey>();

  setApiKey(id: string, key: ApiKey): void { this.apiKeys.set(id, key); }
  getApiKey(id: string): ApiKey | undefined { return this.apiKeys.get(id); }
  listApiKeys(owner?: string): ApiKey[] {
    const all = Array.from(this.apiKeys.values()).filter((k) => k.active);
    return owner ? all.filter((k) => k.owner === owner) : all;
  }
}

/** Singleton storage instance */
export const storage = new Storage();
