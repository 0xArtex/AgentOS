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
import {
  listMessages,
  appendMessage,
  getSession,
  createSession,
  findActiveSessionForWallet,
  updateSessionStatus,
} from "./i402-session";
import type {
  Plan,
  PlanStep,
  PlanStatus,
  PlanTotals,
  PlanOrClarification,
  ClarificationResponse,
  ClarificationQuestion,
  PlannerRequest,
} from "./i402-types";

// -------------------- Constants --------------------

const I402_VERSION = "0.1";

const ORCHESTRATION_FEE_PCT = () => parseFloat(process.env.I402_ORCHESTRATION_FEE_PCT ?? "0.15");
const ORCHESTRATION_FEE_MIN = 0.01;

// -------------------- Router classification --------------------

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
        "direct = a single capability satisfies it; compound = multi-step composition needed; ambiguous = too vague to plan safely.",
    },
    reason: { type: "string", description: "One-sentence justification." },
    detected_capability: { type: "string", description: "For 'direct' only — capability class name." },
    clarification_questions: {
      type: "array",
      items: { type: "string" },
      description: "For 'ambiguous' only — the minimum questions needed to proceed.",
    },
  },
  required: ["classification", "reason"],
};

// -------------------- Session-relatedness classification --------------------

interface RelatednessClassification {
  verdict: "continues" | "new_goal";
  reason: string;
}

const RELATEDNESS_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    verdict: {
      type: "string",
      enum: ["continues", "new_goal"],
      description:
        "continues = the new intent logically extends work from the prior session (same project, same brand, same goal); new_goal = unrelated to prior work.",
    },
    reason: { type: "string", description: "One-sentence justification." },
  },
  required: ["verdict", "reason"],
};

// -------------------- Planner output schema --------------------

