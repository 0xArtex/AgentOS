import { PhoneNumber, SmsMessage, EmailInbox, EmailMessage, Server } from "../types";
import { db } from "../db";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

// ── VPS root-password encryption at rest (AES-256-GCM) ──────────────
// Root SSH passwords were stored in plaintext in the SQLite file. Encrypt them
// at rest, mirroring the master-key pattern used for social credentials
// (registered-accounts.ts) and agent secrets (routes/agent-secrets.ts).
//
// Key resolution is deliberately recoverable and non-bricking:
//   - SERVER_PASSWORD_KEY (64-hex / 32 bytes) set → use it (real encryption).
//   - Unset in dev/test/self-hosted → a labeled throwaway key so the path is
//     exercised end to end without secrets.
//   - Unset in genuine multi-tenant production → we do NOT invent a
//     source-derived key (that is false security: anyone with the DB + public
//     source could decrypt). Store as-is and rely on the 0600 DB-file perms
//     (see db.ts); an operator wanting encrypted-at-rest backups sets the key.
// Reads transparently pass through legacy/plaintext values, so enabling the key
// later never breaks existing rows, and removing it never crashes a listing.
const SERVER_PW_ENC_PREFIX = "enc:v1:";

function getServerPasswordKey(): Buffer | null {
  const hex = process.env.SERVER_PASSWORD_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  const prod =
    process.env.NODE_ENV === "production" &&
    !(process.env.PALMYR_SELF_HOSTED === "1" || process.env.PALMYR_SELF_HOSTED === "true");
  if (prod) return null;
  return createHash("sha256").update("palmyr-server-password-dev-key-v1").digest();
}

