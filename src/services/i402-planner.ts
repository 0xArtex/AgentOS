import crypto from "crypto";
import { db } from "../db";
import {
  CAPABILITY_CLASSES,
  getCapability,
  scoreProviders,
  listProviders,
  type I402Provider,
  type I402Quality,
} from "./i402-providers";
import { narrowProvidersForIntent } from "./i402-embeddings";
import {
  DEFAULT_PLANNER_MODEL,
  DEFAULT_ROUTER_MODEL,
  llm,
  type SystemBlock,
} from "./i402-llm";
import { listArtifacts, listMessages, appendMessage, getSession } from "./i402-session";
import type {
  Plan,
  PlanStep,
  PlanStatus,
  PlanTotals,
  PlanOrClarification,
  ClarificationResponse,
  ClarificationQuestion,
  ExecutionMode,
  PlannerRequest,
  PaymentRail,
} from "./i402-types";

// -------------------- Constants --------------------

const I402_VERSION = "0.1";
const APPROVAL_TTL_SECONDS = 900; // 15 min
const DEFAULT_EXECUTION_MODES: ExecutionMode[] = ["server_side", "hybrid"];

const ORCHESTRATION_FEE_PCT = () => parseFloat(process.env.I402_ORCHESTRATION_FEE_PCT ?? "0.15");
const ORCHESTRATION_FEE_MIN = 0.01; // min flat fee even on tiny plans

// -------------------- Router classification types --------------------

interface RouterClassification {
  classification: "direct" | "compound" | "ambiguous";
  reason: string;
  detected_capability?: string;
  clarification_questions?: string[];
}

const ROUTER_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    classification: {
      type: "string",
      enum: ["direct", "compound", "ambiguous"],
      description:
        "Classification: 'direct' = single capability, no composition; 'compound' = multi-step plan needed; 'ambiguous' = too vague, need clarification.",
    },
    reason: { type: "string", description: "One-sentence justification." },
    detected_capability: {
      type: "string",
      description:
        "For 'direct' classification: the single capability class name (from the provided list). Omit otherwise.",
    },
    clarification_questions: {
      type: "array",
      items: { type: "string" },
      description: "For 'ambiguous' classification: the questions needed to proceed. Omit otherwise.",
    },
  },
  required: ["classification", "reason"],
};

// -------------------- Planner plan output schema --------------------

const PLAN_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    interpreted_intent: {
      type: "string",
      description: "One-sentence interpretation of what the agent is asking for, expanded.",
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step_id: { type: "string", description: "Unique within plan, e.g. 's1'." },
          capability: { type: "string", description: "Canonical capability class name." },
          provider_id: { type: "string", description: "Chosen provider ID from the candidate list." },
          description: { type: "string", description: "Human-readable summary of what this step does." },
          input: { type: "object", description: "Input object for the provider, matching its input schema." },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description: "Prior step IDs whose outputs this step references.",
          },
        },
        required: ["step_id", "capability", "provider_id", "input"],
      },
    },
  },
  required: ["interpreted_intent", "steps"],
};

interface LLMPlanOutput {
  interpreted_intent: string;
  steps: Array<{
    step_id: string;
    capability: string;
    provider_id: string;
    description?: string;
    input: Record<string, unknown>;
    depends_on?: string[];
  }>;
}

// -------------------- Expansion templates for compound capabilities --------------------

export interface ExpansionTemplate {
  capability: string;
  description: string;
  steps: Array<{
    capability: string;
    description: string;
    platform?: "x" | "tiktok" | "reddit" | "linkedin";
  }>;
}

