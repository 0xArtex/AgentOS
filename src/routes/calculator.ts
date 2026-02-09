import { Router, Request, Response } from 'express';

const router = Router();

const PRICING = {
  phone: { unit: 'number/month', price: 2.00, description: 'Dedicated phone number with SMS/voice' },
  email: { unit: 'address/month', price: 1.00, description: 'Custom email address with send/receive' },
  compute: { unit: 'hour', price: 0.10, description: 'Sandboxed compute instance' },
  domain: { unit: 'domain/year', price: 12.00, description: 'Domain registration and DNS management' },
  storage: { unit: 'GB/month', price: 0.05, description: 'Persistent storage for agent data' }
};

router.get('/pricing/calculator', (req: Request, res: Response) => {
  const phones = parseInt(req.query.phones as string) || 0;
  const emails = parseInt(req.query.emails as string) || 0;
  const computeHours = parseInt(req.query.compute_hours as string) || 0;
  const domains = parseInt(req.query.domains as string) || 0;
  const storageGB = parseInt(req.query.storage_gb as string) || 0;

  const breakdown = [];
  let monthlyTotal = 0;

  if (phones > 0) {
    const cost = phones * PRICING.phone.price;
    monthlyTotal += cost;
    breakdown.push({ resource: 'Phone Numbers', quantity: phones, unitPrice: PRICING.phone.price, monthlyCost: cost });
  }
  if (emails > 0) {
    const cost = emails * PRICING.email.price;
    monthlyTotal += cost;
    breakdown.push({ resource: 'Email Addresses', quantity: emails, unitPrice: PRICING.email.price, monthlyCost: cost });
  }
  if (computeHours > 0) {
    const cost = computeHours * PRICING.compute.price;
    monthlyTotal += cost;
    breakdown.push({ resource: 'Compute Hours', quantity: computeHours, unitPrice: PRICING.compute.price, monthlyCost: cost });
  }
  if (domains > 0) {
    const cost = domains * (PRICING.domain.price / 12);
    monthlyTotal += cost;
    breakdown.push({ resource: 'Domains', quantity: domains, unitPrice: +(PRICING.domain.price / 12).toFixed(2), monthlyCost: +cost.toFixed(2) });
  }
  if (storageGB > 0) {
    const cost = storageGB * PRICING.storage.price;
    monthlyTotal += cost;
    breakdown.push({ resource: 'Storage (GB)', quantity: storageGB, unitPrice: PRICING.storage.price, monthlyCost: cost });
  }

  const hackathonSavings = monthlyTotal;

  res.json({
    title: 'AgentOS Pricing Calculator',
    description: 'Estimate monthly costs for agent infrastructure. All prices in USDC.',
    note: 'Currently FREE during Colosseum hackathon (until Feb 12, 2026). Use X-Agent-Id header.',
    usage: 'GET /api/pricing/calculator?phones=2&emails=5&compute_hours=100&domains=1&storage_gb=10',
    pricing: PRICING,
    ...(breakdown.length > 0 ? {
      estimate: {
        breakdown,
        monthlyTotal: +monthlyTotal.toFixed(2),
        annualTotal: +(monthlyTotal * 12).toFixed(2),
        hackathonSavings: +hackathonSavings.toFixed(2),
        currency: 'USDC'
      }
    } : {
      hint: 'Add query params to get a cost estimate: ?phones=1&emails=3&compute_hours=50'
    })
  });
});

export default router;
