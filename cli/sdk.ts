/**
 * AgentOS SDK — programmatic access to all AgentOS services.
 */

const DEFAULT_API = 'https://agntos.dev'

// -------------------- Client-side executor helpers --------------------

/** Topological order of plan steps using their `depends_on` arrays. */
function topoOrderSteps(steps: any[]): any[] {
  const byId = new Map<string, any>(steps.map(s => [s.step_id, s]))
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const s of steps) {
    indegree.set(s.step_id, Array.isArray(s.depends_on) ? s.depends_on.length : 0)
    for (const dep of s.depends_on ?? []) {
      if (!byId.has(dep)) throw new Error(`step ${s.step_id} depends on unknown step ${dep}`)
      if (!outgoing.has(dep)) outgoing.set(dep, [])
      outgoing.get(dep)!.push(s.step_id)
    }
    if (!outgoing.has(s.step_id)) outgoing.set(s.step_id, [])
  }
  const order: any[] = []
  const ready: string[] = []
  for (const [id, deg] of indegree) if (deg === 0) ready.push(id)
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(byId.get(id)!)
    for (const dep of outgoing.get(id) ?? []) {
      const next = (indegree.get(dep) ?? 0) - 1
      indegree.set(dep, next)
      if (next === 0) ready.push(dep)
    }
  }
  if (order.length !== steps.length) throw new Error('plan has a dependency cycle')
  return order
}

/**
 * Resolve a $STEPS.sN.output.path expression against prior outputs.
 * Two modes:
 *   - whole-field: "$STEPS.s1.output.field" → returns the resolved value verbatim
 *     (could be any type — object, array, string, number)
 *   - embedded: "hello $STEPS.s1.output.field" → scans and substitutes the match
 *     (resolved values are coerced to strings)
 */
function resolveOne(stepId: string, path: string | undefined, priorOutputs: Record<string, any>): any {
  const base = priorOutputs[stepId]
  if (base === undefined) return undefined
  if (!path) return base
  const segments = path.split(/\.|\[(\d+)\]/).filter(s => s !== undefined && s !== '')
  let cursor: any = base
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined
    if (/^\d+$/.test(seg) && Array.isArray(cursor)) {
      cursor = cursor[parseInt(seg, 10)]
    } else if (typeof cursor === 'object') {
      // Try exact, then camelCase, then snake_case — schemas drift from
      // actual server responses; the resolver shouldn't punish either side.
      if (seg in cursor) {
        cursor = cursor[seg]
      } else {
        const camel = seg.replace(/_([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())
        const snake = seg.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
        if (camel in cursor) cursor = cursor[camel]
        else if (snake in cursor) cursor = cursor[snake]
        else return undefined
      }
    } else {
      return undefined
    }
  }
  return cursor
}

function resolveTemplateValue(value: any, priorOutputs: Record<string, any>): any {
  if (typeof value !== 'string') return value

  // Whole-field match: the string is *only* a template expression. Return the
  // resolved value verbatim (may be non-string).
  const whole = value.match(/^\$STEPS\.([a-zA-Z0-9_]+)\.output(?:\.(.+))?$/)
  if (whole) {
    const resolved = resolveOne(whole[1], whole[2], priorOutputs)
    if (resolved === undefined) {
      const stepOutput = priorOutputs[whole[1]]
      const detail = stepOutput === undefined
        ? `step '${whole[1]}' has not run yet (missing depends_on?)`
        : `step '${whole[1]}' produced ${JSON.stringify(stepOutput)} which has no '${whole[2]}' field`
      throw new Error(`Could not resolve template "${value}" — ${detail}`)
    }
    return resolved
  }

  // Embedded match: substitute every $STEPS.X.output(.path) occurrence with its
  // string-coerced resolved value. Path is a sequence of .name or [n] segments.
  const embeddedPattern = /\$STEPS\.([a-zA-Z0-9_]+)\.output((?:\.[a-zA-Z0-9_]+|\[\d+\])*)/g
  if (!embeddedPattern.test(value)) return value
  // Re-run since test() advances lastIndex on /g patterns
  return value.replace(/\$STEPS\.([a-zA-Z0-9_]+)\.output((?:\.[a-zA-Z0-9_]+|\[\d+\])*)/g, (match, stepId, pathChain) => {
    const path = pathChain.replace(/^\./, '') || undefined
    const resolved = resolveOne(stepId, path, priorOutputs)
    if (resolved === undefined) {
      const stepOutput = priorOutputs[stepId]
      const detail = stepOutput === undefined
        ? `step '${stepId}' has not run yet`
        : `step '${stepId}' has no '${path}' field`
      throw new Error(`Could not resolve template "${match}" inside "${value}" — ${detail}`)
    }
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
  })
}

/** Walk an input object deeply, resolving every templated string leaf. */
function resolveStepInput(input: any, priorOutputs: Record<string, any>): any {
  if (input === null || input === undefined) return input
  if (typeof input === 'string') return resolveTemplateValue(input, priorOutputs)
  if (Array.isArray(input)) return input.map(v => resolveStepInput(v, priorOutputs))
  if (typeof input === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(input)) out[k] = resolveStepInput(v, priorOutputs)
    return out
  }
  return input
}