export const EXPANSION_TEMPLATES: Record<string, ExpansionTemplate> = {
  launch_product: {
    capability: "launch_product",
    description: "Full end-to-end product launch.",
    steps: [
      { capability: "web_search", description: "Research the target market and competitors." },
      { capability: "summarize", description: "Distill findings into brand positioning." },
      { capability: "register_domain", description: "Register a product domain." },
      { capability: "deploy_vps", description: "Provision a VPS for the landing page." },
      { capability: "provision_email_inbox", description: "Create a branded email inbox." },
      { capability: "social_account_provision", description: "Provision an X account.", platform: "x" },
      { capability: "social_account_provision", description: "Provision a TikTok account.", platform: "tiktok" },
      { capability: "social_post", description: "Launch post on X.", platform: "x" },
      { capability: "social_post", description: "Launch post on TikTok.", platform: "tiktok" },
    ],
  },
  research_topic: {
    capability: "research_topic",
    description: "Search + synthesize into a report.",
    steps: [
      { capability: "web_search", description: "Gather sources on the topic." },
      { capability: "summarize", description: "Produce a structured report from the sources." },
    ],
  },
  grow_audience: {
    capability: "grow_audience",
    description: "Trending analysis + cross-platform content.",
    steps: [
      { capability: "web_search", description: "Find trending angles in the niche." },
      { capability: "summarize", description: "Draft on-brand content variants." },
      { capability: "social_post", description: "Publish on X.", platform: "x" },
      { capability: "social_post", description: "Publish on TikTok.", platform: "tiktok" },
    ],
  },
};

// -------------------- System prompts (cacheable) --------------------

function buildRouterSystem(): SystemBlock[] {
  const capList = Object.keys(CAPABILITY_CLASSES).join(", ");
  return [
    {
      cache: true,
      text: [
        "You are the i402 intent router. Your job is to classify incoming agent intents so the downstream planner knows how to handle them.",
        "",
        "Classify each intent as one of:",
        "- 'direct': a single well-known capability can satisfy it (e.g. 'register example.com', 'send an SMS to +1555...'). Include 'detected_capability' from the list.",
        "- 'compound': multiple capabilities must compose to satisfy it (e.g. 'launch a product', 'research and summarize').",
        "- 'ambiguous': the goal is too vague or missing critical context to plan safely. Include 'clarification_questions'.",
        "",
        "Known capability classes:",
        capList,
        "",
        "Bias toward 'compound' over 'direct' when in doubt — a redundant multi-step plan is better than a missed step.",
        "Bias toward 'ambiguous' only when a concrete plan would make major assumptions the agent likely did not intend.",
        "Goals with known cultural templates ('launch a product', 'grow an audience', 'research X') are 'compound', not 'ambiguous' — they are well-understood expansions.",
      ].join("\n"),
    },
  ];
}

