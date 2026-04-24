#!/usr/bin/env node
/**
 * Live-LLM planner smoke — validates the i402 planner produces sensible plans
 * against REAL Anthropic (Haiku + Opus) for a dozen representative NL intents.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx ts-node scripts/i402-live-planner-smoke.ts
 *
 * Cost: ~$0.20–0.60 in Anthropic credits per run depending on cache hits.
 * No provider calls, no x402 payments — this ONLY exercises plan generation.
 *
 * Why run it: before the beta, verify Opus actually picks the right providers
 * for everyday NL intents given the current 66-provider catalog.
 */

import "dotenv/config";

import { initDatabase } from "../src/db";
import { seedAgentOSPrimitives } from "../src/services/i402-providers";
import { generatePlan } from "../src/services/i402-planner";
import type { Plan, PlannerRequest } from "../src/services/i402-types";

interface IntentCase {
  intent: string;
  budgetUsdc: number;
  expectCapability?: string;      // at least one step should have this capability
  expectCapabilities?: string[];  // ALL of these should appear
  expectClarification?: boolean;
  expectBudgetExceeded?: boolean;
}

const CASES: IntentCase[] = [
  { intent: "Register the domain freshkicks.io", budgetUsdc: 20, expectCapability: "register_domain" },
  { intent: "Show me the domains I own", budgetUsdc: 5, expectCapability: "list_domains" },
  { intent: "Send an SMS that says 'hi' to +15551234567 from my phone abc123", budgetUsdc: 2, expectCapability: "send_sms" },
  { intent: "Provision a new phone number in the US", budgetUsdc: 10, expectCapability: "provision_phone" },
  { intent: "Deploy a cx23 VPS for my new project", budgetUsdc: 20, expectCapability: "deploy_vps" },
  { intent: "Create an email inbox called contact@freshkicks.io", budgetUsdc: 5, expectCapability: "provision_email_inbox" },
  { intent: "Buy an X / Twitter account from the pool", budgetUsdc: 10, expectCapability: "twitter_buy_account" },
  { intent: "Post a tweet saying 'gm' from my X account acc_abc", budgetUsdc: 1, expectCapability: "twitter_post" },
  { intent: "Reboot server srv_xyz", budgetUsdc: 1, expectCapability: "vps_action" },
  { intent: "Transfer domain freshkicks.io to wallet SOME_WALLET_ADDR", budgetUsdc: 1, expectCapability: "transfer_domain_ownership" },
  { intent: "Launch a product reselling sneakers to US teens", budgetUsdc: 60,
    expectCapabilities: ["register_domain", "deploy_vps", "provision_email_inbox"] },
  { intent: "do cool stuff", budgetUsdc: 10, expectClarification: true },
];

function colorOk(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function colorFail(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function colorInfo(s: string): string { return `\x1b[36m${s}\x1b[0m`; }
function colorDim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }

async function runCase(idx: number, c: IntentCase): Promise<{ pass: boolean; detail: string }> {
  const request: PlannerRequest = {
    sessionId: "",
    walletAddress: `SMOKE_WALLET_${idx}`,  // distinct wallet per case → fresh session
    intent: c.intent,
    budgetUsdc: c.budgetUsdc,
    quality: "best",
  };

  try {
    const result = await generatePlan(request, { forceNewSession: true });

    // Clarification path
    if (c.expectClarification) {
      if ("questions" in (result as any)) {
        return { pass: true, detail: `clarification: ${(result as any).questions.length} question(s)` };
      }
      return { pass: false, detail: `expected clarification, got plan with ${(result as Plan).steps.length} steps` };
    }

    // Plan path
    if (!("planId" in (result as any))) {
      return { pass: false, detail: "expected plan but got clarification" };
    }
    const plan = result as Plan;

    if (c.expectBudgetExceeded) {
      if (plan.status === "budget_exceeded") return { pass: true, detail: "budget_exceeded as expected" };
      return { pass: false, detail: `expected budget_exceeded, got ${plan.status}` };
    }

    const capsInPlan = new Set(plan.steps.map(s => s.capability));
    if (c.expectCapability && !capsInPlan.has(c.expectCapability)) {
      return { pass: false, detail: `missing capability '${c.expectCapability}'. Plan had: ${[...capsInPlan].join(", ")}` };
    }
    if (c.expectCapabilities) {
      const missing = c.expectCapabilities.filter(cap => !capsInPlan.has(cap));
      if (missing.length > 0) {
        return { pass: false, detail: `missing ${missing.join(", ")}. Plan had: ${[...capsInPlan].join(", ")}` };
      }
    }

    const summary = plan.steps.map(s => `${s.stepId}:${s.capability}`).join(" → ");
    return { pass: true, detail: `${plan.steps.length} steps (${summary}) $${plan.totals.totalCostUsdc.toFixed(2)}` };
  } catch (err: any) {
    return { pass: false, detail: `threw: ${err?.message ?? err}` };
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(colorFail("✗  ANTHROPIC_API_KEY not set. Set it and re-run."));
    process.exit(1);
  }

  initDatabase();
  seedAgentOSPrimitives();

  console.log(colorInfo("\ni402 live-LLM planner smoke"));
  console.log(colorDim("========================================="));
  console.log(colorDim(`Running ${CASES.length} intents against real Anthropic (Haiku router + Opus planner).`));
  console.log(colorDim("Each run creates a fresh session so there's no context bleed.\n"));

  let passed = 0;
  let failed = 0;
  const results: Array<{ idx: number; intent: string; pass: boolean; detail: string }> = [];

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    process.stdout.write(`[${i + 1}/${CASES.length}] ${c.intent.slice(0, 70)}... `);
    const start = Date.now();
    const r = await runCase(i, c);
    const dur = Date.now() - start;
    results.push({ idx: i + 1, intent: c.intent, ...r });
    if (r.pass) {
      console.log(`${colorOk("✓")} ${colorDim(`(${dur}ms)`)} ${r.detail}`);
      passed++;
    } else {
      console.log(`${colorFail("✗")} ${colorDim(`(${dur}ms)`)} ${colorFail(r.detail)}`);
      failed++;
    }
  }

  console.log(colorDim("\n========================================="));
  console.log(`Results: ${colorOk(`${passed} passed`)}, ${failed > 0 ? colorFail(`${failed} failed`) : "0 failed"} of ${CASES.length}`);

  if (failed > 0) {
    console.log(colorFail("\nFailures:"));
    for (const r of results.filter(x => !x.pass)) {
      console.log(`  [${r.idx}] ${r.intent}`);
      console.log(`       ${colorFail(r.detail)}`);
    }
    console.log(colorDim("\nPlanner quality is off. Tune the system prompt in src/services/i402-planner.ts before beta."));
    process.exit(1);
  }

  console.log(colorOk("\n✓ Planner is producing sensible plans for all test intents. Ship it."));
  process.exit(0);
}

main().catch(err => {
  console.error(colorFail("\nsmoke crashed:"), err);
  process.exit(2);
});
