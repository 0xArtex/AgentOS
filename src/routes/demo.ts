import { Router, Request, Response } from "express";

const router = Router();

/**
 * GET /demo/provision-phone — Demo phone provisioning (no payment required)
 * Returns mock data to show what the real endpoint would return
 */
router.get("/provision-phone", async (_req: Request, res: Response) => {
  // Simulate some processing delay
  await new Promise(resolve => setTimeout(resolve, 100));

  const mockResponse = {
    id: "demo_" + Math.random().toString(36).substr(2, 9),
    number: "+12125551234",
    friendlyName: "(212) 555-1234",
    country: "US",
    capabilities: {
      voice: true,
      sms: true,
      mms: true
    },
    cost: "2.00 USDC",
    provisionedAt: new Date().toISOString(),
    demo: true,
    note: "This is demo data. Real endpoint: POST /phone/numbers"
  };

  res.json(mockResponse);
});

/**
 * GET /demo/create-inbox — Demo email inbox creation (no payment required)  
 * Returns mock data to show what the real endpoint would return
 */
router.get("/create-inbox", async (_req: Request, res: Response) => {
  // Simulate some processing delay
  await new Promise(resolve => setTimeout(resolve, 150));

  const agentId = Math.random().toString(36).substr(2, 8);
  const mockResponse = {
    id: "demo_inbox_" + agentId,
    email: `agent-${agentId}@agentos.dev`,
    password: "[generated-password]",
    imap: {
      host: "imap.agentos.dev", 
      port: 993,
      secure: true
    },
    smtp: {
      host: "smtp.agentos.dev",
      port: 587,
      secure: false
    },
    cost: "1.00 USDC",
    createdAt: new Date().toISOString(),
    demo: true,
    note: "This is demo data. Real endpoint: POST /email/inboxes"
  };

  res.json(mockResponse);
});

/**
 * GET /demo/create-server — Demo compute server creation (no payment required)
 * Returns mock data to show what the real endpoint would return  
 */
router.get("/create-server", async (_req: Request, res: Response) => {
  await new Promise(resolve => setTimeout(resolve, 200));

  const serverId = Math.random().toString(36).substr(2, 10);
  const mockResponse = {
    id: "demo_server_" + serverId,
    name: `agent-server-${serverId}`,
    type: "cx11",
    datacenter: "ash-dc1",
    ipv4: "192.0.2." + Math.floor(Math.random() * 255),
    ipv6: "2001:db8::" + Math.floor(Math.random() * 9999),
    status: "running",
    specs: {
      vcpus: 1,
      memory: "4 GB",
      disk: "20 GB SSD"
    },
    cost: "5.00 USDC",
    createdAt: new Date().toISOString(),
    demo: true,
    note: "This is demo data. Real endpoint: POST /compute/servers"
  };

  res.json(mockResponse);
});

/**
 * GET /demo/provision-apikey — Demo API key provisioning (no payment required)
 * Returns mock data to show what the real endpoint would return
 */
router.get("/provision-apikey", async (_req: Request, res: Response) => {
  await new Promise(resolve => setTimeout(resolve, 80));

  const keyId = Math.random().toString(36).substr(2, 12);
  const mockResponse = {
    id: "demo_key_" + keyId,
    provider: "openai",
    keyPreview: "sk-proj-abc123...xyz789",
    usage: {
      totalCalls: 0,
      totalCost: "0.00",
      lastUsed: null
    },
    limits: {
      dailyCalls: 1000,
      monthlyCost: "50.00"
    },
    cost: "1.00 USDC", 
    createdAt: new Date().toISOString(),
    demo: true,
    note: "This is demo data. Real endpoint: POST /apikeys"
  };

  res.json(mockResponse);
});

export default router;