function buildPlannerSystem(args: {
  providers: I402Provider[];
  artifacts: Array<{ type: string; name?: string; resourceRef: string }>;
  budgetUsdc: number;
  quality: I402Quality;
}): SystemBlock[] {
  const capabilityCatalog = Object.values(CAPABILITY_CLASSES)
    .map(c => `  • ${c.name}${c.isCompound ? " (compound)" : ""} — ${c.description}`)
    .join("\n");

  const providerCatalog = args.providers
    .map(
      p =>
        `  • ${p.id} → capability=${p.capability}, cost=$${p.costPerCallUsdc.toFixed(
          2
        )}, rep=${p.reputationScore.toFixed(2)}, p50=${p.p50LatencyMs ?? "?"}ms${
          p.metadata ? ` meta=${JSON.stringify(p.metadata)}` : ""
        } — ${p.name}`
    )
    .join("\n");

  const expansionHints = Object.values(EXPANSION_TEMPLATES)
    .map(t => `  • ${t.capability}: ${t.steps.map(s => s.capability + (s.platform ? `(${s.platform})` : "")).join(" → ")}`)
    .join("\n");

  const artifactContext =
    args.artifacts.length > 0
      ? [
          "",
          "The agent's session already has these artifacts from prior plans. Reference them by name rather than re-provisioning:",
          ...args.artifacts.map(a => `  • ${a.type}: ${a.name ?? a.resourceRef}`),
        ].join("\n")
      : "";

  return [
    {
      cache: true,
      text: [
        "You are the i402 planner — the reference implementation of the i402 Intent Fulfillment Protocol.",
        "",
        "You receive an agent's intent and produce an ordered sequence of x402-settled provider calls (a 'plan') that fulfill it. The plan is executed in-order; each step may depend on outputs of prior steps.",
        "",
        "Principles:",
        "- Pick the best provider per step based on the quality hint (best = reputation, cheap = cost, fast = latency).",
        "- Never plan a step whose cost is known to be zero unless the capability's catalog declares it free.",
        "- Concrete inputs: each step must have concrete input values, never placeholders like '<TBD>'. For fields populated by prior step outputs, use the literal string '$STEPS.sN.output.FIELD' which the executor will resolve.",
        "- Dependency graph: use 'depends_on' only when a later step needs an earlier step's output. Do not serialize steps that can run in parallel.",
        "- Compound goals: expand into the full set of concrete steps (see expansion templates). Do not emit a single 'launch_product' step — emit the underlying sub-steps.",
        "- Reuse artifacts: if an artifact already exists (see session context), reference it in subsequent step inputs instead of provisioning a duplicate.",
        "- Budget discipline: the sum of step costs must fit within the agent's budget. If a reasonable plan cannot fit, reduce scope and explain in 'interpreted_intent' what was dropped.",
        "- Never hallucinate providers: only use provider IDs from the candidate list given to you.",
        "",
        "Capability catalog:",
        capabilityCatalog,
        "",
        "Expansion template hints (compound → sub-steps):",
        expansionHints,
      ].join("\n"),
    },
    {
      cache: true,
      text: [
        "Candidate providers for this request (narrowed via semantic retrieval + quality ranking):",
        providerCatalog,
      ].join("\n"),
    },
    {
      text: [
        `Current request context:`,
        `  budget: $${args.budgetUsdc.toFixed(2)} USDC`,
        `  quality preference: ${args.quality}`,
        artifactContext,
      ].join("\n"),
    },
  ];
}

// -------------------- Intent router --------------------

export async function classifyIntent(
  intent: string,
  sessionContextSummary?: string
): Promise<RouterClassification> {
  const userMessage = sessionContextSummary
    ? `Session context:\n${sessionContextSummary}\n\nNew intent:\n${intent}`
    : intent;

  const res = await llm.completeStructured<RouterClassification>({
    model: DEFAULT_ROUTER_MODEL(),
    system: buildRouterSystem(),
    messages: [{ role: "user", content: userMessage }],
    tool: {
      name: "classify_intent",
      description: "Classify an agent intent as direct, compound, or ambiguous.",
      inputSchema: ROUTER_TOOL_SCHEMA,
    },
    temperature: 0.0,
    maxTokens: 500,
  });

  return res.content;
}

// -------------------- Plan validation --------------------

