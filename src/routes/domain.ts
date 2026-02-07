import { Router, Response } from "express";
import { x402 } from "../middleware/x402";
import { AuthenticatedRequest, RegisterDomainRequest, UpdateDnsRequest } from "../types";
import * as domainService from "../services/domain";

const router = Router();

/**
 * POST /domains — Register a new domain
 * Cost: 10.00 USDC
 */
router.post("/", x402(10.0), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, tld } = req.body as RegisterDomainRequest;

    if (!name || !tld) {
      res.status(400).json({ error: "name and tld are required" });
      return;
    }

    const domain = await domainService.register(name, tld, req.payment!.payer);
    res.status(201).json(domain);
  } catch (err: any) {
    console.error("[domain] Register error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /domains/:id — Get domain status
 */
router.get("/:id", x402(0.01), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const domain = await domainService.getStatus(req.params.id as string);
    res.json(domain);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * PUT /domains/:id/dns — Update DNS records
 * Cost: 0.10 USDC
 */
router.put("/:id/dns", x402(0.1), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { records } = req.body as UpdateDnsRequest;

    if (!records || !Array.isArray(records)) {
      res.status(400).json({ error: "records array is required" });
      return;
    }

    const domain = await domainService.configureDNS(req.params.id as string, records);
    res.json(domain);
  } catch (err: any) {
    console.error("[domain] DNS update error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
