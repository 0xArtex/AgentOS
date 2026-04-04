import React, { PropsWithChildren, useEffect, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'

import { MASCOT_HERO } from './mascot-data.js'

export type DashboardProps = {
  version: string
  chain?: string
  wallets?: Record<string, { keyfile: string }> | undefined
  apiOk?: boolean
  onSelectAction?: (command: string) => void
}

export type ScreenControls = {
  interactive?: boolean
  onBack?: () => void
}

export type StatusScreenProps = {
  version: string
  api: string
  apiOk: boolean
  wallets?: Record<string, { keyfile: string }> | undefined
  defaultChain?: string
}

export type SetupScreenProps = {
  version: string
  api: string
  keyfile: string
  chains: string[]
  addedChain: string
}

export type ComputePlansScreenProps = {
  version: string
  plans: Array<{ name: string; cpu: string; ram: string; price: string }>
}

export type DomainCheckScreenProps = {
  version: string
  domain: string
  available: boolean
}

export type DomainPricingScreenProps = {
  version: string
  query: string
  items: Array<{ tld: string; price: string }>
}

export type WalletCreateScreenProps = {
  version: string
  address: string
  chain: string
  setupUrl?: string
}

export type WalletStatusScreenProps = {
  version: string
  address: string
  owner: string
  dailyLimit?: string
  perTxLimit?: string
}

export type ComputeDeployScreenProps = {
  version: string
  ip: string
  id: string
  type: string
  name: string
}

export type ComputeListScreenProps = {
  version: string
  servers: Array<{ ip: string; type: string; status: string }>
}

export type SuccessScreenProps = {
  version: string
  title: string
  subtitle: string
  details: Array<{ label: string; value: string }>
  footerLeft: string
}

export type PricingScreenProps = {
  version: string
  services: Array<{ name: string; items: Array<{ label: string; value: string }> }>
}

export type HealthScreenProps = {
  version: string
  status: string
  uptime: string
  apiVersion: string
}

export type MenuScreenProps = {
  version: string
  title: string
  subtitle: string
  commands: Array<{ name: string; description: string; hint?: string }>
  footerLeft: string
}

export type RecordsScreenProps = {
  version: string
  title: string
  subtitle: string
  records: Array<{ primary: string; secondary?: string; status?: string }>
  footerLeft: string
}

export type ErrorScreenProps = {
  version: string
  title: string
  message: string
  hint?: string
  footerLeft: string
}

const palette = {
  text: 'white',
  muted: 'gray',
  dim: 'blackBright',
  accent: 'yellow',
  soft: 'yellowBright',
  success: 'greenBright',
  error: 'redBright',
} as const

function AutoExit() {
  const { exit } = useApp()
  useEffect(() => {
    const t = setTimeout(() => exit(), 10)
    return () => clearTimeout(t)
  }, [exit])
  return null
}

function MascotHero() {
  // Write mascot directly to stdout before Ink renders, bypassing Ink's width calc
  useEffect(() => {
    const lines = MASCOT_HERO.filter(line => {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/ /g, '')
      return stripped.length > 0
    })
    // Position at top-left of the card area and draw
    for (let i = 0; i < lines.length; i++) {
      process.stdout.write(`\x1b[${4 + i};3H${lines[i]}\x1b[0m`)
    }
  }, [])
  // Reserve vertical space in Ink layout
  return <Box height={16} width={32} />
}

function Mascot() {
  return <MascotHero />
}

function Card(props: PropsWithChildren<{ title?: string; width: number; borderColor?: string }>) {
  return (
    <Box flexDirection="column" width={props.width} borderStyle="round" borderColor={props.borderColor || palette.dim} paddingX={1} paddingY={0}>
      {props.title ? (
        <Box marginBottom={1}>
          <Text color={palette.accent}>{props.title}</Text>
        </Box>
      ) : null}
      {props.children}
    </Box>
  )
}