export function validatePlanSteps(
  llmPlan: LLMPlanOutput,
  candidateProviders: I402Provider[],
  constraints: PlannerRequest["constraints"]
): { ok: true; steps: PlanStep[] } | { ok: false; reason: string } {
  if (!llmPlan.steps || llmPlan.steps.length === 0) {
    return { ok: false, reason: "Plan has no steps" };
  }

  const providerById = new Map(candidateProviders.map(p => [p.id, p]));
  const knownStepIds = new Set<string>();
  const steps: PlanStep[] = [];

  for (const raw of llmPlan.steps) {
    if (!raw.step_id || !raw.capability || !raw.provider_id) {
      return { ok: false, reason: `Step missing required fields: ${JSON.stringify(raw)}` };
    }
    if (knownStepIds.has(raw.step_id)) {
      return { ok: false, reason: `Duplicate step_id: ${raw.step_id}` };
    }
    knownStepIds.add(raw.step_id);

    if (!getCapability(raw.capability)) {
      return { ok: false, reason: `Unknown capability: ${raw.capability}` };
    }
    if (constraints?.excludeCapabilities?.includes(raw.capability)) {
      return { ok: false, reason: `Plan uses excluded capability: ${raw.capability}` };
    }

    const provider = providerById.get(raw.provider_id);
    if (!provider) {
      return { ok: false, reason: `Unknown provider: ${raw.provider_id}` };
    }
    if (provider.capability !== raw.capability) {
      return {
        ok: false,
        reason: `Provider ${raw.provider_id} is for capability ${provider.capability}, not ${raw.capability}`,
      };
    }
    if (constraints?.excludeProviders?.includes(provider.id)) {
      return { ok: false, reason: `Plan uses excluded provider: ${provider.id}` };
    }

    for (const dep of raw.depends_on ?? []) {
      if (!knownStepIds.has(dep)) {
        return { ok: false, reason: `Step ${raw.step_id} depends on unknown step ${dep}` };
      }
    }

    steps.push({
      stepId: raw.step_id,
      capability: raw.capability,
      provider: provider.id,
      description: raw.description,
      input: raw.input,
      costUsdc: provider.costPerCallUsdc,
      etaSeconds: provider.p50LatencyMs ? Math.ceil(provider.p50LatencyMs / 1000) : undefined,
      dependsOn: raw.depends_on,
      x402: {
        endpoint: provider.endpoint,
        method: provider.method,
        paymentRail:
          provider.authScheme === "x402-solana"
            ? "x402-solana"
            : provider.authScheme === "x402-base"
              ? "x402-base"
              : "internal",
      },
    });
  }

  if (constraints?.requireProviders) {
    const used = new Set(steps.map(s => s.provider));
    for (const required of constraints.requireProviders) {
      if (!used.has(required)) {
        return { ok: false, reason: `Required provider ${required} not used in plan` };
      }
    }
  }

  return { ok: true, steps };
}

export function computeTotals(steps: PlanStep[], budgetUsdc: number): PlanTotals {
  const stepCost = steps.reduce((sum, s) => sum + s.costUsdc, 0);
  const feePct = ORCHESTRATION_FEE_PCT();
  const fee = Math.max(ORCHESTRATION_FEE_MIN, stepCost * feePct);
  const roundedFee = Math.round(fee * 100) / 100;
  const total = stepCost + roundedFee;
  const totalEta = steps.reduce((sum, s) => sum + (s.etaSeconds ?? 0), 0);
  return {
    stepCostUsdc: Math.round(stepCost * 100) / 100,
    orchestrationFeeUsdc: roundedFee,
    totalCostUsdc: Math.round(total * 100) / 100,
    withinBudget: total <= budgetUsdc + 1e-9,
    etaSeconds: totalEta,
    executionModes: DEFAULT_EXECUTION_MODES,
  };
}

// -------------------- Direct plan (single capability, routed by Haiku) --------------------

async function directPlan(
  request: PlannerRequest,
  classification: RouterClassification
): Promise<PlanOrClarification> {
  const capability = classification.detected_capability;
  if (!capability || !getCapability(capability)) {
    // Router said direct but didn't give us a known capability — fall back to compound
    return compoundPlan(request);
  }

  const ranked = scoreProviders(capability, request.quality ?? "best");
  const usable = ranked.filter(p => !request.constraints?.excludeProviders?.includes(p.id));
  if (usable.length === 0) {
    const err: ClarificationResponse = {
      sessionId: request.sessionId,
      status: "clarification_needed",
      questions: [
        { id: "q1", text: `No provider available for capability ${capability}. Adjust constraints or pick a different goal.` },
      ],
    };
    return err;
  }

  const chosen = usable[0];
  const step: PlanStep = {
    stepId: "s1",
    capability,
    provider: chosen.id,
    description: `${chosen.name} — direct intent fulfillment`,
    input: (request.params as Record<string, unknown>) ?? {},
    costUsdc: chosen.costPerCallUsdc,
    etaSeconds: chosen.p50LatencyMs ? Math.ceil(chosen.p50LatencyMs / 1000) : undefined,
    x402: {
      endpoint: chosen.endpoint,
      method: chosen.method,
      paymentRail:
        chosen.authScheme === "x402-solana"
          ? "x402-solana"
          : chosen.authScheme === "x402-base"
            ? "x402-base"
            : "internal",
    },
  };

  const steps = [step];
  const totals = computeTotals(steps, request.budgetUsdc);
  const plan = buildPlan({
    request,
    interpretedIntent: classification.reason,
    steps,
    totals,
  });
  return plan;
}

