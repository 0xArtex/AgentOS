import React, { PropsWithChildren, useEffect, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'

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
  accent: 'whiteBright',
  success: 'greenBright',
  error: 'redBright',
  soft: 'whiteBright',
  shadow: 'gray',
} as const

function AutoExit() {
  const { exit } = useApp()
  useEffect(() => {
    const t = setTimeout(() => exit(), 10)
    return () => clearTimeout(t)
  }, [exit])
  return null
}

function Mascot() {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={palette.accent}>      AgentOS</Text>
      <Text color={palette.shadow}>       ░░░░░░</Text>
      <Text color={palette.soft}>      ╭──────╮</Text>
      <Text color={palette.soft}>      │ ●  ● │</Text>
      <Text color={palette.soft}>      │  ──  │</Text>
      <Text color={palette.soft}>      ╰──────╯</Text>
    </Box>
  )
}

function Card(props: PropsWithChildren<{ title?: string; width: number; borderColor?: string; titleColor?: string }>) {
  return (
    <Box
      flexDirection="column"
      width={props.width}
      borderStyle="round"
      borderColor={props.borderColor || palette.dim}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      {props.title ? (
        <Box marginBottom={1}>
          <Text color={props.titleColor || palette.accent}>{props.title}</Text>
        </Box>
      ) : null}
      {props.children}
    </Box>
  )
}

function StatDot(props: { ok: boolean; label: string; value: string }) {
  return (
    <Box marginBottom={1}>
      <Text color={props.ok ? palette.success : palette.error}>●</Text>
      <Text> </Text>
      <Text color={palette.muted}>{props.label}: </Text>
      <Text color={palette.text}>{props.value}</Text>
    </Box>
  )
}

function truncateMiddle(value: string, max = 34) {
  if (value.length <= max) return value
  const keep = Math.max(8, Math.floor((max - 1) / 2))
  return `${value.slice(0, keep)}…${value.slice(-keep)}`
}

function KeyValue(props: { label: string; value: string }) {
  return (
    <Box marginBottom={1}>
      <Box width={16}>
        <Text color={palette.muted}>{props.label}</Text>
      </Box>
      <Text color={palette.text}>{truncateMiddle(props.value)}</Text>
    </Box>
  )
}

function Rule() {
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 100
  const width = Math.max(32, Math.min(columns - 16, 72))
  return <Text color={palette.dim}>{'·'.repeat(width)}</Text>
}

