/**
 * AgentOS SDK — programmatic access to all AgentOS services.
 */

const DEFAULT_API = 'https://agntos.dev'

export class AgentOS {
  public api: string
  private autoPay: boolean

  constructor(apiUrl?: string, autoPay?: boolean) {
    this.api = apiUrl || process.env.AGENTOS_API || DEFAULT_API
    this.autoPay = autoPay ?? true
  }

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<any> {
    const opts: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(this.api + path, opts)
    const data = await res.json() as any

    // If 402 and autoPay enabled, try to pay
    if (res.status === 402 && this.autoPay) {
      try {
        const { paidRequest } = await import('./pay.js')
        const result = await paidRequest(this.api, method, path, body)
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

  // ── Wallet (proxy to agentwallet API) ──
  async walletCreate(agent: string, chain?: string): Promise<any> {
    return this.request('POST', '/wallet', { agent, mode: 'managed', chain: chain || 'base' })
  }

  async walletStatus(address: string): Promise<any> {
    return this.request('GET', `/wallet/${address}`)
  }

  async walletKeygen(chain?: string): Promise<any> {
    return this.request('POST', '/wallet/keygen', { chain: chain || 'both' })
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