// -------------------- Compound plan (LLM-driven via Opus) --------------------

async function compoundPlan(request: PlannerRequest): Promise<PlanOrClarification> {
  // Narrow providers: top-N across all capabilities by semantic relevance
  const narrowed = await narrowProvidersForIntent(request.intent);
  let candidateProviders = narrowed;
  if (candidateProviders.length === 0) {
    candidateProviders = listProviders({ enabledOnly: true });
  }
  // Always include union of top-3-per-capability of relevant ones to ensure coverage for
  // compound expansions that need multiple capability classes
  const byCapability = new Map<string, I402Provider[]>();
  for (const p of listProviders({ enabledOnly: true })) {
    if (!byCapability.has(p.capability)) byCapability.set(p.capability, []);
    byCapability.get(p.capability)!.push(p);
  }
  for (const [, ps] of byCapability) {
    for (const p of ps.slice(0, 3)) {
      if (!candidateProviders.find(c => c.id === p.id)) candidateProviders.push(p);
    }
  }

  // Exclude providers listed in constraints
  if (request.constraints?.excludeProviders?.length) {
    candidateProviders = candidateProviders.filter(
      p => !request.constraints!.excludeProviders!.includes(p.id)
    );
  }
  if (request.constraints?.excludeCapabilities?.length) {
    candidateProviders = candidateProviders.filter(
      p => !request.constraints!.excludeCapabilities!.includes(p.capability)
    );
  }

  const session = getSession(request.sessionId);
  const artifacts = listArtifacts(request.sessionId).map(a => ({
    type: a.type,
    name: a.name,
    resourceRef: a.resourceRef,
  }));

  const contextSummary = session?.contextSummary;
  const userMessageParts: string[] = [];
  if (contextSummary) userMessageParts.push(`Session summary so far:\n${contextSummary}`);
  userMessageParts.push(`Intent: ${request.intent}`);
  if (request.params) userMessageParts.push(`Structured params: ${JSON.stringify(request.params)}`);
  if (request.constraints) userMessageParts.push(`Constraints: ${JSON.stringify(request.constraints)}`);
  if (request.deadlineSeconds) userMessageParts.push(`Deadline: ${request.deadlineSeconds}s`);

  const llmRes = await llm.completeStructured<LLMPlanOutput>({
    model: DEFAULT_PLANNER_MODEL(),
    system: buildPlannerSystem({
      providers: candidateProviders,
      artifacts,
      budgetUsdc: request.budgetUsdc,
      quality: request.quality ?? "best",
    }),
    messages: [{ role: "user", content: userMessageParts.join("\n\n") }],
    tool: {
      name: "emit_plan",
      description:
        "Emit a structured plan of x402-settled steps that collectively fulfill the agent's intent.",
      inputSchema: PLAN_TOOL_SCHEMA,
    },
    temperature: 0.0,
  });

  const validated = validatePlanSteps(llmRes.content, candidateProviders, request.constraints);
  if (!validated.ok) {
    // Retry once with the validation error fed back
    const retry = await llm.completeStructured<LLMPlanOutput>({
      model: DEFAULT_PLANNER_MODEL(),
      system: buildPlannerSystem({
        providers: candidateProviders,
        artifacts,
        budgetUsdc: request.budgetUsdc,
        quality: request.quality ?? "best",
      }),
      messages: [
        { role: "user", content: userMessageParts.join("\n\n") },
        { role: "assistant", content: JSON.stringify(llmRes.content) },
        {
          role: "user",
          content: `Your previous plan failed validation: ${validated.reason}. Regenerate the plan fixing that issue. Use only providers from the candidate list.`,
        },
      ],
      tool: {
        name: "emit_plan",
        description: "Emit a structured plan of x402-settled steps.",
        inputSchema: PLAN_TOOL_SCHEMA,
      },
      temperature: 0.0,
    });
    const validated2 = validatePlanSteps(retry.content, candidateProviders, request.constraints);
    if (!validated2.ok) {
      throw new Error(`Plan validation failed twice: ${validated2.reason}`);
    }
    const totals = computeTotals(validated2.steps, request.budgetUsdc);
    return buildPlan({
      request,
      interpretedIntent: retry.content.interpreted_intent,
      steps: validated2.steps,
      totals,
    });
  }

  const totals = computeTotals(validated.steps, request.budgetUsdc);
  return buildPlan({
    request,
    interpretedIntent: llmRes.content.interpreted_intent,
    steps: validated.steps,
    totals,
  });
}

