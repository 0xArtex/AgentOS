/**
 * LLM-evaluated brief — Phase 3.5.
 *
 * Calls the Anthropic Messages API directly (no SDK dep — keeps the CLI's
 * dependency surface tight). Asks Claude Haiku to assess whether the
 * trader's plain-string thesis still holds given the position's current
 * numeric state. The model has no live market data — its judgment is
 * limited to the thesis text + the PnL/time signals we feed it.
 */
import type { PositionFile } from './wallet-trading.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'

export interface LLMBriefResult {
  thesisHolds: 'yes' | 'no' | 'unclear'
  reasoning: string
  recommendedAction: 'hold' | 'exit' | 'trim' | 'wait'
  watchFor: string
  model: string
  rawResponse?: string
}

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text?: string }>
}

export async function evaluateBriefWithLLM(p: PositionFile): Promise<LLMBriefResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY env var required for `brief --evaluate`. Set it in .env or your shell.',
    )
  }

  const prompt = buildPrompt(p)
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = (await res.json()) as AnthropicMessagesResponse
  const text = data.content?.find((c) => c.type === 'text')?.text ?? ''
  return parseLLMResponse(text)
}

function buildPrompt(p: PositionFile): string {
  const entryTime = new Date(p.entry.time)
  const elapsedMs = Date.now() - entryTime.getTime()
  const elapsedHours = (elapsedMs / 3_600_000).toFixed(1)
  const riskFlags = p.riskFlags.length > 0 ? p.riskFlags.join(', ') : 'none'
  const lastPriced = p.pnl.lastPricedAt ?? 'never (run `wallet sync` first)'
  const exitPlan = [
    p.exitPlan.cut ? `cut=${p.exitPlan.cut}` : null,
    p.exitPlan.takeProfit ? `tp=${p.exitPlan.takeProfit}` : null,
    p.exitPlan.trailingStop ? `trail=${p.exitPlan.trailingStop}` : null,
    p.exitPlan.timeLimit ? `timeLimit=${p.exitPlan.timeLimit}` : null,
    p.exitPlan.holdIf ? `holdIf=${p.exitPlan.holdIf}` : null,
  ].filter(Boolean).join(' | ') || 'none'

  // Read canonical asset-tagged PnL — the field reflects what the position
  // was actually funded in (USDC for USDC-funded positions, not the chain's
  // native asset).
  const realized = p.pnl.realized?.amount ?? 0
  const unit = p.pnl.realized?.asset ?? (p.chain === 'solana' ? 'SOL' : 'ETH')
  return `You are reviewing a ${p.chain === 'base' ? 'Base' : 'Solana'} trading position. The trader entered with this plain-string thesis:

THESIS: ${p.thesis}

Current state:
- Position opened: ${elapsedHours}h ago (${p.entry.time})
- Entry: ${p.entry.amountIn} → ${p.entry.tokensOut} tokens
- Unrealized PnL: ${p.pnl.unrealizedPct.toFixed(2)}%
- Realized PnL: ${realized.toFixed(6)} ${unit} (${p.sells.length} prior sells)
- Status: ${p.status}
- Last priced: ${lastPriced}
- Risk flags: ${riskFlags}
- Exit plan: ${exitPlan}

Assess whether the original thesis is still valid based on the position's evolution. Note: you don't have access to fresh market data or social signals — base your judgment only on the thesis text + the numeric state above. Be honest about uncertainty.

Return ONLY a JSON object with this exact shape (no markdown fences, no preamble):

{
  "thesis_holds": "yes" | "no" | "unclear",
  "reasoning": "1-2 sentences explaining the assessment",
  "recommended_action": "hold" | "exit" | "trim" | "wait",
  "watch_for": "1 sentence on the key signal to watch next"
}`
}

function parseLLMResponse(text: string): LLMBriefResult {
  // Strip optional markdown fences (model sometimes wraps in ```json...```)
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(stripped) as {
      thesis_holds?: string
      reasoning?: string
      recommended_action?: string
      watch_for?: string
    }
    return {
      thesisHolds: (parsed.thesis_holds as 'yes' | 'no' | 'unclear') ?? 'unclear',
      reasoning: parsed.reasoning ?? '',
      recommendedAction:
        (parsed.recommended_action as 'hold' | 'exit' | 'trim' | 'wait') ?? 'hold',
      watchFor: parsed.watch_for ?? '',
      model: MODEL,
      rawResponse: text,
    }
  } catch {
    return {
      thesisHolds: 'unclear',
      reasoning: `(JSON parse failed; raw: ${text.slice(0, 200)}...)`,
      recommendedAction: 'hold',
      watchFor: '',
      model: MODEL,
      rawResponse: text,
    }
  }
}