const PLAN_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    interpreted_intent: {
      type: "string",
      description: "One-sentence interpretation, expanded from the original intent.",
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step_id: { type: "string", description: "Unique within plan, e.g. 's1'." },
          capability: { type: "string", description: "Canonical capability class name." },
          provider_id: { type: "string", description: "Chosen provider ID from the candidate list." },
          description: { type: "string" },
          input: { type: "object", description: "Input object matching provider's input schema." },
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

// -------------------- Expansion templates --------------------

export interface ExpansionTemplate {
  capability: string;
  description: string;
  steps: Array<{ capability: string; description: string; platform?: "x" | "tiktok" | "reddit" | "linkedin" }>;
}

export const EXPANSION_TEMPLATES: Record<string, ExpansionTemplate> = {
  launch_product: {
    capability: "launch_product",
    description: "Full end-to-end product launch.",
    steps: [
      { capability: "register_domain", description: "Register a product domain." },
      { capability: "deploy_vps", description: "Provision a VPS for the landing page." },
      { capability: "provision_email_inbox", description: "Create a branded email inbox." },
      { capability: "social_account_provision", description: "Provision an X account.", platform: "x" },
      { capability: "social_account_provision", description: "Provision a TikTok account.", platform: "tiktok" },
      { capability: "social_post", description: "Launch post on X.", platform: "x" },
      { capability: "social_post", description: "Launch post on TikTok.", platform: "tiktok" },
    ],
  },
  grow_audience: {
    capability: "grow_audience",
    description: "Cross-platform content generation and posting.",
    steps: [
      { capability: "social_post", description: "Publish on X.", platform: "x" },
      { capability: "social_post", description: "Publish on TikTok.", platform: "tiktok" },
    ],
  },
};

// -------------------- System prompts --------------------

function buildRouterSystem(): SystemBlock[] {
  const capList = Object.keys(CAPABILITY_CLASSES).join(", ");
  return [
    {
      cache: true,
      text: [
        "You are the i402 intent router. Classify incoming agent intents so the downstream planner knows how to handle them.",
        "",
        "Classifications:",
        "  - 'direct': a single known capability satisfies it. Include 'detected_capability' from the list.",
        "  - 'compound': multi-step composition needed.",
        "  - 'ambiguous': too vague to plan safely. Include 'clarification_questions'.",
        "",
        "Known capability classes: " + capList,
        "",
        "Bias toward 'compound' over 'direct' when in doubt. Bias toward 'ambiguous' only when a concrete plan would require major assumptions.",
        "Goals with known cultural templates ('launch a product', 'grow an audience') are 'compound', not 'ambiguous'.",
      ].join("\n"),
    },
  ];
}

function buildRelatednessSystem(): SystemBlock[] {
  return [
    {
      cache: true,
      text: [
        "You are the i402 session router. You're told about a recent active session for a wallet (its last intent, and a short summary of what's been done) and a NEW incoming intent.",
        "",
        "Decide:",
        "  - 'continues' if the new intent logically extends the same project/goal/brand. Examples:",
        "      prior: 'launch a sneaker brand'    new: 'now post 3 TikTok videos'  → continues",
        "      prior: 'research AI agent trends'  new: 'write a summary'            → continues",
        "  - 'new_goal' if unrelated. Examples:",
        "      prior: 'launch a sneaker brand'    new: 'research crypto'            → new_goal",
        "      prior: 'send 10 SMS to customers'  new: 'launch a coffee subscription'→ new_goal",
        "",
        "When unsure, prefer 'new_goal' — a fresh session is safer than leaking unrelated context.",
      ].join("\n"),
    },
  ];
}

function buildPlannerSystem(args: {
  providers: I402Provider[];
  budgetUsdc: number;
  quality: I402Quality;
  contextSummary?: string;
}): SystemBlock[] {
  const capabilityCatalog = Object.values(CAPABILITY_CLASSES)
    .map(c => {
      const fmt = (schema: unknown): string => {
        if (!schema || typeof schema !== "object") return "{}";
        const entries = Object.entries(schema as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
        return `{ ${entries.join(", ")} }`;
      };
      return [
        `  • ${c.name}${c.isCompound ? " (compound)" : ""} — ${c.description}`,
        `      input:  ${fmt(c.inputSchema)}`,
        `      output: ${fmt(c.outputSchema)}`,
      ].join("\n");
    })
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
    .map(
      t =>
        `  • ${t.capability}: ${t.steps.map(s => s.capability + (s.platform ? `(${s.platform})` : "")).join(" → ")}`
    )
    .join("\n");

  const contextBlock = args.contextSummary
    ? ["", "Session context so far (from prior turns):", args.contextSummary].join("\n")
    : "";

  return [
    {
      cache: true,
      text: [
        "You are the i402 planner. You produce an ordered sequence of x402-settled provider calls that fulfill an agent's intent.",
        "",
        "i402 v0.1 is agent-side-execution-only: the agent signs every x402 call itself. Your job is the composition — pick providers, wire inputs, order dependencies.",
        "",
        "Principles:",
        "  - **Use-existing first, provision last.** When the user's intent uses possessive or definite language — 'my X', 'the X I have', 'an existing X', 'already have', 'use my', 'with that X I bought' — they ALREADY OWN one. ALWAYS start with the corresponding list_* capability and chain from there. Never emit a provision_* / register_* / create_* step for a resource the user implied they already own. Examples:",
        "      · 'send SMS from my US number' → list_phones → send_sms (NOT provision_phone)",
        "      · 'send email from my hello@... inbox' / 'from my X inbox' → list_inboxes → send_email (NOT provision_email_inbox). Match the user-supplied address against the address field of each inbox.",
        "      · 'deploy to my existing VPS' → list_vps → install_skill (NOT deploy_vps)",
        "      · 'update DNS for my domain' → list_domains → dns_manage (NOT register_domain)",
        "      · 'post from my X account' → (cookies already in session, skip provision)",
        "      · 'tweet from a new account' / 'register a fresh domain' / 'spin up a new VPS' → fresh provision is correct",
        "  - **Voice calls with TTS are single-shot.** When the user wants to speak something into a call, pass `tts: \"the message\"` to start_voice_call — it plays automatically when the recipient answers (server queues a webhook handler). DO NOT chain start_voice_call → voice_speak for the initial message; voice_speak only works on already-answered calls and will 422 if the call is still ringing. Only chain voice_speak when the user wants to say MORE after the initial message played. Same for `audioUrl` (one-shot audio clip) and `record: true` (start recording on answer).",
        "  - Concrete inputs only. Never placeholders like '<TBD>'. For fields populated by prior-step outputs, use literal strings of the form '$STEPS.sN.output.FIELD'; the executor resolves them.",
        "  - **Path params are inputs too**: any input field annotated '(path)' MUST appear in the step's input object. The executor moves it from input → URL automatically; if you omit it the step fails before it runs.",
        "  - **Indexing into list outputs**: list_* capabilities return an array (e.g. list_phones → { numbers: [{ id, ... }] }). To use the first item's id in a downstream step, write $STEPS.sN.output.numbers[0].id. Both `[N]` and `.N` syntaxes are supported.",
        "  - **Chain prior-step outputs**: when a downstream step needs an ID created by an earlier step, ALWAYS reference it via $STEPS.sN.output.FIELD. Common chains:",
        "      · provision_phone returns { id } → use as phone_number_id in send_sms / read_sms / start_voice_call / list_calls",
        "      · provision_email_inbox returns { id } → use as inbox_id in send_email / read_email / list_email_threads",
        "      · register_domain returns { id, domain } → use 'domain' as path param in get_domain / dns_manage / transfer_domain_*",
        "      · create_ssh_key returns { id } → include in sshKeyIds array of deploy_vps",
        "      · deploy_vps returns { id } → use as server_id in vps_action / vps_resize / vps_delete / install_skill / get_vps",
        "      · start_voice_call returns { call_control_id } → use as call_control_id in voice_speak / voice_play / voice_hangup / voice_record_*",
        "      · twitter_login / twitter_buy_account returns { cookies } → use as cookies in twitter_post / twitter_reply / twitter_like / etc.",
        "      · tiktok_login returns { cookies } → use as cookies in tiktok_post / tiktok_follow / etc.",
        "  - When chaining, ALWAYS add depends_on: [\"sN\"] for the parent step, otherwise the executor may run them in parallel and the reference will be unresolved.",
        "  - Budget discipline: sum of step costs + orchestration fee must fit within the agent's budget.",
        "  - Compound goals: expand into concrete sub-steps (see templates). Do not emit a single 'launch_product' step.",
        "  - Never hallucinate providers: only use IDs from the candidate list below.",
        "",
        "Capability catalog:",
        capabilityCatalog,
        "",
        "Expansion template hints:",
        expansionHints,
      ].join("\n"),
    },
    {
      cache: true,
      text: ["Candidate providers for this request (narrowed by semantic retrieval):", providerCatalog].join("\n"),
    },
    {
      text: [
        `Current request context:`,
        `  budget: $${args.budgetUsdc.toFixed(2)} USDC`,
        `  quality: ${args.quality}`,
        contextBlock,
      ].join("\n"),
    },
  ];
}

// -------------------- LLM calls --------------------

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
    maxTokens: 500,
  });
  return res.content;
}

