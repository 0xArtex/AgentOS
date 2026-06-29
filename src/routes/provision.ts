import { Router, Response } from "express";
import { requireDashboardAuth, DashboardRequest } from "../middleware/dashboard-session";

const router = Router();

// All provision routes require dashboard authentication
router.use(requireDashboardAuth as any);

// DELETE /provision/:service — deprovision a service for an agent.
//
// HONESTY: real per-service teardown (release the phone number, delete the
// inbox, destroy the VPS, …) is NOT wired up yet, and there is no record of
// which dashboard user owns a given nodeId/sub. Returning {success:true} here
// would be a lie with two concrete harms (SECURITY_AUDIT_2026-06-28 #79):
//   1. the caller is told a still-LIVE, still-BILLABLE resource was torn down;
//   2. once teardown is implemented as-is (no ownership gate) any authenticated
//      tenant could deprovision another tenant's resource by guessing
//      service+nodeId — a cross-tenant delete.
// Until teardown lands WITH an owner check (match the resource's recorded owner
// against the verified dashboard user before deleting, per-service), fail
// closed with 501 and leave the resource untouched.
router.delete("/:service", async (req: DashboardRequest, res: Response) => {
  const { service } = req.params;
  const { nodeId, sub } = req.body || {};

  const validServices = ["phone", "email", "domain", "vps", "xaccount", "wallet"];
  if (!validServices.includes(service as string)) {
    return res.status(400).json({ error: "Invalid service", valid: validServices });
  }

  console.log(
    `[provision] DELETE ${service} nodeId=${nodeId} sub=${sub} user=${req.dashUserId} — not implemented, resource left intact`
  );

  return res.status(501).json({
    error: "Not implemented",
    service,
    deprovisioned: false,
    message:
      `Deprovisioning ${service} is not yet supported — the resource was NOT modified and is still live (and billable). ` +
      `Manage it through its own service for now.`,
  });
});

export default router;