function Shell(props: PropsWithChildren<{ titleLeft: string; titleRight?: string; footerLeft?: string; autoExit?: boolean; onBack?: () => void; footerRight?: string }>) {
  useInput((input, key) => {
    if (props.onBack && (input === 'b' || key.escape)) props.onBack()
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      {props.autoExit === false ? null : <AutoExit />}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={palette.accent}>{props.titleLeft}</Text>
        <Text color={palette.dim}>{props.titleRight || ''}</Text>
      </Box>
      {props.children}
      {(props.footerLeft || props.footerRight) ? (
        <Box marginTop={1} justifyContent="space-between" borderStyle="round" borderColor={palette.dim} paddingX={1}>
          <Text color={palette.dim}>{props.footerLeft || ''}</Text>
          <Text color={palette.accent}>{props.footerRight || 'command bar'}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

function twoCol(termWidth: number, leftSize = 24) {
  const compact = termWidth < 100
  const total = Math.max(60, termWidth - 4)
  const left = compact ? total : leftSize
  const right = compact ? total : total - left - 2
  return { compact, left, right }
}

function MetaLine(props: { label: string; value: string }) {
  return (
    <Box>
      <Text color={palette.muted}>{props.label}: </Text>
      <Text color={palette.text}>{props.value}</Text>
    </Box>
  )
}

function DetailList(props: { items: Array<{ label: string; value: string }> }) {
  return (
    <Box flexDirection="column">
      {props.items.slice(0, 6).map((item, i) => (
        <Box key={`${item.label}-${i}`} marginBottom={i === props.items.length - 1 ? 0 : 1}>
          <Text color={palette.muted}>{item.label}: </Text>
          <Text color={palette.text}>{item.value}</Text>
        </Box>
      ))}
    </Box>
  )
}

function ActionList(props: { items: Array<{ label: string; command: string }>; selected: number }) {
  return (
    <Box flexDirection="column">
      {props.items.map((item, i) => (
        <Box key={item.command} flexDirection="column" marginBottom={1}>
          <Text color={props.selected === i ? palette.accent : palette.text}>{props.selected === i ? '▸ ' : '› '}{item.label}</Text>
          <Text color={palette.dim}>{item.command}</Text>
        </Box>
      ))}
    </Box>
  )
}

function ServiceList(props: { items: Array<{ name: string; summary: string }> }) {
  return (
    <Box flexDirection="column">
      {props.items.map((item, i) => (
        <Box key={`${item.name}-${i}`} marginBottom={1}>
          <Text color={palette.text}>{item.name}</Text>
          <Text color={palette.dim}> — {item.summary}</Text>
        </Box>
      ))}
    </Box>
  )
}

function CommandPalette(props: { value: string; onChange: (v: string) => void; results: Array<{ label: string; command: string }>; selected: number; width: number }) {
  return (
    <Card title="palette" width={props.width} borderColor={palette.accent}>
      <Box marginBottom={1}>
        <Text color={palette.accent}>› </Text>
        <TextInput value={props.value} onChange={props.onChange} />
      </Box>
      <ActionList items={props.results.slice(0, 5)} selected={props.selected} />
    </Card>
  )
}

function SimpleScreen(props: {
  title: string
  rightTitle?: string
  leftTitle?: string
  leftBody: React.ReactNode
  rightBody: React.ReactNode
  footer?: string
  interactive?: boolean
  onBack?: () => void
}) {
  const { stdout } = useStdout()
  const { compact, left, right } = twoCol(Math.max(80, stdout?.columns || 100))

  return (
    <Shell titleLeft={props.title} titleRight={props.rightTitle} footerLeft={props.interactive ? 'b/esc back' : props.footer} autoExit={props.interactive ? false : undefined} onBack={props.onBack}>
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title={props.leftTitle || 'summary'} width={left} borderColor={palette.accent}>
          {props.leftBody}
        </Card>
        {compact ? <Box height={1} /> : <Box width={2} />}
        <Card title="details" width={right}>
          {props.rightBody}
        </Card>
      </Box>
    </Shell>
  )
}

export function Dashboard(props: DashboardProps) {
  const { stdout } = useStdout()
  const { exit } = useApp()
  const { compact, left, right } = twoCol(Math.max(80, stdout?.columns || 100), 42)
  const hasWallets = !!props.wallets && Object.keys(props.wallets).length > 0
  const walletNames = hasWallets ? Object.keys(props.wallets!).join(', ') : 'none'
  const actions = useMemo(() => ([
    { label: 'Setup wallet', command: 'agentos setup --keyfile ~/.config/solana/id.json --chain solana' },
    { label: 'Status', command: 'agentos status' },
    { label: 'Compute plans', command: 'agentos compute plans' },
    { label: 'Domain check', command: 'agentos domain check --name myagent.dev' },
    { label: 'Pricing', command: 'agentos pricing' },
  ]), [])
  const services = useMemo(() => ([
    { name: 'Phone', summary: 'search · buy · sms · call' },
    { name: 'Email', summary: 'create · read · send' },
    { name: 'Domains', summary: 'check · pricing · buy · dns' },
    { name: 'Compute', summary: 'plans · deploy · list' },
    { name: 'Wallet', summary: 'create · status · keygen' },
    { name: 'Accounts', summary: 'X · TikTok · Reddit' },
  ]), [])
  const [selected, setSelected] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter(a => `${a.label} ${a.command}`.toLowerCase().includes(q))
  }, [actions, query])

  useEffect(() => {
    if (selected >= filtered.length) setSelected(0)
  }, [filtered.length, selected])

  useInput((input, key) => {
    if (paletteOpen && key.escape) {
      setPaletteOpen(false)
      setQuery('')
      setSelected(0)
      return
    }
    if (!paletteOpen && input === '/') {
      setPaletteOpen(true)
      setQuery('')
      setSelected(0)
      return
    }
    if (key.upArrow) setSelected(c => (c - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1))
    else if (key.downArrow) setSelected(c => (c + 1) % Math.max(filtered.length, 1))
    else if (key.return) {
      const active = filtered[selected] || actions[selected]
      if (active && props.onSelectAction) props.onSelectAction(active.command)
      else exit()
    } else if (input === 'q' && !paletteOpen) exit()
  })

  return (
    <Shell titleLeft={`AgentOS v${props.version}`} footerLeft={`${paletteOpen ? 'esc close · enter open' : '↑↓ move · enter open · / palette · q quit'}`} footerRight={paletteOpen ? 'palette' : 'home'} autoExit={false}>
      {paletteOpen ? <CommandPalette value={query} onChange={setQuery} results={filtered} selected={selected} width={compact ? left : 48} /> : null}
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="home" width={left} borderColor={palette.accent}>
          {compact ? <Mascot /> : <MascotHero />}
          <Box marginTop={1} flexDirection="column">
            <MetaLine label="Chain" value={props.chain || 'solana'} />
            <MetaLine label="API" value={props.apiOk ? 'online' : 'offline'} />
          </Box>
        </Card>
        {compact ? <Box height={1} /> : <Box width={2} />}
        <Card title="services" width={right}>
          {paletteOpen ? (
            <ActionList items={filtered.slice(0, 5)} selected={selected} />
          ) : (
            <ServiceList items={services} />
          )}
        </Card>
      </Box>
    </Shell>
  )
}

export function StatusScreen(props: StatusScreenProps & ScreenControls) {
  const wallets = props.wallets || {}
  return (
    <SimpleScreen
      title={`Status · v${props.version}`}
      leftBody={<><Mascot /><Box marginTop={1} flexDirection="column"><MetaLine label="API" value={props.apiOk ? 'healthy' : 'offline'} /><MetaLine label="Default" value={props.defaultChain || 'solana'} /></Box></>}
      rightBody={<DetailList items={[
        { label: 'API', value: props.api },
        { label: 'Solana', value: wallets.solana?.keyfile || 'not configured' },
        { label: 'Base', value: wallets.base?.keyfile || 'not configured' },
      ]} />}
      footer={props.apiOk ? 'API reachable' : 'API offline'}
      interactive={props.interactive}
      onBack={props.onBack}
    />
  )
}

export function ComputePlansScreen(props: ComputePlansScreenProps & ScreenControls) {
  const featured = props.plans[0]
  return (
    <SimpleScreen
      title={`Compute plans · v${props.version}`}
      leftBody={<><Mascot /><Box marginTop={1}><MetaLine label="Featured" value={featured?.name || 'none'} /></Box></>}
      rightBody={<DetailList items={(props.plans || []).slice(0, 6).map(p => ({ label: p.name, value: `${p.cpu} · ${p.ram} · $${p.price}/mo` }))} />}
      footer="Use compute deploy --type <plan>"
      interactive={props.interactive}
      onBack={props.onBack}
    />
  )
}

export function DomainCheckScreen(props: DomainCheckScreenProps & ScreenControls) {
  return (
    <SimpleScreen
      title={`Domain check · v${props.version}`}
      leftBody={<><Mascot /><Box marginTop={1}><MetaLine label="Domain" value={props.domain} /><MetaLine label="Status" value={props.available ? 'available' : 'taken'} /></Box></>}
      rightBody={<DetailList items={[{ label: 'Next', value: props.available ? `domain buy --name ${props.domain}` : `domain pricing --name ${props.domain.split('.')[0] || props.domain}` }]} />}
      footer={props.available ? 'Ready to buy' : 'Try another name'}
      interactive={props.interactive}
      onBack={props.onBack}
    />
  )
}

export function DomainPricingScreen(props: DomainPricingScreenProps & ScreenControls) {
  return (
    <SimpleScreen
      title={`Domain pricing · v${props.version}`}
      leftBody={<><Mascot /><Box marginTop={1}><MetaLine label="Query" value={props.query} /></Box></>}
      rightBody={<DetailList items={props.items.slice(0, 6).map(i => ({ label: `.${i.tld}`, value: `$${i.price}` }))} />}
      footer="Use domain check --name <name.tld>"
      interactive={props.interactive}
      onBack={props.onBack}
    />
  )
}

export function WalletCreateScreen(props: WalletCreateScreenProps & ScreenControls) {
  return <SimpleScreen title={`Wallet created · v${props.version}`} leftBody={<><Mascot /><Box marginTop={1}><MetaLine label="Chain" value={props.chain} /></Box></>} rightBody={<DetailList items={[{ label: 'Address', value: props.address }, ...(props.setupUrl ? [{ label: 'Setup', value: props.setupUrl }] : [])]} />} footer="Wallet ready" interactive={props.interactive} onBack={props.onBack} />
}

export function WalletStatusScreen(props: WalletStatusScreenProps & ScreenControls) {
  return <SimpleScreen title={`Wallet status · v${props.version}`} leftBody={<><Mascot /><Box marginTop={1}><MetaLine label="Owner" value={props.owner} /></Box></>} rightBody={<DetailList items={[{ label: 'Address', value: props.address }, ...(props.dailyLimit ? [{ label: 'Daily', value: props.dailyLimit }] : []), ...(props.perTxLimit ? [{ label: 'Per tx', value: props.perTxLimit }] : [])]} />} footer="Wallet policy" interactive={props.interactive} onBack={props.onBack} />
}

export function ComputeDeployScreen(props: ComputeDeployScreenProps & ScreenControls) {
  return <SimpleScreen title={`Server deployed · v${props.version}`} leftBody={<><Mascot /><Box marginTop={1}><MetaLine label="IP" value={props.ip} /></Box></>} rightBody={<DetailList items={[{ label: 'Name', value: props.name }, { label: 'Type', value: props.type }, { label: 'SSH', value: `root@${props.ip}` }]} />} footer="Server provisioned" interactive={props.interactive} onBack={props.onBack} />
}

export function ComputeListScreen(props: ComputeListScreenProps & ScreenControls) {
  return <SimpleScreen title={`Servers · v${props.version}`} leftBody={<><Mascot /><Box marginTop={1}><MetaLine label="Count" value={String(props.servers.length)} /></Box></>} rightBody={<DetailList items={props.servers.slice(0, 6).map(s => ({ label: s.ip, value: `${s.type} · ${s.status}` }))} />} footer={`${props.servers.length} server${props.servers.length === 1 ? '' : 's'}`} interactive={props.interactive} onBack={props.onBack} />
}

export function SuccessScreen(props: SuccessScreenProps & ScreenControls) {
  return <SimpleScreen title={`${props.title} · v${props.version}`} leftBody={<><Mascot /><Box marginTop={1}><Text color={palette.text}>{props.subtitle}</Text></Box></>} rightBody={<DetailList items={props.details} />} footer={props.footerLeft} interactive={props.interactive} onBack={props.onBack} />
}

export function PricingScreen(props: PricingScreenProps & ScreenControls) {
  return <SimpleScreen title={`Pricing · v${props.version}`} leftBody={<><Mascot /><Box marginTop={1}><MetaLine label="Groups" value={String(props.services.length)} /></Box></>} rightBody={<DetailList items={props.services.slice(0, 6).map(s => ({ label: s.name, value: s.items.map(i => `${i.label} $${i.value}`).join(' · ') }))} />} footer="All prices in USD/USDC" interactive={props.interactive} onBack={props.onBack} />
}

export function HealthScreen(props: HealthScreenProps & ScreenControls) {
  return <SimpleScreen title={`Health · v${props.version}`} leftBody={<><Mascot /><Box marginTop={1}><MetaLine label="Status" value={props.status} /></Box></>} rightBody={<DetailList items={[{ label: 'Version', value: props.apiVersion }, { label: 'Uptime', value: props.uptime }]} />} footer={props.status === 'healthy' ? 'Service healthy' : 'Service degraded'} interactive={props.interactive} onBack={props.onBack} />
}

export function MenuScreen(props: MenuScreenProps & ScreenControls) {
  return <SimpleScreen title={`${props.title} · v${props.version}`} leftBody={<><Mascot /><Box marginTop={1}><Text color={palette.text}>{props.subtitle}</Text></Box></>} rightBody={<DetailList items={props.commands.slice(0, 6).map(c => ({ label: c.name, value: [c.description, c.hint].filter(Boolean).join(' · ') }))} />} footer={props.footerLeft} interactive={props.interactive} onBack={props.onBack} />
}

export function RecordsScreen(props: RecordsScreenProps & ScreenControls) {
  return <SimpleScreen title={`${props.title} · v${props.version}`} leftBody={<><Mascot /><Box marginTop={1}><MetaLine label="Items" value={String(props.records.length)} /></Box></>} rightBody={<DetailList items={props.records.slice(0, 6).map(r => ({ label: r.primary, value: [r.secondary, r.status].filter(Boolean).join(' · ') || '-' }))} />} footer={props.footerLeft} interactive={props.interactive} onBack={props.onBack} />
}

export function ErrorScreen(props: ErrorScreenProps & ScreenControls) {
  return <SimpleScreen title={`${props.title} · v${props.version}`} leftBody={<><Mascot /><Box marginTop={1}><Text color={palette.error}>Request failed</Text></Box></>} rightBody={<DetailList items={[{ label: 'Message', value: props.message }, ...(props.hint ? [{ label: 'Hint', value: props.hint }] : [])]} />} footer={props.footerLeft} interactive={props.interactive} onBack={props.onBack} />
}

export function SetupScreen(props: SetupScreenProps & ScreenControls) {
  const secondary = props.chains.filter(c => c !== props.addedChain)[0]
  return <SimpleScreen title={`Setup · v${props.version}`} leftBody={<><Mascot /><Box marginTop={1}><MetaLine label="Added" value={props.addedChain} /></Box></>} rightBody={<DetailList items={[{ label: 'API', value: props.api }, { label: 'Chains', value: props.chains.join(', ') }, { label: 'Keyfile', value: props.keyfile }, { label: 'Next', value: props.chains.length === 1 ? `setup --chain ${props.addedChain === 'solana' ? 'base' : 'solana'}` : `${secondary || 'done'}` }]} />} footer="Run status to verify" interactive={props.interactive} onBack={props.onBack} />
}
