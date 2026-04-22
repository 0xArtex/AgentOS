/**
 * AgentOS SDK — programmatic access to all AgentOS services.
 */

const DEFAULT_API = 'https://agntos.dev'

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
  async emailCreate(name: string, walletAddress: string): Promise<any> {
    return this.request('POST', '/email/inboxes', { name, walletAddress })
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

  async domainPricing(domain: string): Promise<any> {
    return this.request('GET', `/domains/pricing?domain=${domain}`)
  }

  async domainBuy(domain: string): Promise<any> {
    return this.request('POST', '/domains/register', { domain })
  }

  async domainDns(domain: string): Promise<any> {
    return this.request('GET', `/domains/${domain}/dns`)
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

  // ── i402 — intent-fulfillment protocol ──

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
   * Execute an approved i402 plan, yielding ExecutorEvents as they arrive via SSE.
   * Auto-pays `plan.total_cost_usdc` (read from the server's 402 advertisement).
   *
   * Usage:
   *   const plan = await ao.chat(...)
   *   for await (const event of ao.chatExecute(plan.session_id, plan.plan_id)) {
   *     console.log(event.type, event)
   *   }
   */
  async *chatExecute(
    sessionId: string,
    planId: string,
    options: { approve?: boolean; execution?: 'server_side' | 'agent_side' | 'hybrid' } = {},
  ): AsyncGenerator<any, void, undefined> {
    const body: Record<string, unknown> = {
      plan_id: planId,
      approve: options.approve !== false,
      execution: options.execution ?? 'server_side',
    }

    const { paidStreamRequest } = await import('./pay.js')
    const { response } = await paidStreamRequest(this.api, 'POST', `/chat/${sessionId}/execute`, body, this.passphrase)

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`chatExecute failed (${response.status}): ${text.slice(0, 300)}`)
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      // Server responded with JSON (e.g., immediate error). Yield once as a best-effort.
      const data = await response.json().catch(() => ({}))
      yield { type: 'step_error', stepId: '__unknown__', provider: 'i402_server', error: (data as any).error ?? 'non-stream response', fatal: true }
      return
    }

    // Parse SSE frames
    const reader = (response.body as any)?.getReader?.()
    if (!reader) throw new Error('Response body is not a readable stream')
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? '' // last incomplete frame stays in buffer
      for (const frame of frames) {
        if (!frame.trim()) continue
        const dataLine = frame.split('\n').find(line => line.startsWith('data:'))
        if (!dataLine) continue
        try {
          const event = JSON.parse(dataLine.slice('data:'.length).trim())
          yield event
        } catch {
          // skip malformed
        }
      }
    }
  }

  async chatGetSession(sessionId: string): Promise<any> {
    return this.requestWithHeaders('GET', `/chat/${sessionId}`, undefined, { 'X-Session-Id': sessionId })
  }

  async chatGetSpend(sessionId: string): Promise<any> {
    return this.requestWithHeaders('GET', `/chat/${sessionId}/spend`, undefined, { 'X-Session-Id': sessionId })
  }

  async chatCancel(sessionId: string): Promise<any> {
    return this.requestWithHeaders('POST', `/chat/${sessionId}/cancel`, undefined, { 'X-Session-Id': sessionId })
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
