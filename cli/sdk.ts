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
    const data = await res.json() as any

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
  async socialTwitterLogin(accountId: string, login: string, password: string, totpSeed?: string): Promise<any> {
    return this.request('POST', '/social/twitter/login', {
      account_id: accountId,
      login,
      password,
      ...(totpSeed ? { totp_seed: totpSeed } : {}),
    })
  }

  // ── Info ──
  async pricing(): Promise<any> {
    return this.request('GET', '/pricing')
  }

  async health(): Promise<any> {
    return this.request('GET', '/health')
  }
}

export default AgentOS