// -------------------- Plan assembly --------------------

function buildPlan(args: {
  request: PlannerRequest;
  interpretedIntent: string;
  steps: PlanStep[];
  totals: PlanTotals;
}): Plan {
  const { request, interpretedIntent, steps, totals } = args;
  const planId = `plan_${crypto.randomBytes(6).toString("hex")}`;

  let status: PlanStatus;
  if (!totals.withinBudget) {
    status = "budget_exceeded";
  } else if (shouldAutoApprove(request, totals)) {
    status = "approved";
  } else {
    status = "awaiting_approval";
  }

  const plan: Plan = {
    sessionId: request.sessionId,
    planId,
    status,
    intent: {
      original: request.intent,
      interpreted: interpretedIntent,
    },
    steps,
    totals,
    approval: status === "awaiting_approval"
      ? {
          required: true,
          expiresAt: new Date(Date.now() + APPROVAL_TTL_SECONDS * 1000).toISOString(),
          hint: totals.withinBudget
            ? undefined
            : `Plan exceeds budget by $${(totals.totalCostUsdc - request.budgetUsdc).toFixed(2)}.`,
          approveBody: {
            session_id: request.sessionId,
            plan_id: planId,
            approve: true,
            execution: "server_side",
          },
        }
      : undefined,
  };

  persistPlan(plan, request);
  return plan;
}

export function shouldAutoApprove(request: PlannerRequest, totals: PlanTotals): boolean {
  if (request.approve === true) return true;
  if (typeof request.autoApproveUnderUsdc === "number" && totals.totalCostUsdc <= request.autoApproveUnderUsdc) {
    return true;
  }
  return false;
}