function Shell(props: PropsWithChildren<{ titleLeft: string; titleRight: string; footerLeft: string; footerRight: string; autoExit?: boolean; onBack?: () => void }>) {
  useInput((input, key) => {
    if (props.onBack && (input === 'b' || key.escape)) props.onBack()
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      {props.autoExit === false ? null : <AutoExit />}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box>
          <Text color={palette.accent}>◼ </Text>
          <Text color={palette.text}>{props.titleLeft}</Text>
        </Box>
        <Text color={palette.muted}>{props.titleRight}</Text>
      </Box>
      <Rule />
      <Box marginTop={1} flexDirection="column">
        {props.children}
      </Box>
      <Box marginTop={1}>
        <Rule />
      </Box>
      <Box justifyContent="space-between" marginTop={1}>
        <Text color={palette.muted}>{props.footerLeft}</Text>
        <Text color={palette.dim}>{props.footerRight}</Text>
      </Box>
    </Box>
  )
}

function ActionItem(props: { label: string; command: string; selected: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={props.selected ? palette.soft : palette.text}>{props.selected ? '▸ ' : '› '}{props.label}</Text>
      <Text color={props.selected ? palette.soft : palette.muted}>{props.command}</Text>
    </Box>
  )
}

function CommandPalette(props: {
  value: string
  onChange: (value: string) => void
  results: Array<{ label: string; command: string }>
  selected: number
  width?: number
}) {
  return (
    <Card title="command palette" width={props.width || 72} borderColor={palette.accent} titleColor={palette.accent}>
      <Box marginBottom={1}>
        <Text color={palette.muted}>type to filter commands</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={palette.soft}>› </Text>
        <TextInput value={props.value} onChange={props.onChange} />
      </Box>
      <Box flexDirection="column">
        {props.results.slice(0, 6).map((item, index) => (
          <Box key={item.command} flexDirection="column" marginBottom={1}>
            <Text color={props.selected === index ? palette.soft : palette.text}>{props.selected === index ? '▸ ' : '› '}{item.label}</Text>
            <Text color={props.selected === index ? palette.soft : palette.muted}>{item.command}</Text>
          </Box>
        ))}
      </Box>
    </Card>
  )
}

function twoColWidths(termWidth: number, leftRatio = 0.4, maxLeft = 36) {
  const compact = termWidth < 96
  const contentWidth = Math.max(compact ? 56 : 72, termWidth - 6)
  const gap = compact ? 0 : 2
  const leftWidth = compact ? contentWidth : Math.min(maxLeft, Math.floor((contentWidth - gap) * leftRatio))
  const rightWidth = compact ? contentWidth : contentWidth - leftWidth - gap
  return { gap, leftWidth, rightWidth, compact }
}

export function Dashboard(props: DashboardProps) {
  const { stdout } = useStdout()
  const { exit } = useApp()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.4, 36)
  const hasWallets = !!props.wallets && Object.keys(props.wallets).length > 0
  const walletNames = hasWallets ? Object.keys(props.wallets!).join(', ') : 'not configured'
  const actions = useMemo(() => ([
    { label: 'Setup wallet', command: 'agentos setup --keyfile ~/.config/solana/id.json --chain solana' },
    { label: 'Search phone numbers', command: 'agentos phone search --country US' },
    { label: 'Browse compute plans', command: 'agentos compute plans' },
    { label: 'Check a domain', command: 'agentos domain check --name myagent.dev' },
    { label: 'Show status', command: 'agentos status' },
    { label: 'Open pricing', command: 'agentos pricing' },
    { label: 'Check API health', command: 'agentos health' },
  ]), [])
  const [selected, setSelected] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [query, setQuery] = useState('')
  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter((action) => `${action.label} ${action.command}`.toLowerCase().includes(q))
  }, [actions, query])

  useEffect(() => {
    if (selected >= filteredActions.length) setSelected(0)
  }, [filteredActions.length, selected])

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
    if (key.upArrow) setSelected((current) => (current - 1 + Math.max(filteredActions.length, 1)) % Math.max(filteredActions.length, 1))
    else if (key.downArrow) setSelected((current) => (current + 1) % Math.max(filteredActions.length, 1))
    else if (key.return) {
      const active = filteredActions[selected] || actions[selected]
      if (active && props.onSelectAction) props.onSelectAction(active.command)
      else exit()
    }
    else if (input === 'q' && !paletteOpen) exit()
  })

  return (
    <Shell
      titleLeft={`AgentOS v${props.version}`}
      titleRight="Everything your agent needs"
      footerLeft={`${paletteOpen ? 'esc close palette · enter open command' : '↑↓ navigate · enter open · / palette · q quit'} · focus ${Math.min(selected + 1, Math.max(filteredActions.length, 1))}/${Math.max(filteredActions.length, 1)}`}
      footerRight="premium shell · interactive home"
      autoExit={false}
    >
      {paletteOpen ? (
        <CommandPalette value={query} onChange={setQuery} results={filteredActions} selected={selected} width={compact ? leftWidth : 72} />
      ) : null}
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="identity" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          {!compact ? <Mascot /> : null}
          <Box marginTop={1} flexDirection="column">
            <Text color={palette.text} bold>Infrastructure for autonomous agents.</Text>
            <Text color={palette.muted}>Phones, inboxes, domains, compute, wallets.</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={palette.muted}>Default chain</Text>
            <Text color={palette.text}>{props.chain || 'solana'}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={palette.muted}>Current focus</Text>
            <Text color={palette.text}>{(filteredActions[selected] || actions[selected])?.label}</Text>
          </Box>
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Box flexDirection="column" width={rightWidth}>
          <Card title="quick actions" width={rightWidth} borderColor={palette.accent} titleColor={palette.accent}>
            <Box flexDirection="column">
              {(paletteOpen ? filteredActions : actions).slice(0, compact ? 4 : 5).map((action, index) => (
                <ActionItem
                  key={action.command}
                  label={action.label}
                  command={action.command}
                  selected={selected === index}
                />
              ))}
            </Box>
          </Card>
          <Card title="status" width={rightWidth}>
            <Box flexDirection="column">
              <StatDot ok={hasWallets} label="Wallets" value={walletNames} />
              <StatDot ok={!!props.apiOk} label="API" value={props.apiOk ? 'connected' : 'unreachable'} />
              <StatDot ok={true} label="Mode" value="interactive home" />
            </Box>
          </Card>
          {!compact ? (
            <Card title="tips" width={rightWidth}>
              <Text color={palette.text}>/ opens command palette</Text>
              <Text color={palette.muted}>Use arrows to move. Enter opens the selected action.</Text>
            </Card>
          ) : null}
        </Box>
      </Box>
    </Shell>
  )
}

