import { PhoneNumber, SmsMessage, EmailInbox, EmailMessage, Domain, DnsRecord, Server, ApiKey } from "../types";
import { db } from "../db";

/**
 * SQLite-backed storage with a clean interface.
 * Each collection is stored in SQLite tables.
 */
class Storage {
  // ── Phone ─────────────────────────────────────────────────

  setPhoneNumber(id: string, record: PhoneNumber): void {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO phone_numbers (id, phone_number, country, owner, provisioned_at, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, record.phoneNumber, record.country, record.owner, record.provisionedAt, record.active ? 1 : 0);
  }

  getPhoneNumber(id: string): PhoneNumber | undefined {
    const stmt = db.prepare('SELECT * FROM phone_numbers WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    
    return {
      id: row.id,
      phoneNumber: row.phone_number,
      country: row.country,
      owner: row.owner,
      provisionedAt: row.provisioned_at,
      active: Boolean(row.active)
    };
  }

  findPhoneByNumber(phoneNumber: string): [string, PhoneNumber] | undefined {
    const stmt = db.prepare('SELECT * FROM phone_numbers WHERE phone_number = ?');
    const row = stmt.get(phoneNumber) as any;
    if (!row) return undefined;

    const phone: PhoneNumber = {
      id: row.id,
      phoneNumber: row.phone_number,
      country: row.country,
      owner: row.owner,
      provisionedAt: row.provisioned_at,
      active: Boolean(row.active)
    };
    
    return [row.id, phone];
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
    
    return rows.map(row => ({
      id: row.id,
      phoneNumberId: row.phone_number_id,
      direction: row.direction as 'inbound' | 'outbound',
      from: row.from_number,
      to: row.to_number,
      body: row.body,
      timestamp: row.timestamp
    }));
  }

  pushSmsMessage(phoneNumberId: string, msg: SmsMessage): void {
    const stmt = db.prepare(`
      INSERT INTO sms_messages (id, phone_number_id, direction, from_number, to_number, body, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(msg.id, phoneNumberId, msg.direction, msg.from, msg.to, msg.body, msg.timestamp);
  }

  // ── Email ─────────────────────────────────────────────────

  setEmailInbox(id: string, inbox: EmailInbox): void {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO email_inboxes (id, address, local_part, owner, public_key, solana_public_key, created_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, inbox.address, inbox.localPart, inbox.owner, inbox.publicKey, inbox.solanaPublicKey, inbox.createdAt, inbox.active ? 1 : 0);
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
      createdAt: row.created_at,
      active: Boolean(row.active)
    };
  }

  getEmailInboxByLocalPart(localPart: string): string | undefined {
    const stmt = db.prepare('SELECT id FROM email_inboxes WHERE local_part = ?');
    const row = stmt.get(localPart) as any;
    return row?.id;
  }

  hasEmailLocalPart(localPart: string): boolean {
    const stmt = db.prepare('SELECT 1 FROM email_inboxes WHERE local_part = ? LIMIT 1');
    return Boolean(stmt.get(localPart));
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
      direction: row.direction as 'inbound' | 'outbound',
      from: row.from_address,
      to: row.to_address,
      subject: row.subject,
      body: row.body,
      html: row.html,
      encrypted: Boolean(row.encrypted),
      timestamp: row.timestamp
    }));
  }

  pushEmailMessage(inboxId: string, msg: EmailMessage): void {
    const stmt = db.prepare(`
      INSERT INTO email_messages (id, inbox_id, direction, from_address, to_address, subject, body, html, encrypted, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(msg.id, inboxId, msg.direction, msg.from, msg.to, msg.subject, msg.body, msg.html, msg.encrypted ? 1 : 0, msg.timestamp);
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
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO servers (id, name, server_type, image, status, ipv4, ipv6, owner, price_monthly, created_at, root_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, server.name, server.serverType, server.image, server.status, server.ipv4, server.ipv6, server.owner, server.priceMonthly, server.createdAt, server.rootPassword);
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
      rootPassword: row.root_password
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

  // ── Used Payments (for transaction deduplication) ─────────

  isPaymentUsed(signature: string): boolean {
    const stmt = db.prepare('SELECT 1 FROM used_payments WHERE signature = ? LIMIT 1');
    return Boolean(stmt.get(signature));
  }

  markPaymentUsed(signature: string, payer: string, amountLamports: bigint, endpoint: string): void {
    const stmt = db.prepare(`
      INSERT INTO used_payments (signature, payer, amount_lamports, verified_at, endpoint)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(signature, payer, amountLamports.toString(), new Date().toISOString(), endpoint);
  }
}

/** Singleton storage instance */
export const storage = new Storage();