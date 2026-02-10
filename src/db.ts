import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const DATA_DIR = join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'agentos.db');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize SQLite database
export const db: Database.Database = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

/**
 * Initialize all tables for AgentOS
 */
export function initDatabase(): void {
  // Phone Numbers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS phone_numbers (
      id TEXT PRIMARY KEY,
      phone_number TEXT UNIQUE NOT NULL,
      country TEXT NOT NULL,
      owner TEXT NOT NULL,
      provisioned_at TEXT NOT NULL,
      active INTEGER DEFAULT 1
    );
    
    CREATE INDEX IF NOT EXISTS idx_phone_numbers_phone_number ON phone_numbers(phone_number);
    CREATE INDEX IF NOT EXISTS idx_phone_numbers_owner ON phone_numbers(owner);
  `);

  // SMS Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_messages (
      id TEXT PRIMARY KEY,
      phone_number_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      body TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (phone_number_id) REFERENCES phone_numbers(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_sms_messages_phone_number_id ON sms_messages(phone_number_id);
    CREATE INDEX IF NOT EXISTS idx_sms_messages_timestamp ON sms_messages(timestamp);
  `);

  // Email Inboxes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_inboxes (
      id TEXT PRIMARY KEY,
      address TEXT UNIQUE NOT NULL,
      local_part TEXT UNIQUE NOT NULL,
      owner TEXT NOT NULL,
      public_key TEXT,
      created_at TEXT NOT NULL,
      active INTEGER DEFAULT 1
    );
    
    CREATE INDEX IF NOT EXISTS idx_email_inboxes_local_part ON email_inboxes(local_part);
    CREATE INDEX IF NOT EXISTS idx_email_inboxes_owner ON email_inboxes(owner);
  `);

  // Email Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_messages (
      id TEXT PRIMARY KEY,
      inbox_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      html TEXT,
      encrypted INTEGER DEFAULT 0,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_email_messages_inbox_id ON email_messages(inbox_id);
    CREATE INDEX IF NOT EXISTS idx_email_messages_timestamp ON email_messages(timestamp);
  `);

  // Domains table
  db.exec(`
    CREATE TABLE IF NOT EXISTS domains (
      id TEXT PRIMARY KEY,
      domain TEXT UNIQUE NOT NULL,
      tld TEXT NOT NULL,
      owner TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'failed', 'expired')),
      registrar TEXT NOT NULL CHECK(registrar IN ('namecheap', 'cloudflare')),
      registered_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);
    CREATE INDEX IF NOT EXISTS idx_domains_owner ON domains(owner);
  `);

  // DNS Records table
  db.exec(`
    CREATE TABLE IF NOT EXISTS dns_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV')),
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      ttl INTEGER NOT NULL,
      priority INTEGER,
      FOREIGN KEY (domain_id) REFERENCES domains(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_dns_records_domain_id ON dns_records(domain_id);
  `);

  // Servers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      server_type TEXT NOT NULL CHECK(server_type IN ('cx22', 'cx32', 'cx42', 'cx52')),
      image TEXT NOT NULL,
      status TEXT NOT NULL,
      ipv4 TEXT,
      ipv6 TEXT,
      owner TEXT NOT NULL,
      price_monthly TEXT NOT NULL,
      created_at TEXT NOT NULL,
      root_password TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner);
  `);

  // API Keys table
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider IN ('brave_search', 'helius', 'openai', 'anthropic', 'elevenlabs', 'custom')),
      label TEXT NOT NULL,
      secret TEXT NOT NULL,
      owner TEXT NOT NULL,
      price_usdc TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner);
    CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(provider);
  `);

  // Used Payments table (for transaction deduplication)
  db.exec(`
    CREATE TABLE IF NOT EXISTS used_payments (
      signature TEXT PRIMARY KEY,
      payer TEXT NOT NULL,
      amount_lamports TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      endpoint TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_used_payments_payer ON used_payments(payer);
    CREATE INDEX IF NOT EXISTS idx_used_payments_verified_at ON used_payments(verified_at);
  `);

  // Inbound SMS table (from webhook callbacks)
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_sms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      twilio_sid TEXT UNIQUE NOT NULL,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      body TEXT NOT NULL,
      media_count INTEGER DEFAULT 0,
      media_url TEXT,
      media_type TEXT,
      received_at TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_inbound_sms_to_number ON inbound_sms(to_number);
    CREATE INDEX IF NOT EXISTS idx_inbound_sms_received_at ON inbound_sms(received_at);
  `);

  // Inbound Emails table (from webhook callbacks)
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      text_body TEXT NOT NULL,
      html_body TEXT,
      attachment_count INTEGER DEFAULT 0,
      raw_data TEXT,
      received_at TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_inbound_emails_to_address ON inbound_emails(to_address);
    CREATE INDEX IF NOT EXISTS idx_inbound_emails_received_at ON inbound_emails(received_at);
  `);

  // Agents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      wallet_address TEXT,
      webhook_url TEXT,
      token TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
    CREATE INDEX IF NOT EXISTS idx_agents_token ON agents(token);
    CREATE INDEX IF NOT EXISTS idx_agents_wallet ON agents(wallet_address);
  `);

  // API request log for analytics
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      payment_type TEXT CHECK(payment_type IN ('x402', 'hackathon', 'free')),
      cost_usdc TEXT,
      response_time_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_request_log_agent ON request_log(agent_id);
    CREATE INDEX IF NOT EXISTS idx_request_log_endpoint ON request_log(endpoint);
    CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log(created_at);
  `);

  // Hackathon Usage table
  db.exec(`
    CREATE TABLE IF NOT EXISTS hackathon_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      service_type TEXT NOT NULL CHECK(service_type IN ('phone', 'email', 'server')),
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_hackathon_usage_agent_id ON hackathon_usage(agent_id);
    CREATE INDEX IF NOT EXISTS idx_hackathon_usage_service_type ON hackathon_usage(service_type);
    CREATE INDEX IF NOT EXISTS idx_hackathon_usage_created_at ON hackathon_usage(created_at);
  `);

  // Agent-to-agent messages
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      subject TEXT,
      body TEXT NOT NULL,
      reply_to TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (from_agent) REFERENCES agents(id),
      FOREIGN KEY (to_agent) REFERENCES agents(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_created ON agent_messages(created_at);
  `);

  // Webhook delivery log
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_webhook_log_agent ON webhook_log(agent_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_log_event ON webhook_log(event);
  `);

  console.log('✅ Database initialized with all tables');
}

// Initialize database when this module is imported
initDatabase();