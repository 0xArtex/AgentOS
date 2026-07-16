import { db } from "../db";
import { fetchSsrfSafe } from "./email";

interface WebhookPayload {
  event: string;
  agentId: string;
  data: Record<string, any>;
  timestamp: string;
}

/**
 * Send a webhook notification to an agent if they have a webhook URL configured
 */
export async function notifyAgent(
  agentId: string,
  event: string,
  data: Record<string, any>
): Promise<boolean> {
  const agent = db
    .prepare("SELECT webhook_url FROM agents WHERE id = ?")
    .get(agentId) as { webhook_url: string | null } | undefined;

  if (!agent?.webhook_url) return false;

  const payload: WebhookPayload = {
    event,
    agentId,
    data,
    timestamp: new Date().toISOString(),
  };

  try {
    // The webhook URL is agent-controlled, so deliver through fetchSsrfSafe:
    // https-or-http to a PUBLIC host only — it re-resolves DNS and re-checks
    // every hop against the private/loopback/link-local/metadata blocklist,
    // so an agent can't point its webhook at internal services or
    // 169.254.169.254 and have the server fetch them (blind SSRF).
    const response = await fetchSsrfSafe(agent.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Palmyr-Event": event,
        "User-Agent": "Palmyr/0.4.3",
      },
      body: JSON.stringify(payload),
      timeoutMs: 5000,
      maxBytes: 64 * 1024,
    });

    // Log the webhook delivery
    db.prepare(
      `INSERT INTO webhook_log (agent_id, event, url, status_code, created_at)
       VALUES (?, ?, ?, ?, datetime('now', 'utc'))`
    ).run(agentId, event, agent.webhook_url, response.status);

    return response.ok;
  } catch (err) {
    // Log failed delivery
    db.prepare(
      `INSERT INTO webhook_log (agent_id, event, url, status_code, error, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', 'utc'))`
    ).run(agentId, event, agent.webhook_url, 0, String(err));

    return false;
  }
}

// Events:
// phone.sms.inbound — new SMS received
// phone.call.inbound — incoming call
// email.inbound — new email received
// server.status.changed — server status changed