export async function classifySessionRelatedness(args: {
  priorIntent: string;
  priorSummary?: string;
  newIntent: string;
}): Promise<RelatednessClassification> {
  const userMessage = [
    `Prior session's most recent intent: "${args.priorIntent}"`,
    args.priorSummary ? `Prior session summary: ${args.priorSummary}` : "",
    ``,
    `New intent: "${args.newIntent}"`,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await llm.completeStructured<RelatednessClassification>({
    model: DEFAULT_ROUTER_MODEL(),
    system: buildRelatednessSystem(),
    messages: [{ role: "user", content: userMessage }],
    tool: {
      name: "classify_session_relatedness",
      description: "Decide whether a new intent continues a prior session or starts a new goal.",
      inputSchema: RELATEDNESS_TOOL_SCHEMA,
    },
    maxTokens: 200,
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
    // Agent-side-only: every provider MUST speak x402 natively.
    if (provider.authScheme !== "x402-solana" && provider.authScheme !== "x402-base") {
      return {
        ok: false,
        reason: `Provider ${provider.id} auth scheme '${provider.authScheme}' is not x402-native; agent-side execution requires direct x402.`,
      };
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
        paymentRail: provider.authScheme === "x402-solana" ? "x402-solana" : "x402-base",
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

  // Reject the start_voice_call → voice_speak anti-pattern. Telnyx 422s on
  // unanswered calls; the plan must use the call's `tts` parameter for the
  // first message (server queues a webhook handler that fires on answer).
  for (const step of steps) {
    if (step.capability !== "voice_speak") continue;
    const sourceStepId = step.dependsOn?.[0];
    if (!sourceStepId) continue;
    const sourceStep = steps.find(s => s.stepId === sourceStepId);
    if (sourceStep?.capability !== "start_voice_call") continue;
    const callInput = (sourceStep.input ?? {}) as Record<string, unknown>;
    if (!callInput.tts && !callInput.audioUrl) {
      return {
        ok: false,
        reason: `voice_speak (${step.stepId}) cannot follow a fresh start_voice_call (${sourceStep.stepId}) — the call may still be ringing. Move the speech text into start_voice_call's "tts" input instead and remove ${step.stepId}.`,
      };
    }
  }

  return { ok: true, steps };
}

// -------------------- Totals --------------------

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
  };
}

// -------------------- Direct plan (single capability) --------------------

async function directPlan(
  request: PlannerRequest,
  classification: RouterClassification
): Promise<PlanOrClarification> {
  const capability = classification.detected_capability;
  if (!capability || !getCapability(capability)) return compoundPlan(request);

  const ranked = scoreProviders(capability, request.quality ?? "best");
  const usable = ranked.filter(
    p =>
      !request.constraints?.excludeProviders?.includes(p.id) &&
      (p.authScheme === "x402-solana" || p.authScheme === "x402-base")
  );
  if (usable.length === 0) {
    return {
      sessionId: request.sessionId,
      status: "clarification_needed",
      questions: [
        {
          id: "q1",
          text: `No x402-native provider available for capability '${capability}'. Adjust constraints or pick a different goal.`,
        },
      ],
    };
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
      paymentRail: chosen.authScheme === "x402-solana" ? "x402-solana" : "x402-base",
    },
  };

  const steps = [step];
  const totals = computeTotals(steps, request.budgetUsdc);
  return buildPlan({ request, interpretedIntent: classification.reason, steps, totals });
}

// -------------------- Compound plan (LLM-driven) --------------------

async function compoundPlan(request: PlannerRequest): Promise<PlanOrClarification> {
  let candidateProviders = await narrowProvidersForIntent(request.intent);
  if (candidateProviders.length === 0) {
    candidateProviders = listProviders({ enabledOnly: true });
  }
  // Ensure at least top-3 per capability are in the candidate pool for coverage
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

  // Filter to x402-native + constraints
  candidateProviders = candidateProviders.filter(
    p => p.authScheme === "x402-solana" || p.authScheme === "x402-base"
  );
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
      budgetUsdc: request.budgetUsdc,
      quality: request.quality ?? "best",
      contextSummary,
    }),
    messages: [{ role: "user", content: userMessageParts.join("\n\n") }],
    tool: {
      name: "emit_plan",
      description: "Emit a structured plan of x402-settled steps.",
      inputSchema: PLAN_TOOL_SCHEMA,
    },
  });

  const validated = validatePlanSteps(llmRes.content, candidateProviders, request.constraints);
  if (!validated.ok) {
    // Retry once with validation feedback
    const retry = await llm.completeStructured<LLMPlanOutput>({
      model: DEFAULT_PLANNER_MODEL(),
      system: buildPlannerSystem({
        providers: candidateProviders,
        budgetUsdc: request.budgetUsdc,
        quality: request.quality ?? "best",
        contextSummary,
      }),
      messages: [
        { role: "user", content: userMessageParts.join("\n\n") },
        { role: "assistant", content: JSON.stringify(llmRes.content) },
        {
          role: "user",
          content: `Your previous plan failed validation: ${validated.reason}. Regenerate fixing that issue. Use only providers from the candidate list.`,
        },
      ],
      tool: {
        name: "emit_plan",
        description: "Emit a structured plan of x402-settled steps.",
        inputSchema: PLAN_TOOL_SCHEMA,
      },
    });
    const validated2 = validatePlanSteps(retry.content, candidateProviders, request.constraints);
    if (!validated2.ok) throw new Error(`Plan validation failed twice: ${validated2.reason}`);
    const totals = computeTotals(validated2.steps, request.budgetUsdc);
    return buildPlan({ request, interpretedIntent: retry.content.interpreted_intent, steps: validated2.steps, totals });
  }

  const totals = computeTotals(validated.steps, request.budgetUsdc);
  return buildPlan({ request, interpretedIntent: llmRes.content.interpreted_intent, steps: validated.steps, totals });
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

  // 'approved' status means "plan validated, within budget, ready for agent-side execution".
  // The status name is retained for DB-schema compatibility; the semantic is agent-side.
  const status: PlanStatus = !totals.withinBudget ? "budget_exceeded" : "approved";

  const plan: Plan = {
    sessionId: request.sessionId,
    planId,
    status,
    intent: { original: request.intent, interpreted: interpretedIntent },
    steps,
    totals,
  };

  persistPlan(plan, request);
  return plan;
}

