import { db } from "../db";

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(agent.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AgentOS-Event": event,
        "User-Agent": "AgentOS/0.2.0",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

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
// hackathon.limit.reached — agent hit a hackathon limit