/**
 * Substitute {field_name} placeholders in an endpoint URL from the step's input.
 * Fields consumed into the path are REMOVED from the returned body so they
 * don't get sent twice. If a placeholder has no matching input, throws — the
 * executor surfaces that as a step_error.
 */
function substitutePathParams(
  endpoint: string,
  input: Record<string, any>,
): { url: string; body: Record<string, any> } {
  const body: Record<string, any> = { ...input }
  const url = endpoint.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, field) => {
    if (!(field in body)) {
      const present = Object.keys(input).join(', ') || '(empty)'
      throw new Error(
        `endpoint ${endpoint} requires path param '${field}' but step input has no such field. ` +
        `Input fields present: ${present}. ` +
        `If '${field}' should come from a prior step, the planner must include it as "$STEPS.sN.output.FIELD".`
      )
    }
    const value = body[field]
    delete body[field]
    return encodeURIComponent(String(value))
  })
  return { url, body }
}

export class AgentOS {
  public api: string
  public token?: string
  public passphrase?: string
  private autoPay: boolean

  constructor(apiUrl?: string, autoPay?: boolean, token?: string, passphrase?: string) {
    this.api = apiUrl || process.env.AGENTOS_API || DEFAULT_API
    this.token = token || process.env.AGENTOS_TOKEN || process.env.AGENTOS_API_KEY
    this.passphrase = passphrase || process.env.AGENTOS_WALLET_PASSPHRASE
    this.autoPay = autoPay ?? true
  }

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    const opts: RequestInit = { method, headers }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(this.api + path, opts)

    // Some edge layers (CDN, nginx) return HTML error pages for transient
    // upstream failures. Detect that before trying JSON.parse so the agent
    // gets a usable error instead of "Unexpected token '<'".
    const contentType = res.headers.get('content-type') || ''
    let data: any
    if (contentType.includes('application/json')) {
      data = await res.json().catch(() => ({ error: 'Invalid JSON response from server' }))
    } else {
      const text = await res.text().catch(() => '')
      if (res.status === 402) {
        // 402 without JSON body still handled by paidRequest below.
        data = {}
      } else {
        throw new Error(
          `Server returned ${res.status} ${res.statusText} with non-JSON body ` +
          `(${contentType || 'no content-type'}). This is usually a transient CDN/nginx error — retry in a moment. ` +
          `First 200 chars: ${text.slice(0, 200)}`
        )
      }
    }

    // If 402 and autoPay enabled, try to pay (uses local vault wallet via pay.ts)
    if (res.status === 402 && this.autoPay) {
      try {
        const { paidRequest } = await import('./pay.js')
        const result = await paidRequest(this.api, method, path, body, this.passphrase)
        return result.data
      } catch (e: any) {
        throw new Error(e.message)
      }
    }