function persistPlan(plan: Plan, request: PlannerRequest): void {
  // Determine the message seq this plan was generated in response to
  const lastMessage = listMessages(plan.sessionId, 10_000).slice(-1)[0];
  const messageSeq = lastMessage ? lastMessage.seq : 0;

  db.prepare(
    `INSERT INTO i402_session_plans (
       id, session_id, message_seq, intent, interpreted_intent, params, quality,
       steps, step_cost_usdc, orchestration_fee_usdc, total_cost_usdc, within_budget,
       execution_mode, status, approved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    plan.planId,
    plan.sessionId,
    messageSeq,
    plan.intent.original,
    plan.intent.interpreted ?? null,
    request.params ? JSON.stringify(request.params) : null,
    request.quality ?? null,
    JSON.stringify(plan.steps),
    plan.totals.stepCostUsdc,
    plan.totals.orchestrationFeeUsdc,
    plan.totals.totalCostUsdc,
    plan.totals.withinBudget ? 1 : 0,
    "server_side",
    plan.status,
    plan.status === "approved" ? new Date().toISOString() : null
  );
}

// -------------------- Main entry --------------------

export async function generatePlan(request: PlannerRequest): Promise<PlanOrClarification> {
  if (!request.sessionId) throw new Error("sessionId is required");
  if (!request.intent || request.intent.trim().length === 0) throw new Error("intent is required");
  if (request.budgetUsdc <= 0) throw new Error("budgetUsdc must be positive");

  // Log the agent's request in the session message log for auditability
  appendMessage({
    sessionId: request.sessionId,
    role: "agent",
    content: request.intent,
  });

  const session = getSession(request.sessionId);
  const classification = await classifyIntent(request.intent, session?.contextSummary);

  if (classification.classification === "ambiguous") {
    const questions: ClarificationQuestion[] = (classification.clarification_questions ?? []).map(
      (q, i) => ({ id: `q${i + 1}`, text: q })
    );
    if (questions.length === 0) {
      questions.push({ id: "q1", text: "Could you provide more detail on what outcome you're looking for?" });
    }
    const response: ClarificationResponse = {
      sessionId: request.sessionId,
      status: "clarification_needed",
      questions,
    };
    appendMessage({
      sessionId: request.sessionId,
      role: "clarification",
      content: JSON.stringify(questions),
    });
    return response;
  }

  if (classification.classification === "direct") {
    return await directPlan(request, classification);
  }

  return await compoundPlan(request);
}

// -------------------- Plan lookup for approval / execution --------------------

export interface PersistedPlan {
  id: string;
  sessionId: string;
  intent: string;
  interpretedIntent?: string;
  params?: Record<string, unknown>;
  steps: PlanStep[];
  stepCostUsdc: number;
  orchestrationFeeUsdc: number;
  totalCostUsdc: number;
  withinBudget: boolean;
  status: PlanStatus;
  createdAt: string;
  approvedAt?: string;
  completedAt?: string;
}

interface PlanRow {
  id: string;
  session_id: string;
  message_seq: number;
  intent: string;
  interpreted_intent: string | null;
  params: string | null;
  quality: string | null;
  steps: string;
  step_cost_usdc: number;
  orchestration_fee_usdc: number;
  total_cost_usdc: number;
  within_budget: number;
  execution_mode: string | null;
  status: PlanStatus;
  approved_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export function getPlan(planId: string): PersistedPlan | undefined {
  const row = db.prepare(`SELECT * FROM i402_session_plans WHERE id = ?`).get(planId) as PlanRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    sessionId: row.session_id,
    intent: row.intent,
    interpretedIntent: row.interpreted_intent ?? undefined,
    params: row.params ? JSON.parse(row.params) : undefined,
    steps: JSON.parse(row.steps) as PlanStep[],
    stepCostUsdc: row.step_cost_usdc,
    orchestrationFeeUsdc: row.orchestration_fee_usdc,
    totalCostUsdc: row.total_cost_usdc,
    withinBudget: row.within_budget === 1,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

export function updatePlanStatus(planId: string, status: PlanStatus): void {
  const extra: string[] = [];
  if (status === "approved") extra.push("approved_at = datetime('now','utc')");
  if (status === "completed" || status === "failed" || status === "cancelled") {
    extra.push("completed_at = datetime('now','utc')");
  }
  const extraSql = extra.length ? `, ${extra.join(", ")}` : "";
  db.prepare(`UPDATE i402_session_plans SET status = ?${extraSql} WHERE id = ?`).run(status, planId);
}

// -------------------- Version --------------------

export const PROTOCOL_VERSION = I402_VERSION;
export type {
  Plan,
  PlanStep,
  PlanStatus,
  PlanTotals,
  PlanOrClarification,
  ClarificationResponse,
  PaymentRail,
};