function persistPlan(plan: Plan, request: PlannerRequest): void {
  const lastMessage = listMessages(plan.sessionId, 10_000).slice(-1)[0];
  const messageSeq = lastMessage ? lastMessage.seq : 0;

  db.prepare(
    `INSERT INTO i402_session_plans (
       id, session_id, message_seq, intent, interpreted_intent, params, quality,
       steps, step_cost_usdc, orchestration_fee_usdc, total_cost_usdc, within_budget,
       execution_mode, status, approved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
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
    "agent_side",
    plan.status
  );
}

// -------------------- Session resolution --------------------

/**
 * Resolve which session this request belongs to given the wallet.
 *
 * Rules:
 *   - If forceNewSession: always create fresh.
 *   - If no active session for wallet: create fresh.
 *   - If active session exists AND new intent continues it (per Haiku relatedness
 *     classifier): return that session.
 *   - Otherwise: close the prior active session as 'completed' and create fresh.
 */
async function resolveSessionForWallet(args: {
  walletAddress: string;
  intent: string;
  budgetUsdc: number;
  forceNewSession: boolean;
}): Promise<{ sessionId: string; carriedContext: boolean }> {
  if (args.forceNewSession) {
    const fresh = createSession({ walletAddress: args.walletAddress, budgetUsdc: args.budgetUsdc });
    return { sessionId: fresh.id, carriedContext: false };
  }

  const active = findActiveSessionForWallet(args.walletAddress);
  if (!active) {
    const fresh = createSession({ walletAddress: args.walletAddress, budgetUsdc: args.budgetUsdc });
    return { sessionId: fresh.id, carriedContext: false };
  }

  const messages = listMessages(active.id, 1000);
  const lastAgentMessage = [...messages].reverse().find(m => m.role === "agent");
  if (!lastAgentMessage) {
    // Active session but no prior agent intent — just use it
    return { sessionId: active.id, carriedContext: true };
  }

  try {
    const relatedness = await classifySessionRelatedness({
      priorIntent: lastAgentMessage.content,
      priorSummary: active.contextSummary,
      newIntent: args.intent,
    });
    if (relatedness.verdict === "continues") {
      return { sessionId: active.id, carriedContext: true };
    }
  } catch (err) {
    // LLM failure shouldn't block; default to new session for safety.
    console.warn("[i402 planner] session relatedness check failed, defaulting to new session:", err);
  }

  // New goal — close the prior as completed and create a fresh one
  updateSessionStatus(active.id, "completed");
  const fresh = createSession({ walletAddress: args.walletAddress, budgetUsdc: args.budgetUsdc });
  return { sessionId: fresh.id, carriedContext: false };
}

// -------------------- Main entry --------------------

export interface GeneratePlanOptions {
  forceNewSession?: boolean;
}

export async function generatePlan(
  request: PlannerRequest,
  options: GeneratePlanOptions = {}
): Promise<PlanOrClarification> {
  if (!request.walletAddress) throw new Error("walletAddress is required");
  if (!request.intent || request.intent.trim().length === 0) throw new Error("intent is required");
  if (request.budgetUsdc <= 0) throw new Error("budgetUsdc must be positive");

  // Resolve session: honor explicit sessionId if passed; otherwise find-or-create by wallet.
  let sessionId = request.sessionId;
  if (!sessionId) {
    const resolved = await resolveSessionForWallet({
      walletAddress: request.walletAddress,
      intent: request.intent,
      budgetUsdc: request.budgetUsdc,
      forceNewSession: options.forceNewSession === true,
    });
    sessionId = resolved.sessionId;
  }

  const bound: PlannerRequest = { ...request, sessionId };

  // Log the agent's intent
  appendMessage({ sessionId, role: "agent", content: request.intent });

  const session = getSession(sessionId);
  const classification = await classifyIntent(request.intent, session?.contextSummary);

  if (classification.classification === "ambiguous") {
    const questions: ClarificationQuestion[] = (classification.clarification_questions ?? []).map(
      (q, i) => ({ id: `q${i + 1}`, text: q })
    );
    if (questions.length === 0) {
      questions.push({
        id: "q1",
        text: "Could you provide more detail on what outcome you're looking for?",
      });
    }
    appendMessage({ sessionId, role: "clarification", content: JSON.stringify(questions) });
    const response: ClarificationResponse = {
      sessionId,
      status: "clarification_needed",
      questions,
    };
    return response;
  }

  if (classification.classification === "direct") return directPlan(bound, classification);
  return compoundPlan(bound);
}

// -------------------- Plan lookup --------------------

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
  db.prepare(`UPDATE i402_session_plans SET status = ? WHERE id = ?`).run(status, planId);
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
} from "./i402-types";