function encryptRootPassword(plaintext: string | null): string | null {
  if (plaintext == null || plaintext === "") return plaintext;
  if (plaintext.startsWith(SERVER_PW_ENC_PREFIX)) return plaintext; // already encrypted
  const key = getServerPasswordKey();
  if (!key) return plaintext; // prod without a dedicated key: rely on file perms
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SERVER_PW_ENC_PREFIX}${iv.toString("hex")}.${ct.toString("hex")}.${tag.toString("hex")}`;
}

function decryptRootPassword(stored: string | null): string | null {
  if (stored == null) return stored;
  if (!stored.startsWith(SERVER_PW_ENC_PREFIX)) return stored; // legacy / unencrypted
  const key = getServerPasswordKey();
  if (!key) {
    console.warn("[storage] encrypted server root password present but SERVER_PASSWORD_KEY is unset; cannot decrypt");
    return null;
  }
  try {
    const [iv, ct, tag] = stored.slice(SERVER_PW_ENC_PREFIX.length).split(".");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return decipher.update(ct, "hex", "utf8") + decipher.final("utf8");
  } catch (e) {
    console.warn("[storage] failed to decrypt server root password (key rotated/removed?):", (e as Error).message);
    return null;
  }
}

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
      INSERT INTO email_inboxes (id, address, local_part, owner, public_key, solana_public_key, e2e_enabled, created_at, active, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, inbox.address, inbox.localPart, inbox.owner, inbox.publicKey, inbox.solanaPublicKey, inbox.e2eEnabled ? 1 : 0, inbox.createdAt, inbox.active ? 1 : 0, inbox.expiresAt ?? null);
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
      active: Boolean(row.active),
      expiresAt: row.expires_at ?? undefined
    };
  }

  /**
   * Legacy inbound fallback resolver: match a bare local-part to an inbox id.
   * Scoped to ACTIVE inboxes and (when `domain` is given) only those whose
   * address is on that domain — a bare local-part must NEVER misdeliver a
   * default-domain address to a same-local-part inbox on another domain, and a
   * soft-deleted / reserved row must never absorb new mail.
   */
  getEmailInboxByLocalPart(localPart: string, domain?: string): string | undefined {
    const stmt = domain
      ? db.prepare("SELECT id FROM email_inboxes WHERE local_part = ? AND active = 1 AND substr(address, instr(address, '@') + 1) = ? LIMIT 1")
      : db.prepare('SELECT id FROM email_inboxes WHERE local_part = ? AND active = 1 LIMIT 1');
    const row = (domain ? stmt.get(localPart, domain.toLowerCase()) : stmt.get(localPart)) as any;
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
      expiresAt: row.expires_at ?? undefined,
    }));
  }

  /** Like hasEmailAddress, but only counts ACTIVE (non-deleted) inboxes. */
  hasActiveEmailAddress(address: string): boolean {
    const stmt = db.prepare('SELECT 1 FROM email_inboxes WHERE address = ? AND active = 1 LIMIT 1');
    return Boolean(stmt.get(address.toLowerCase()));
  }

  /**
   * Soft-delete: flip `active` off, keeping the row (and its messages) in
   * place. Returns false when the inbox is missing or already inactive.
   */
  deactivateEmailInbox(id: string): boolean {
    const res = db.prepare('UPDATE email_inboxes SET active = 0 WHERE id = ? AND active = 1').run(id);
    return res.changes > 0;
  }

  /**
   * Undo a soft delete: flip `active` back on. Used when the former owner
   * re-provisions the same address — the row (keys, messages) is reused so
   * delete-then-recreate works instead of colliding with UNIQUE(address).
   */
  reactivateEmailInbox(id: string): boolean {
    const res = db.prepare('UPDATE email_inboxes SET active = 1 WHERE id = ? AND active = 0').run(id);
    return res.changes > 0;
  }

  /**
   * How many ACTIVE inboxes live on a domain. Used by inbox deletion to know
   * whether a custom domain's Mailgun registration is still in use. Exact
   * match on the address's domain part — no LIKE wildcards.
   */
  countActiveEmailInboxesOnDomain(domain: string): number {
    const row = db.prepare(
      "SELECT COUNT(*) AS n FROM email_inboxes WHERE active = 1 AND substr(address, instr(address, '@') + 1) = ?"
    ).get(domain.toLowerCase()) as any;
    return Number(row?.n || 0);
  }

  /**
   * HARD-delete disposable temp inboxes whose expiry is more than `graceSeconds`
   * in the past, together with all their child rows. Only hard deletion frees
   * the UNIQUE(address) slot so a `tmp-*` address can be recycled; the functional
   * expiry (reads 404, inbound dropped) is handled lazily in emailService.
   *
   * Scoped to `expires_at IS NOT NULL` — a normal (owned) inbox has a NULL
   * expiry and is NEVER touched here, no matter how old. Deletes children before
   * parents (attachments → messages → threads → webhooks → inbox row) so
   * foreign keys stay satisfied. Returns the number of inbox rows removed.
   */
  deleteExpiredTempInboxes(graceSeconds: number): number {
    const cutoff = new Date(Date.now() - Math.max(0, graceSeconds) * 1000).toISOString();
    const rows = db.prepare(
      "SELECT id FROM email_inboxes WHERE expires_at IS NOT NULL AND expires_at < ?"
    ).all(cutoff) as Array<{ id: string }>;
    if (rows.length === 0) return 0;
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');

    const purge = db.transaction((inboxIds: string[]) => {
      db.prepare(
        `DELETE FROM email_attachments WHERE message_id IN (SELECT id FROM email_messages WHERE inbox_id IN (${placeholders}))`
      ).run(...inboxIds);
      db.prepare(`DELETE FROM email_messages WHERE inbox_id IN (${placeholders})`).run(...inboxIds);
      db.prepare(`DELETE FROM email_threads WHERE inbox_id IN (${placeholders})`).run(...inboxIds);
      db.prepare(`DELETE FROM email_webhooks WHERE inbox_id IN (${placeholders})`).run(...inboxIds);
      const res = db.prepare(`DELETE FROM email_inboxes WHERE id IN (${placeholders})`).run(...inboxIds);
      return res.changes;
    });
    return Number(purge(ids));
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
  // The former setDomain/getDomain/findDomainByName helpers were removed: they
  // referenced columns (tld, registrar, registered_at) that the current domains
  // schema (db.ts) no longer has — a latent crash if revived. They had no
  // callers; real domain writes go through src/routes/domains.ts directly.

  // ── Compute ────────────────────────────────────────────────

  setServer(id: string, server: Server): void {
    // INSERT OR REPLACE wipes the whole row, so carry the openclaw_configured
    // flag forward from any existing row — getServer/serverAction/resize/rename
    // all re-save via this path and would otherwise reset a configured box to 0.
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO servers (id, name, server_type, image, status, ipv4, ipv6, owner, price_monthly, created_at, root_password, openclaw_configured)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT openclaw_configured FROM servers WHERE id = ?), 0))
    `);
    stmt.run(id, server.name, server.serverType, server.image, server.status, server.ipv4, server.ipv6, server.owner, server.priceMonthly, server.createdAt, encryptRootPassword(server.rootPassword), id);
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
      rootPassword: decryptRootPassword(row.root_password)
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
      rootPassword: decryptRootPassword(row.root_password),
      openclawConfigured: !!row.openclaw_configured,
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