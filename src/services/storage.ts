import { PhoneNumber, SmsMessage, EmailInbox, EmailMessage, Domain, DnsRecord, Server, ApiKey } from "../types";
import { db } from "../db";

function rowToPhoneNumber(row: any): PhoneNumber {
  let sharedWith: string[] = [];
  try {
    const parsed = JSON.parse(row.shared_with || "[]");
    if (Array.isArray(parsed)) sharedWith = parsed.filter((w: any) => typeof w === "string");
  } catch { /* malformed column — treat as unshared */ }
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    country: row.country,
    owner: row.owner,
    provisionedAt: row.provisioned_at,
    active: Boolean(row.active),
    sharedWith,
  };
}

function rowToSmsMessage(row: any): SmsMessage {
  return {
    id: row.id,
    phoneNumberId: row.phone_number_id,
    direction: row.direction as "inbound" | "outbound",
    from: row.from_number,
    to: row.to_number,
    body: row.body,
    timestamp: row.timestamp,
    ...(row.delivery_status ? { deliveryStatus: row.delivery_status as NonNullable<SmsMessage["deliveryStatus"]> } : {}),
    ...(row.delivery_updated_at ? { deliveryUpdatedAt: row.delivery_updated_at } : {}),
    ...(row.provider_error ? { providerError: row.provider_error } : {}),
  };
}

/**
 * SQLite-backed storage with a clean interface.
 * Each collection is stored in SQLite tables.
 */
class Storage {
  // ── Phone ─────────────────────────────────────────────────

