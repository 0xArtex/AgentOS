#!/usr/bin/env node
/**
 * Provision a disposable temp-inbox POOL domain end-to-end.
 *
 * Registers the domain with Mailgun, writes the DKIM + SPF + inbound-MX records
 * to its Namecheap DNS, and force-verifies. After this succeeds, add the domain
 * to TEMP_EMAIL_DOMAINS in prod env and redeploy — new temp inboxes will start
 * landing on it. The account-level Mailgun catch_all() route already forwards
 * inbound to /email/inbound, so NO per-domain route is needed.
 *
 * Prereqs:
 *   - The domain is registered in the operator's Namecheap account on BasicDNS
 *     (prod IP already whitelisted for the Namecheap API).
 *   - MAILGUN_API_KEY + NAMECHEAP_API_KEY/NAMECHEAP_API_USER set in env.
 *
 * Usage:
 *   npx ts-node scripts/provision-temp-email-domain.ts <domain>
 *   e.g. npx ts-node scripts/provision-temp-email-domain.ts inbox-relay.com
 *
 * NOTE: setDomainDnsRecords REPLACES the domain's entire host list. Run this on
 * a fresh/sacrificial domain with nothing else hosted on it.
 */
import { config } from "../src/config";
import { setDomainDnsRecords, type DnsHostRecord } from "../src/services/namecheap";
import {
  isMailgunConfigured,
  registerDomainWithMailgun,
  forceVerifyMailgunDomain,
} from "../src/services/mailgun";

async function main(): Promise<void> {
  const domain = (process.argv[2] || "").trim().toLowerCase();
  if (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    console.error("Usage: npx ts-node scripts/provision-temp-email-domain.ts <domain>");
    process.exit(1);
  }

  if (!isMailgunConfigured()) {
    console.error("✖ Mailgun not configured — set MAILGUN_API_KEY.");
    process.exit(1);
  }
  if (!config.namecheapApiKey || !config.namecheapApiUser) {
    console.error("✖ Namecheap not configured — set NAMECHEAP_API_KEY and NAMECHEAP_API_USER.");
    process.exit(1);
  }

  console.log(`\n▶ Provisioning temp-email pool domain: ${domain}\n`);

  // 1) Register with Mailgun → DKIM + SPF records to write.
  const reg = await registerDomainWithMailgun(domain);
  console.log(`  ✓ Mailgun registered (status=${reg.status}, ${reg.records.length} DNS records returned)`);

  // 2) Add inbound MX so receive lands at Mailgun (region-aware).
  const mxSuffix = (process.env.MAILGUN_REGION || "us").toLowerCase() === "eu" ? ".eu.mailgun.org" : ".mailgun.org";
  const records: DnsHostRecord[] = [
    ...reg.records,
    { type: "MX", name: "@", value: `mxa${mxSuffix}`, ttl: 1800, mxPref: 10 },
    { type: "MX", name: "@", value: `mxb${mxSuffix}`, ttl: 1800, mxPref: 10 },
  ];

  // 3) Write the full record set to Namecheap DNS (full replace).
  await setDomainDnsRecords(domain, records);
  console.log(`  ✓ Namecheap DNS written (${records.length} records: DKIM/SPF + inbound MX)`);

  // 4) Force Mailgun to re-poll now.
  try {
    const verified = await forceVerifyMailgunDomain(domain);
    console.log(`  ✓ Mailgun verify triggered (status=${verified.status})`);
    if (verified.status !== "active") {
      console.log("    (DNS can take a few minutes to propagate — re-run verify or check the Mailgun dashboard.)");
    }
  } catch (e: any) {
    console.warn(`  ! Mailgun verify failed (non-fatal, DNS may still be propagating): ${e?.message || e}`);
  }

  console.log(`\n✅ ${domain} provisioned.\n`);
  console.log("Next steps:");
  console.log(`  1. Add it to prod env:  TEMP_EMAIL_DOMAINS=...,${domain}`);
  console.log("  2. Redeploy so new temp inboxes start using it.");
  console.log("  3. Verify inbound: send a test email to any address @" + domain + " and read it via the temp-inbox flow.");
  console.log("  (The account-level Mailgun catch_all() route already forwards to /email/inbound — no per-domain route needed.)\n");
}

main().catch((err) => {
  console.error("\n✖ Provisioning failed:", err?.message || err);
  process.exit(1);
});