    if (data.error) throw new Error(data.error)
    return data
  }

  // ── Phone ──
  async phoneSearch(country: string, limit?: number): Promise<any> {
    return this.request('GET', `/phone/numbers/search?country=${country}${limit ? '&limit=' + limit : ''}`)
  }

  async phoneBuy(country: string, areaCode?: string): Promise<any> {
    return this.request('POST', '/phone/numbers', { country, ...(areaCode ? { areaCode } : {}) })
  }

  async phoneSms(phoneId: string, to: string, body: string): Promise<any> {
    return this.request('POST', `/phone/numbers/${phoneId}/send`, { to, body })
  }

  async phoneCall(phoneId: string, to: string, tts?: string): Promise<any> {
    return this.request('POST', `/phone/numbers/${phoneId}/call`, { to, tts })
  }

  // ── Email ──
  async emailCreate(name: string, walletAddress?: string, domain?: string): Promise<any> {
    const body: Record<string, unknown> = { name }
    if (walletAddress) body.walletAddress = walletAddress
    if (domain) body.domain = domain
    return this.request('POST', '/email/inboxes', body)
  }

  async emailListInboxes(): Promise<any> {
    return this.request('GET', '/email/inboxes')
  }

  async emailRead(inboxId: string): Promise<any> {
    return this.request('GET', `/email/inboxes/${inboxId}/messages`)
  }

  async emailSend(inboxId: string, to: string, subject: string, body: string): Promise<any> {
    return this.request('POST', `/email/inboxes/${inboxId}/send`, { to, subject, body })
  }

  async emailThreads(inboxId: string): Promise<any> {
    return this.request('GET', `/email/inboxes/${inboxId}/threads`)
  }

  // ── Compute ──
  async computePlans(): Promise<any> {
    return this.request('GET', '/compute/plans')
  }

  async computeDeploy(name: string, serverType: string): Promise<any> {
    return this.request('POST', '/compute/servers', { name, serverType, image: 'ubuntu-24.04', installOpenClaw: true })
  }

  async computeList(): Promise<any> {
    return this.request('GET', '/compute/servers')
  }

  async computeDelete(serverId: string): Promise<any> {
    return this.request('DELETE', `/compute/servers/${serverId}`)
  }

  // ── Domains ──
  async domainCheck(domain: string): Promise<any> {
    return this.request('GET', `/domains/check?domain=${domain}`)
  }

  async domainList(): Promise<any> {
    return this.request('GET', '/domains')
  }

  async domainPricing(domain: string): Promise<any> {
    return this.request('GET', `/domains/pricing?domain=${domain}`)
  }

  async domainBuy(domain: string): Promise<any> {
    return this.request('POST', '/domains/register', { domain })
  }

  async domainDns(domain: string): Promise<any> {
    return this.request('GET', `/domains/${domain}/dns`)
  }

  async domainTransferOwnership(domain: string, newOwner: string): Promise<any> {
    return this.request('POST', `/domains/${domain}/transfer-ownership`, { new_owner: newOwner })
  }

  // ── Wallet ──
  async walletCreate(label?: string, chains?: string[], mode?: 'unmanaged' | 'managed'): Promise<any> {
    return this.request('POST', '/wallet', { label, chains, mode })
  }

  async walletImport(mnemonic: string, label?: string, mode?: 'unmanaged' | 'managed'): Promise<any> {
    return this.request('POST', '/wallet/import', { mnemonic, label, mode })
  }

  async walletList(): Promise<any> {
    return this.request('GET', '/wallet')
  }

  async walletGet(walletId: string): Promise<any> {
    return this.request('GET', `/wallet/${walletId}`)
  }

  async walletDelete(walletId: string): Promise<any> {
    return this.request('DELETE', `/wallet/${walletId}`)
  }

  async walletAddresses(walletId: string): Promise<any> {
    return this.request('GET', `/wallet/${walletId}/addresses`)
  }

  async walletDerive(walletId: string, chain: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/derive`, { chain })
  }

  /** Sign a transaction. Auth resolved from API key or session secret. */
  async walletSign(walletId: string, chain: string, transaction: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/sign`, { chain, transaction })
  }

  async walletSignMessage(walletId: string, chain: string, message: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/sign-message`, { chain, message })
  }

  async walletSignTyped(walletId: string, chain: string, typedData: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/sign-typed`, { chain, typedData })
  }

  async walletPolicy(walletId: string, policy: { per_tx_usdc?: number; daily_usdc?: number; allowed_chains?: string[] }): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/policy`, { policy })
  }

  async walletGetPolicy(walletId: string): Promise<any> {
    return this.request('GET', `/wallet/${walletId}/policy`)
  }

  async walletSpending(walletId: string): Promise<any> {
    return this.request('GET', `/wallet/${walletId}/spending`)
  }

  async walletApiKey(walletId: string, name: string, sessionSecret: string, policyIds?: string[], expiresAt?: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/api-key`, { name, sessionSecret, policyIds, expiresAt })
  }

  async walletRevokeApiKey(walletId: string, keyId: string): Promise<any> {
    return this.request('DELETE', `/wallet/${walletId}/api-key`, { keyId })
  }

  async walletConfig(walletId: string, sessionSecret: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/config`, { sessionSecret })
  }

  async walletRequestApproval(walletId: string, action: string, params: Record<string, any>): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/request-approval`, { action, ...params })
  }

  // ── Social ──
  async socialTwitterLogin(
    accountId: string,
    login: string,
    password: string,
    totpSeed?: string,
    cookies?: { auth_token?: string; ct0?: string },
    proxySessionId?: string
  ): Promise<any> {
    return this.request('POST', '/social/twitter/login', {
      account_id: accountId,
      ...(proxySessionId ? { proxy_session_id: proxySessionId } : {}),
      login,
      password,
      ...(totpSeed ? { totp_seed: totpSeed } : {}),
      ...(cookies?.auth_token ? { auth_token: cookies.auth_token } : {}),
      ...(cookies?.ct0 ? { ct0: cookies.ct0 } : {}),
    })
  }

  async socialTwitterPost(accountId: string, cookies: any[], text: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/post', { account_id: accountId, proxy_session_id: proxySessionId, cookies, text })
  }
  async socialTwitterReply(accountId: string, cookies: any[], tweetUrl: string, text: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/reply', { account_id: accountId, proxy_session_id: proxySessionId, cookies, tweet_url: tweetUrl, text })
  }
  async socialTwitterLike(accountId: string, cookies: any[], tweetUrl: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/like', { account_id: accountId, proxy_session_id: proxySessionId, cookies, tweet_url: tweetUrl })
  }
  async socialTwitterRetweet(accountId: string, cookies: any[], tweetUrl: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/retweet', { account_id: accountId, proxy_session_id: proxySessionId, cookies, tweet_url: tweetUrl })
  }
  async socialTwitterFollow(accountId: string, cookies: any[], targetUser: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/follow', { account_id: accountId, proxy_session_id: proxySessionId, cookies, target_user: targetUser })
  }
  async socialTwitterUnfollow(accountId: string, cookies: any[], targetUser: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/unfollow', { account_id: accountId, proxy_session_id: proxySessionId, cookies, target_user: targetUser })
  }
  async socialTwitterDelete(accountId: string, cookies: any[], tweetUrl: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/delete', { account_id: accountId, proxy_session_id: proxySessionId, cookies, tweet_url: tweetUrl })
  }
  async socialTwitterProfile(
    accountId: string,
    cookies: any[],
    patch: { bio?: string; display_name?: string; location?: string; website?: string },
    proxySessionId?: string
  ): Promise<any> {
    return this.request('POST', '/social/twitter/profile', { account_id: accountId, proxy_session_id: proxySessionId, cookies, ...patch })
  }
  async socialTwitterAvatar(
    accountId: string,
    cookies: any[],
    image: { image_base64?: string; image_url?: string },
    proxySessionId?: string
  ): Promise<any> {
    return this.request('POST', '/social/twitter/avatar', { account_id: accountId, proxy_session_id: proxySessionId, cookies, ...image })
  }
  async socialTwitterBanner(
    accountId: string,
    cookies: any[],
    image: { image_base64?: string; image_url?: string },
    proxySessionId?: string
  ): Promise<any> {
    return this.request('POST', '/social/twitter/banner', { account_id: accountId, proxy_session_id: proxySessionId, cookies, ...image })
  }
  async socialTwitterUsername(
    accountId: string,
    cookies: any[],
    newUsername: string,
    password: string,
    proxySessionId?: string
  ): Promise<any> {
    return this.request('POST', '/social/twitter/username', {
      account_id: accountId,
      proxy_session_id: proxySessionId,
      cookies,
      new_username: newUsername,
      password,
    })
  }

  async socialTwitterBuy(country?: string, ageCategory?: string): Promise<any> {
    return this.request('POST', '/social/twitter/buy', {
      ...(country ? { country } : {}),
      ...(ageCategory ? { age_category: ageCategory } : {}),
    })
  }

  // ── TikTok ──
  /**
   * Log a TikTok account in. Two paths:
   *   - Cookie injection: pass `sessionid` (+ optional `tt_csrf_token`, `tt_webid_v2`).
   *   - Form login:       pass `login` + `password` — server uses CapSolver
   *                       to handle any captcha and harvests the cookies.
   * Either path returns the full cookie jar for the caller to cache locally.
   */
  async socialTiktokLogin(
    accountId: string,
    opts: {
      sessionid?: string
      ttCsrfToken?: string
      ttWebidV2?: string
      extraCookies?: Array<{ name: string; value: string; domain?: string; path?: string }>
      login?: string
      password?: string
      email?: string
      emailPassword?: string
      proxySessionId?: string
      country?: string
    },
  ): Promise<any> {
    return this.request('POST', '/social/tiktok/login', {
      account_id: accountId,
      proxy_session_id: opts.proxySessionId,
      country: opts.country,
      sessionid: opts.sessionid,
      tt_csrf_token: opts.ttCsrfToken,
      tt_webid_v2: opts.ttWebidV2,
      extra_cookies: opts.extraCookies,
      login: opts.login,
      password: opts.password,
      email: opts.email,
      email_password: opts.emailPassword,
    })
  }

  async socialTiktokPost(
    accountId: string,
    cookies: any[],
    caption: string,
    media: { video_base64?: string; video_url?: string },
    opts?: { privacy?: 0 | 1 | 2; allow_comments?: boolean; allow_duet?: boolean; allow_stitch?: boolean },
    proxySessionId?: string,
    country?: string,
  ): Promise<any> {
    return this.request('POST', '/social/tiktok/post', {
      account_id: accountId,
      proxy_session_id: proxySessionId,
      country,
      cookies,
      caption,
      ...media,
      ...(opts || {}),
    })
  }

  async socialTiktokFollow(accountId: string, cookies: any[], targetUser: string, proxySessionId?: string, country?: string): Promise<any> {
    return this.request('POST', '/social/tiktok/follow', { account_id: accountId, proxy_session_id: proxySessionId, country, cookies, target_user: targetUser })
  }

  async socialTiktokLike(accountId: string, cookies: any[], videoUrl: string, proxySessionId?: string, country?: string): Promise<any> {
    return this.request('POST', '/social/tiktok/like', { account_id: accountId, proxy_session_id: proxySessionId, country, cookies, video_url: videoUrl })
  }

  async socialTiktokDelete(accountId: string, cookies: any[], videoUrl: string, proxySessionId?: string, country?: string): Promise<any> {
    return this.request('POST', '/social/tiktok/delete', { account_id: accountId, proxy_session_id: proxySessionId, country, cookies, video_url: videoUrl })
  }

  async socialTiktokProfile(
    accountId: string,
    cookies: any[],
    patch: { bio?: string; display_name?: string },
    proxySessionId?: string,
    country?: string,
  ): Promise<any> {
    return this.request('POST', '/social/tiktok/profile', { account_id: accountId, proxy_session_id: proxySessionId, country, cookies, ...patch })
  }

  async socialTiktokAvatar(
    accountId: string,
    cookies: any[],
    image: { image_base64?: string; image_url?: string },
    proxySessionId?: string,
    country?: string,
  ): Promise<any> {
    return this.request('POST', '/social/tiktok/avatar', { account_id: accountId, proxy_session_id: proxySessionId, country, cookies, ...image })
  }

  // ── Info ──
  async pricing(): Promise<any> {
    return this.request('GET', '/pricing')
  }

  async health(): Promise<any> {
    return this.request('GET', '/health')
  }

  // ── i402 — intent layer for x402 ──

  /**
   * Generate an i402 plan from a natural-language intent.
   * Returns the plan body (from the 402 response) or a clarification request.
   * Auto-pays the $0.10 orchestration fee unless autoPay is disabled.
   */
  async chat(
    intent: string,
    options: {
      budgetUsdc: number
      quality?: 'fast' | 'cheap' | 'best'
      params?: Record<string, unknown>
      constraints?: {
        excludeCapabilities?: string[]
        excludeProviders?: string[]
        requireProviders?: string[]
      }
      sessionId?: string
      deadlineSeconds?: number
      approve?: boolean
      autoApproveUnderUsdc?: number
    },
  ): Promise<any> {
    const body: Record<string, unknown> = {
      intent,
      budget_usdc: options.budgetUsdc,
    }
    if (options.quality) body.quality = options.quality
    if (options.params) body.params = options.params
    if (options.constraints) body.constraints = options.constraints
    if (options.deadlineSeconds) body.deadline_seconds = options.deadlineSeconds
    if (options.approve !== undefined) body.approve = options.approve
    if (options.autoApproveUnderUsdc !== undefined) body.auto_approve_under_usdc = options.autoApproveUnderUsdc

    const extraHeaders: Record<string, string> = {}
    if (options.sessionId) extraHeaders['X-Session-Id'] = options.sessionId

    return this.requestWithHeaders('POST', '/chat', body, extraHeaders)
  }

  /**
   * Client-side executor for an i402 plan.
   *
   * i402 v0.1 is agent-side-execution-only: the server returns a plan and stops;
   * this function iterates the plan's steps in topological order, signs a real
   * x402 payment for each step (via paidRequest), calls the endpoint, resolves
   * $STEPS.sN.output.field references into later-step inputs locally, and yields
   * events to the caller so a CLI or agent framework can render progress.
   *
   * Every step's x402 payment is a real on-chain transaction signed by this
   * client's wallet — no server-side escrow, no custodial proxy.
   *
   * Usage:
   *   const plan = await ao.chat("launch a brand", { budgetUsdc: 60 })
   *   for await (const event of ao.chatExecute(plan)) {
   *     console.log(event.type, event)
   *   }
   */
  async *chatExecute(
    plan: any,
    options: { stopOnFailure?: boolean } = {},
  ): AsyncGenerator<any, void, undefined> {
    if (!plan?.plan_id || !Array.isArray(plan?.steps)) {
      throw new Error('chatExecute requires a plan returned from chat()')
    }
    const stopOnFailure = options.stopOnFailure !== false

    yield { type: 'session', sessionId: plan.session_id }
    yield {
      type: 'plan',
      planId: plan.plan_id,
      steps: plan.steps.map((s: any) => ({
        stepId: s.step_id,
        provider: s.provider,
        capability: s.capability,
        costUsdc: s.cost_usdc,
      })),
      totalCostUsdc: plan.totals?.total_cost_usdc,
    }

    const ordered = topoOrderSteps(plan.steps)
    const priorOutputs: Record<string, any> = {}
    let encounteredFatal = false
    let totalSpent = 0

    const { paidRequest } = await import('./pay.js')

    for (const step of ordered) {
      const resolvedInput = resolveStepInput(step.input, priorOutputs)

      yield {
        type: 'step_start',
        stepId: step.step_id,
        provider: step.provider,
        capability: step.capability,
        costUsdc: step.cost_usdc,
      }

      const startMs = Date.now()
      try {
        // Substitute {placeholder} path params from input → concrete URL + pruned body
        const { url: concreteUrl, body: postBody } = substitutePathParams(
          step.x402?.endpoint ?? '',
          resolvedInput as Record<string, any>,
        )
        const url = new URL(concreteUrl)
        const path = url.pathname + url.search
        const api = `${url.protocol}//${url.host}`
        const method = (step.x402?.method ?? 'POST').toUpperCase()
        const result = await paidRequest(api, method, path, postBody, this.passphrase)
        const latencyMs = Date.now() - startMs
        const output = result.data
        priorOutputs[step.step_id] = output
        totalSpent += Number(step.cost_usdc ?? 0)
        yield {
          type: 'step_result',
          stepId: step.step_id,
          provider: step.provider,
          output,
          latencyMs,
          costChargedUsdc: step.cost_usdc,
          txSignature: result.txHash,
        }
      } catch (err: any) {
        const latencyMs = Date.now() - startMs
        const message = err?.message ?? String(err)
        encounteredFatal = true
        yield {
          type: 'step_error',
          stepId: step.step_id,
          provider: step.provider,
          error: message,
          latencyMs,
          fatal: stopOnFailure,
        }
        if (stopOnFailure) break
      }
    }

    yield {
      type: 'summary',
      spentUsdc: totalSpent,
      status: encounteredFatal ? 'failed' : 'completed',
    }
  }

  async chatGetSession(sessionId: string): Promise<any> {
    return this.request('GET', `/chat/${sessionId}`)
  }

  async chatCancel(sessionId: string): Promise<any> {
    return this.request('POST', `/chat/${sessionId}/cancel`)
  }

  async chatListSessions(): Promise<any> {
    return this.request('GET', '/chat')
  }

  async chatListCapabilities(): Promise<any> {
    return this.request('GET', '/chat/capabilities')
  }

  async chatListProviders(capability?: string): Promise<any> {
    const qs = capability ? `?capability=${encodeURIComponent(capability)}` : ''
    return this.request('GET', `/chat/providers${qs}`)
  }

  // ── Internal: variant of request() that supports extra headers ──
  private async requestWithHeaders(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    const opts: RequestInit = { method, headers }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(this.api + path, opts)

    const contentType = res.headers.get('content-type') || ''
    let data: any
    if (contentType.includes('application/json')) {
      data = await res.json().catch(() => ({}))
    } else {
      data = {}
    }

    if (res.status === 402 && this.autoPay) {
      try {
        const { paidRequest } = await import('./pay.js')
        const result = await paidRequest(this.api, method, path, body, this.passphrase)
        return result.data
      } catch (e: any) {
        throw new Error(e.message)
      }
    }

    if (data.error && res.status >= 400) throw new Error(data.error)
    return data
  }
}

export default AgentOS