export function StatusScreen(props: StatusScreenProps & ScreenControls) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.42, 38)
  const wallets = props.wallets || {}
  const hasSolana = !!wallets.solana
  const hasBase = !!wallets.base

  return (
    <Shell titleLeft={`AgentOS status · v${props.version}`} titleRight="System overview" footerLeft={props.interactive ? 'b / esc back' : (props.apiOk ? 'API reachable' : 'API offline')} footerRight="phase 1.5" autoExit={props.interactive ? false : undefined} onBack={props.onBack}>
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={palette.text} bold>Runtime posture</Text>
          <Box marginTop={1} flexDirection="column">
            <StatDot ok={props.apiOk} label="API" value={props.apiOk ? 'healthy' : 'offline'} />
            <StatDot ok={hasSolana} label="Solana" value={hasSolana ? 'configured' : 'missing'} />
            <StatDot ok={hasBase} label="Base" value={hasBase ? 'configured' : 'missing'} />
          </Box>
          {!compact ? <Box marginTop={1}>{!compact ? <Mascot /> : null}</Box> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="details" width={rightWidth}>
          <KeyValue label="API" value={props.api} />
          <KeyValue label="Solana" value={hasSolana ? wallets.solana!.keyfile : 'not configured'} />
          <KeyValue label="Base" value={hasBase ? wallets.base!.keyfile : 'not configured'} />
          <KeyValue label="Default" value={props.defaultChain || 'solana'} />
          <Box marginTop={1}><Text color={palette.muted}>next</Text></Box>
          <Text color={palette.text}>agentos setup --keyfile ~/.config/solana/id.json --chain solana</Text>
        </Card>
      </Box>
    </Shell>
  )
}

export function ComputePlansScreen(props: ComputePlansScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.3, 28)
  const featured = props.plans[0]

  return (
    <Shell titleLeft={`AgentOS compute plans · v${props.version}`} titleRight="VPS catalog" footerLeft="Use agentos compute deploy --name <name> --type <plan>" footerRight="phase 2">
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={palette.text} bold>{featured?.name || 'No plans'}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={palette.muted}>{featured ? `${featured.cpu} · ${featured.ram}` : 'No compute plans returned'}</Text>
            <Text color={palette.text}>{featured ? `$${featured.price}/mo` : ''}</Text>
          </Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="available plans" width={rightWidth}>
          {props.plans.map((plan) => (
            <Box key={plan.name} justifyContent="space-between">
              <Text color={palette.text}>{plan.name}</Text>
              <Text color={palette.muted}>{`${plan.cpu} · ${plan.ram} · $${plan.price}/mo`}</Text>
            </Box>
          ))}
        </Card>
      </Box>
    </Shell>
  )
}