  setPhoneNumber(id: string, record: PhoneNumber): void {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO phone_numbers (id, phone_number, country, owner, provisioned_at, active, shared_with)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, record.phoneNumber, record.country, record.owner, record.provisionedAt, record.active ? 1 : 0, JSON.stringify(record.sharedWith || []));
  }

  getPhoneNumber(id: string): PhoneNumber | undefined {
    const stmt = db.prepare('SELECT * FROM phone_numbers WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return rowToPhoneNumber(row);
  }

  /** Numbers the wallet owns OR has shared access to. The LIKE pre-filters
   *  by substring (SQLite can't query JSON arrays natively); the JS filter
   *  is the authority. */
  getPhoneNumbersByWallet(wallet: string): PhoneNumber[] {
    const stmt = db.prepare(`
      SELECT * FROM phone_numbers
      WHERE owner = ? OR shared_with LIKE ?
      ORDER BY provisioned_at DESC
    `);
    const rows = stmt.all(wallet, `%${wallet}%`) as any[];
    return rows
      .map(rowToPhoneNumber)
      .filter(n => n.owner === wallet || (n.sharedWith || []).includes(wallet));
  }

  findPhoneByNumber(phoneNumber: string): [string, PhoneNumber] | undefined {
    const stmt = db.prepare('SELECT * FROM phone_numbers WHERE phone_number = ?');
    const row = stmt.get(phoneNumber) as any;
    if (!row) return undefined;
    return [row.id, rowToPhoneNumber(row)];
  }

  initSmsMessages(phoneNumberId: string): void {
    // No explicit initialization needed for SQLite
    // Messages will be inserted as they come
  }

  getSmsMessages(phoneNumberId: string): SmsMessage[] | undefined {
    const stmt = db.prepare(`
      SELECT * FROM sms_messages
      WHERE phone_number_id = ?
      ORDER BY timestamp DESC
    `);
    const rows = stmt.all(phoneNumberId) as any[];

    return rows.map(rowToSmsMessage);
  }

  getSmsMessage(id: string): SmsMessage | undefined {
    const row = db.prepare(`SELECT * FROM sms_messages WHERE id = ?`).get(id) as any;
    return row ? rowToSmsMessage(row) : undefined;
  }

  pushSmsMessage(phoneNumberId: string, msg: SmsMessage): void {
    const stmt = db.prepare(`
      INSERT INTO sms_messages (id, phone_number_id, direction, from_number, to_number, body, timestamp, delivery_status, delivery_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const initialStatus = msg.deliveryStatus
      || (msg.direction === "inbound" ? "delivered" : "queued");
    stmt.run(
      msg.id, phoneNumberId, msg.direction, msg.from, msg.to, msg.body, msg.timestamp,
      initialStatus, msg.deliveryUpdatedAt || msg.timestamp,
    );
  }

  /**
   * Apply a Telnyx delivery-status update to an outbound message. Returns
   * true if the row was found. Inbound messages are stored as `delivered`
   * on insert and shouldn't transition further, so we restrict updates to
   * outbound rows.
   */
  updateSmsDeliveryStatus(
    id: string,
    status: NonNullable<SmsMessage["deliveryStatus"]>,
    providerError?: string,
  ): boolean {
    const res = db
      .prepare(`
        UPDATE sms_messages
        SET delivery_status = ?, delivery_updated_at = ?, provider_error = COALESCE(?, provider_error)
        WHERE id = ? AND direction = 'outbound'
      `)
      .run(status, new Date().toISOString(), providerError ?? null, id);
    return res.changes > 0;
  }

  // ── Email ─────────────────────────────────────────────────

  setEmailInbox(id: string, inbox: EmailInbox): void {
    // Plain INSERT (not OR REPLACE) — duplicate detection is the caller's
    // responsibility (`hasEmailAddress` / `hasEmailLocalPart`). OR REPLACE
    // would silently delete a conflicting row on any UNIQUE conflict, which
    // is data-loss waiting to happen.
    const stmt = db.prepare(`
      INSERT INTO email_inboxes (id, address, local_part, owner, public_key, solana_public_key, e2e_enabled, created_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, inbox.address, inbox.localPart, inbox.owner, inbox.publicKey, inbox.solanaPublicKey, inbox.e2eEnabled ? 1 : 0, inbox.createdAt, inbox.active ? 1 : 0);
  }

  getEmailInbox(id: string): EmailInbox | undefined {
    const stmt = db.prepare('SELECT * FROM email_inboxes WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return undefined;

    return {
      id: row.id,
      address: row.address,
      localPart: row.local_part,
      owner: row.owner,
      publicKey: row.public_key,
      solanaPublicKey: row.solana_public_key,
      e2eEnabled: Boolean(row.e2e_enabled),
      createdAt: row.created_at,
      active: Boolean(row.active)
    };
  }

  getEmailInboxByLocalPart(localPart: string): string | undefined {
    const stmt = db.prepare('SELECT id FROM email_inboxes WHERE local_part = ?');
    const row = stmt.get(localPart) as any;
    return row?.id;
  }

  getEmailInboxByAddress(address: string): string | undefined {
    const stmt = db.prepare('SELECT id FROM email_inboxes WHERE address = ? LIMIT 1');
    const row = stmt.get(address.toLowerCase()) as any;
    return row?.id;
  }

  hasEmailLocalPart(localPart: string): boolean {
    const stmt = db.prepare('SELECT 1 FROM email_inboxes WHERE local_part = ? LIMIT 1');
    return Boolean(stmt.get(localPart));
  }

  hasEmailAddress(address: string): boolean {
    const stmt = db.prepare('SELECT 1 FROM email_inboxes WHERE address = ? LIMIT 1');
    return Boolean(stmt.get(address));
  }

  getEmailInboxesByOwner(owner: string): EmailInbox[] {
    const stmt = db.prepare('SELECT * FROM email_inboxes WHERE owner = ?');
    const rows = stmt.all(owner) as any[];
    return rows.map((row) => ({
      id: row.id,
      address: row.address,
      localPart: row.local_part,
      owner: row.owner,
      publicKey: row.public_key,
      solanaPublicKey: row.solana_public_key,
      e2eEnabled: Boolean(row.e2e_enabled),
      createdAt: row.created_at,
      active: Boolean(row.active),
    }));
  }

  // ── Email Challenges (for wallet auth) ────────────────────

  setEmailChallenge(inboxId: string, challenge: string, expiresAt: number): void {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO email_challenges (inbox_id, challenge, expires_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(inboxId, challenge, expiresAt);
  }

  getEmailChallenge(inboxId: string): { challenge: string; expiresAt: number } | undefined {
    const stmt = db.prepare('SELECT challenge, expires_at FROM email_challenges WHERE inbox_id = ?');
    const row = stmt.get(inboxId) as any;
    if (!row) return undefined;
    return { challenge: row.challenge, expiresAt: row.expires_at };
  }

  deleteEmailChallenge(inboxId: string): void {
    db.prepare('DELETE FROM email_challenges WHERE inbox_id = ?').run(inboxId);
  }

  initEmailMessages(inboxId: string): void {
    // No explicit initialization needed for SQLite
  }

  getEmailMessages(inboxId: string): EmailMessage[] | undefined {
    const stmt = db.prepare(`
      SELECT * FROM email_messages 
      WHERE inbox_id = ? 
      ORDER BY timestamp DESC
    `);
    const rows = stmt.all(inboxId) as any[];
    
    return rows.map(row => ({
      id: row.id,
      inboxId: row.inbox_id,
      threadId: row.thread_id,
      direction: row.direction as 'inbound' | 'outbound',
      from: row.from_address,
      to: row.to_address,
      cc: row.cc,
      messageId: row.message_id_header,
      inReplyTo: row.in_reply_to,
      subject: row.subject,
      body: row.body,
      html: row.html,
      encrypted: Boolean(row.encrypted),
      timestamp: row.timestamp
    }));
  }

  pushEmailMessage(inboxId: string, msg: EmailMessage): void {
    const stmt = db.prepare(`
      INSERT INTO email_messages (id, inbox_id, thread_id, direction, from_address, to_address, cc, message_id_header, in_reply_to, subject, body, html, encrypted, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(msg.id, inboxId, msg.threadId || null, msg.direction, msg.from, msg.to, msg.cc || null, msg.messageId || null, msg.inReplyTo || null, msg.subject, msg.body, msg.html, msg.encrypted ? 1 : 0, msg.timestamp);

    // Store attachments
    if (msg.attachments?.length) {
      const attStmt = db.prepare(`INSERT INTO email_attachments (id, message_id, filename, content_type, size, content) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const att of msg.attachments) {
        attStmt.run(att.id, msg.id, att.filename, att.contentType, att.size, att.content);
      }
    }
  }

  // ── Email Threads ──

  setEmailThread(threadId: string, thread: any): void {
    db.prepare(`INSERT OR REPLACE INTO email_threads (id, inbox_id, subject, participants, message_count, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(threadId, thread.inboxId, thread.subject, thread.participants, thread.messageCount, thread.lastMessageAt, thread.createdAt);
  }

  getEmailThreads(inboxId: string): any[] {
    return db.prepare('SELECT * FROM email_threads WHERE inbox_id = ? ORDER BY last_message_at DESC').all(inboxId) as any[];
  }

  getEmailThread(threadId: string): any | undefined {
    return db.prepare('SELECT * FROM email_threads WHERE id = ?').get(threadId) as any;
  }

  updateEmailThread(threadId: string, updates: any): void {
    const thread = this.getEmailThread(threadId);
    if (!thread) return;
    db.prepare('UPDATE email_threads SET message_count = ?, last_message_at = ?, participants = ? WHERE id = ?')
      .run(updates.messageCount ?? thread.message_count, updates.lastMessageAt ?? thread.last_message_at, updates.participants ?? thread.participants, threadId);
  }

  getEmailAttachments(messageId: string): any[] {
    return db.prepare('SELECT id, filename, content_type, size FROM email_attachments WHERE message_id = ?').all(messageId) as any[];
  }

  getEmailAttachment(attachmentId: string): any | undefined {
    return db.prepare('SELECT * FROM email_attachments WHERE id = ?').get(attachmentId) as any;
  }

  // ── Email Webhooks ──

  setEmailWebhook(id: string, webhook: any): void {
    db.prepare('INSERT OR REPLACE INTO email_webhooks (id, inbox_id, url, events, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, webhook.inboxId, webhook.url, JSON.stringify(webhook.events || []), webhook.createdAt);
  }

  getEmailWebhooks(inboxId: string): any[] {
    return db.prepare('SELECT * FROM email_webhooks WHERE inbox_id = ?').all(inboxId) as any[];
  }

  // ── Domains ───────────────────────────────────────────────

  setDomain(id: string, domain: Domain): void {
    const transaction = db.transaction(() => {
      // Insert/update domain
      const domainStmt = db.prepare(`
        INSERT OR REPLACE INTO domains (id, domain, tld, owner, status, registrar, registered_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      domainStmt.run(id, domain.domain, domain.tld, domain.owner, domain.status, domain.registrar, domain.registeredAt, domain.expiresAt);

      // Delete existing DNS records for this domain
      const deleteRecordsStmt = db.prepare('DELETE FROM dns_records WHERE domain_id = ?');
      deleteRecordsStmt.run(id);

      // Insert DNS records
      const insertRecordStmt = db.prepare(`
        INSERT INTO dns_records (domain_id, type, name, value, ttl, priority)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      for (const record of domain.dnsRecords) {
        insertRecordStmt.run(id, record.type, record.name, record.value, record.ttl, record.priority || null);
      }
    });
    
    transaction();
  }

  getDomain(id: string): Domain | undefined {
    const domainStmt = db.prepare('SELECT * FROM domains WHERE id = ?');
    const domainRow = domainStmt.get(id) as any;
    if (!domainRow) return undefined;

    const recordsStmt = db.prepare('SELECT * FROM dns_records WHERE domain_id = ?');
    const recordRows = recordsStmt.all(id) as any[];

    const dnsRecords: DnsRecord[] = recordRows.map(row => ({
      type: row.type,
      name: row.name,
      value: row.value,
      ttl: row.ttl,
      priority: row.priority
    }));

    return {
      id: domainRow.id,
      domain: domainRow.domain,
      tld: domainRow.tld,
      owner: domainRow.owner,
      status: domainRow.status,
      registrar: domainRow.registrar,
      dnsRecords,
      registeredAt: domainRow.registered_at,
      expiresAt: domainRow.expires_at
    };
  }

  findDomainByName(name: string): Domain | undefined {
    const stmt = db.prepare('SELECT id FROM domains WHERE domain = ?');
    const row = stmt.get(name) as any;
    if (!row) return undefined;
    
    return this.getDomain(row.id);
  }

  // ── Compute ────────────────────────────────────────────────

  setServer(id: string, server: Server): void {
    // INSERT OR REPLACE wipes the whole row, so carry the openclaw_configured
    // flag forward from any existing row — getServer/serverAction/resize/rename
    // all re-save via this path and would otherwise reset a configured box to 0.
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO servers (id, name, server_type, image, status, ipv4, ipv6, owner, price_monthly, created_at, root_password, openclaw_configured)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT openclaw_configured FROM servers WHERE id = ?), 0))
    `);
    stmt.run(id, server.name, server.serverType, server.image, server.status, server.ipv4, server.ipv6, server.owner, server.priceMonthly, server.createdAt, server.rootPassword, id);
  }

  getServer(id: string): Server | undefined {
    const stmt = db.prepare('SELECT * FROM servers WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return undefined;

    return {
      id: row.id,
      name: row.name,
      serverType: row.server_type,
      image: row.image,
      status: row.status,
      ipv4: row.ipv4,
      ipv6: row.ipv6,
      owner: row.owner,
      priceMonthly: row.price_monthly,
      createdAt: row.created_at,
      rootPassword: row.root_password
    };
  }

  deleteServer(id: string): void {
    const stmt = db.prepare('DELETE FROM servers WHERE id = ?');
    stmt.run(id);
  }

  listServers(owner?: string): Server[] {
    let stmt;
    let rows: any[];
    
    if (owner) {
      stmt = db.prepare('SELECT * FROM servers WHERE owner = ? ORDER BY created_at DESC');
      rows = stmt.all(owner);
    } else {
      stmt = db.prepare('SELECT * FROM servers ORDER BY created_at DESC');
      rows = stmt.all();
    }

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      serverType: row.server_type,
      image: row.image,
      status: row.status,
      ipv4: row.ipv4,
      ipv6: row.ipv6,
      owner: row.owner,
      priceMonthly: row.price_monthly,
      createdAt: row.created_at,
      rootPassword: row.root_password,
      openclawConfigured: !!row.openclaw_configured,
    }));
  }

  // ── API Keys ──────────────────────────────────────────────

  setApiKey(id: string, key: ApiKey): void {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO api_keys (id, provider, label, secret, owner, price_usdc, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, key.provider, key.label, key.secret, key.owner, key.priceUsdc, key.active ? 1 : 0, key.createdAt);
  }

  getApiKey(id: string): ApiKey | undefined {
    const stmt = db.prepare('SELECT * FROM api_keys WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return undefined;

    return {
      id: row.id,
      provider: row.provider,
      label: row.label,
      secret: row.secret,
      owner: row.owner,
      priceUsdc: row.price_usdc,
      active: Boolean(row.active),
      createdAt: row.created_at
    };
  }

  listApiKeys(owner?: string): ApiKey[] {
    let stmt;
    let rows: any[];
    
    if (owner) {
      stmt = db.prepare('SELECT * FROM api_keys WHERE owner = ? AND active = 1 ORDER BY created_at DESC');
      rows = stmt.all(owner);
    } else {
      stmt = db.prepare('SELECT * FROM api_keys WHERE active = 1 ORDER BY created_at DESC');
      rows = stmt.all();
    }

    return rows.map(row => ({
      id: row.id,
      provider: row.provider,
      label: row.label,
      secret: row.secret,
      owner: row.owner,
      priceUsdc: row.price_usdc,
      active: Boolean(row.active),
      createdAt: row.created_at
    }));
  }

  // ── Voice Calls ────────────────────────────────────────────

  private calls = new Map<string, any>();
  private callsByControlId = new Map<string, string>();
  private callPendingActions = new Map<string, any>();
  private callGatheredDigits = new Map<string, string>();

  setCall(id: string, record: any): void {
    this.calls.set(id, record);
    if (record.callControlId) {
      this.callsByControlId.set(record.callControlId, id);
    }
  }

  getCall(id: string): any | undefined {
    return this.calls.get(id);
  }

  getCallByControlId(callControlId: string): any | undefined {
    const id = this.callsByControlId.get(callControlId);
    if (!id) return undefined;
    return this.calls.get(id);
  }

  listCalls(phoneNumberId: string): any[] {
    const results: any[] = [];
    for (const call of this.calls.values()) {
      if (call.phoneNumberId === phoneNumberId) results.push(call);
    }
    return results.sort((a: any, b: any) => 
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }

  setCallPendingAction(callControlId: string, action: any): void {
    this.callPendingActions.set(callControlId, action);
  }

  getCallPendingAction(callControlId: string): any | undefined {
    return this.callPendingActions.get(callControlId);
  }

  clearCallPendingAction(callControlId: string): void {
    this.callPendingActions.delete(callControlId);
  }

  setCallGatheredDigits(callControlId: string, digits: string): void {
    this.callGatheredDigits.set(callControlId, digits);
  }

  getCallGatheredDigits(callControlId: string): string | undefined {
    return this.callGatheredDigits.get(callControlId);
  }
}

/** Singleton storage instance */
export const storage = new Storage();