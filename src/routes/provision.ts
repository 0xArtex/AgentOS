import { Router, Request, Response } from "express";

const router = Router();

// DELETE /provision/:service — deprovision a service for an agent
router.delete("/:service", async (req: Request, res: Response) => {
  const { service } = req.params;
  const { nodeId, sub } = req.body || {};

  const validServices = ["phone", "email", "domain", "vps", "xaccount", "wallet"];
  if (!validServices.includes(service as string)) {
    return res.status(400).json({ error: "Invalid service", valid: validServices });
  }

  // TODO: Actually deprovision the service (delete phone number, inbox, server, etc.)
  // For now, acknowledge the request
  console.log(`[provision] DELETE ${service} nodeId=${nodeId} sub=${sub}`);

  res.json({
    success: true,
    service,
    message: `${service} deprovisioned`,
    nodeId,
  });
});

export default router;