export function DomainCheckScreen(props: DomainCheckScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.34, 30)

  return (
    <Shell titleLeft={`AgentOS domain check · v${props.version}`} titleRight="Naming" footerLeft={props.available ? 'Ready to buy' : 'Try another domain'} footerRight="phase 2">
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={props.available ? palette.success : palette.error}>{props.available ? '● available' : '● taken'}</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.domain}</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="recommended next step" width={rightWidth}>
          <Text color={palette.text}>{props.available ? `agentos domain buy --name ${props.domain}` : `agentos domain pricing --name ${props.domain.split('.')[0] || props.domain}`}</Text>
          <Box marginTop={1}><Text color={palette.muted}>status</Text></Box>
          <StatDot ok={props.available} label="Availability" value={props.available ? 'open' : 'unavailable'} />
          <Text color={palette.muted}>{props.available ? 'Nice. This one is clean.' : 'Taken. Don’t marry the first name.'}</Text>
        </Card>
      </Box>
    </Shell>
  )
}

export function DomainPricingScreen(props: DomainPricingScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.3, 28)
  const cheapest = [...props.items].sort((a, b) => Number(a.price) - Number(b.price))[0]

  return (
    <Shell titleLeft={`AgentOS domain pricing · v${props.version}`} titleRight="TLD pricing" footerLeft="Use agentos domain check --name <domain.tld>" footerRight="phase 2">
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="cheapest" width={leftWidth}>
          <Text color={palette.text} bold>{cheapest ? `.${cheapest.tld}` : 'No results'}</Text>
          <Box marginTop={1}><Text color={palette.text}>{cheapest ? `$${cheapest.price}` : ''}</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title={`matching prices for ${props.query}`} width={rightWidth}>
          {props.items.map((item) => (
            <Box key={item.tld} justifyContent="space-between">
              <Text color={palette.text}>.{item.tld}</Text>
              <Text color={palette.muted}>${item.price}</Text>
            </Box>
          ))}
        </Card>
      </Box>
    </Shell>
  )
}

export function WalletCreateScreen(props: WalletCreateScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.34, 30)
  return (
    <Shell titleLeft={`AgentOS wallet create · v${props.version}`} titleRight="Smart wallet" footerLeft="Wallet created" footerRight="phase 2.5">
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={palette.success}>● ready</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{truncateMiddle(props.address, 24)}</Text></Box>
          <Box marginTop={1}><Text color={palette.muted}>{props.chain}</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="details" width={rightWidth}>
          <KeyValue label="Address" value={props.address} />
          <KeyValue label="Chain" value={props.chain} />
          {props.setupUrl ? <KeyValue label="Setup" value={props.setupUrl} /> : null}
          <Box marginTop={1}><Text color={palette.muted}>next</Text></Box>
          <Text color={palette.text}>agentos wallet status {props.address}</Text>
        </Card>
      </Box>
    </Shell>
  )
}

export function WalletStatusScreen(props: WalletStatusScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.34, 30)
  return (
    <Shell titleLeft={`AgentOS wallet status · v${props.version}`} titleRight="Policy" footerLeft="Wallet posture" footerRight="phase 2.5">
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={palette.text} bold>{truncateMiddle(props.address, 24)}</Text>
          <Box marginTop={1}><Text color={palette.muted}>owner</Text></Box>
          <Text color={palette.text}>{truncateMiddle(props.owner, 24)}</Text>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="limits" width={rightWidth}>
          <KeyValue label="Address" value={props.address} />
          <KeyValue label="Owner" value={props.owner} />
          {props.dailyLimit ? <KeyValue label="Daily limit" value={props.dailyLimit} /> : null}
          {props.perTxLimit ? <KeyValue label="Per-tx" value={props.perTxLimit} /> : null}
        </Card>
      </Box>
    </Shell>
  )
}

export function ComputeDeployScreen(props: ComputeDeployScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.34, 30)
  return (
    <Shell titleLeft={`AgentOS compute deploy · v${props.version}`} titleRight="Server provisioned" footerLeft="Use SSH to connect" footerRight="phase 2.5">
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={palette.success}>● online</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.ip}</Text></Box>
          <Box marginTop={1}><Text color={palette.muted}>{props.type}</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="details" width={rightWidth}>
          <KeyValue label="Name" value={props.name} />
          <KeyValue label="ID" value={props.id} />
          <KeyValue label="Type" value={props.type} />
          <KeyValue label="SSH" value={`root@${props.ip}`} />
        </Card>
      </Box>
    </Shell>
  )
}

export function ComputeListScreen(props: ComputeListScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.28, 26)
  return (
    <Shell titleLeft={`AgentOS compute list · v${props.version}`} titleRight="Fleet" footerLeft={`${props.servers.length} server${props.servers.length === 1 ? '' : 's'}`} footerRight="phase 2.5">
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={palette.text} bold>{String(props.servers.length)}</Text>
          <Box marginTop={1}><Text color={palette.muted}>tracked servers</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="servers" width={rightWidth}>
          {props.servers.map((server, i) => (
            <Box key={`${server.ip}-${i}`} justifyContent="space-between">
              <Text color={palette.text}>{server.ip}</Text>
              <Text color={palette.muted}>{`${server.type} · ${server.status}`}</Text>
            </Box>
          ))}
        </Card>
      </Box>
    </Shell>
  )
}

export function SuccessScreen(props: SuccessScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.34, 30)
  return (
    <Shell titleLeft={`AgentOS · v${props.version}`} titleRight={props.title} footerLeft={props.footerLeft} footerRight="phase 3">
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={palette.success}>● success</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.subtitle}</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="details" width={rightWidth}>
          {props.details.map((detail, i) => <KeyValue key={`${detail.label}-${i}`} label={detail.label} value={detail.value} />)}
        </Card>
      </Box>
    </Shell>
  )
}

export function PricingScreen(props: PricingScreenProps & ScreenControls) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.28, 26)
  return (
    <Shell titleLeft={`AgentOS pricing · v${props.version}`} titleRight="Service rates" footerLeft={props.interactive ? 'b / esc back' : 'All prices in USD/USDC'} footerRight="phase 3" autoExit={props.interactive ? false : undefined} onBack={props.onBack}>
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={palette.text} bold>{String(props.services.length)}</Text>
          <Box marginTop={1}><Text color={palette.muted}>service groups</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="services" width={rightWidth}>
          {props.services.map((service, i) => (
            <Box key={`${service.name}-${i}`} flexDirection="column" marginBottom={1}>
              <Text color={palette.text}>› {service.name}</Text>
              {service.items.map((item, j) => (
                <Box key={`${service.name}-${item.label}-${j}`} justifyContent="space-between" marginBottom={0}>
                  <Text color={palette.muted}>{item.label}</Text>
                  <Text color={palette.muted}>${item.value}</Text>
                </Box>
              ))}
            </Box>
          ))}
        </Card>
      </Box>
    </Shell>
  )
}

export function HealthScreen(props: HealthScreenProps & ScreenControls) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.34, 30)
  const ok = props.status === 'healthy'
  return (
    <Shell titleLeft={`AgentOS health · v${props.version}`} titleRight="API status" footerLeft={props.interactive ? 'b / esc back' : (ok ? 'Service healthy' : 'Service degraded')} footerRight="phase 3" autoExit={props.interactive ? false : undefined} onBack={props.onBack}>
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={ok ? palette.success : palette.error}>{ok ? '● healthy' : `● ${props.status}`}</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.apiVersion}</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="details" width={rightWidth}>
          <KeyValue label="Status" value={props.status} />
          <KeyValue label="Version" value={props.apiVersion} />
          <KeyValue label="Uptime" value={props.uptime} />
        </Card>
      </Box>
    </Shell>
  )
}

export function MenuScreen(props: MenuScreenProps & ScreenControls) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.32, 28)
  return (
    <Shell titleLeft={`AgentOS ${props.title} · v${props.version}`} titleRight={props.subtitle} footerLeft={props.interactive ? 'b / esc back' : props.footerLeft} footerRight="phase 4" autoExit={props.interactive ? false : undefined} onBack={props.onBack}>
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={palette.text} bold>{props.title}</Text>
          <Box marginTop={1}><Text color={palette.muted}>{props.subtitle}</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="commands" width={rightWidth}>
          {props.commands.map((cmd, i) => (
            <Box key={`${cmd.name}-${i}`} flexDirection="column" marginBottom={1}>
              <Text color={palette.text}>› {cmd.name}</Text>
              <Text color={palette.muted}>{cmd.description}{cmd.hint ? ` · ${cmd.hint}` : ''}</Text>
            </Box>
          ))}
        </Card>
      </Box>
    </Shell>
  )
}

export function RecordsScreen(props: RecordsScreenProps & ScreenControls) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.28, 26)
  return (
    <Shell titleLeft={`AgentOS ${props.title} · v${props.version}`} titleRight={props.subtitle} footerLeft={props.interactive ? 'b / esc back' : props.footerLeft} footerRight="phase 4" autoExit={props.interactive ? false : undefined} onBack={props.onBack}>
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={palette.text} bold>{String(props.records.length)}</Text>
          <Box marginTop={1}><Text color={palette.muted}>items</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="records" width={rightWidth}>
          {props.records.map((record, i) => (
            <Box key={`${record.primary}-${i}`} flexDirection="column" marginBottom={1}>
              <Text color={palette.text}>› {record.primary}</Text>
              {record.secondary ? <Text color={palette.muted}>{record.secondary}</Text> : null}
              {record.status ? <Text color={palette.dim}>{record.status}</Text> : null}
            </Box>
          ))}
        </Card>
      </Box>
    </Shell>
  )
}

export function ErrorScreen(props: ErrorScreenProps & ScreenControls) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.3, 28)
  return (
    <Shell titleLeft={`AgentOS · v${props.version}`} titleRight={props.title} footerLeft={props.interactive ? 'b / esc back' : props.footerLeft} footerRight="phase 4" autoExit={props.interactive ? false : undefined} onBack={props.onBack}>
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.error} titleColor={palette.error}>
          <Text color={palette.error}>● blocked</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.title}</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="details" width={rightWidth}>
          <Text color={palette.text}>{props.message}</Text>
          {props.hint ? <Box marginTop={1}><Text color={palette.muted}>{props.hint}</Text></Box> : null}
        </Card>
      </Box>
    </Shell>
  )
}

export function SetupScreen(props: SetupScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth, compact } = twoColWidths(termWidth, 0.4, 36)
  const secondary = props.chains.filter(c => c !== props.addedChain)[0]

  return (
    <Shell titleLeft={`AgentOS setup · v${props.version}`} titleRight="Wallet configured" footerLeft="Run agentos status to verify" footerRight="phase 1.5">
      <Box flexDirection={compact ? 'column' : 'row'}>
        <Card title="summary" width={leftWidth} borderColor={palette.accent} titleColor={palette.accent}>
          <Text color={palette.success}>● configured</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.addedChain} wallet added.</Text></Box>
          {!compact ? <Mascot /> : null}
        </Card>
        {compact ? <Box height={1} /> : <Box width={gap} />}
        <Card title="details" width={rightWidth}>
          <KeyValue label="API" value={props.api} />
          <KeyValue label="Chain" value={props.chains.join(', ')} />
          <KeyValue label="Keyfile" value={props.keyfile} />
          <Box marginTop={1}><Text color={palette.muted}>next</Text></Box>
          <Text color={palette.text}>agentos status</Text>
          {props.chains.length === 1 ? (
            <Text color={palette.text}>{`agentos setup --keyfile <path> --chain ${props.addedChain === 'solana' ? 'base' : 'solana'}`}</Text>
          ) : secondary ? (
            <Text color={palette.muted}>{secondary} wallet already present</Text>
          ) : null}
        </Card>
      </Box>
    </Shell>
  )
}
