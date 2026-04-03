import React, { PropsWithChildren, useEffect } from 'react'
import { Box, Text, useApp, useStdout } from 'ink'

export type DashboardProps = {
  version: string
  chain?: string
  wallets?: Record<string, { keyfile: string }> | undefined
  apiOk?: boolean
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
      <Text color={palette.shadow}>        ░░░░░░</Text>
      <Text color={palette.soft}>      ╭────────╮</Text>
      <Text color={palette.soft}>    ╭─│  ●  ●  │─╮</Text>
      <Text color={palette.soft}>    │ │   ▄▄   │ │</Text>
      <Text color={palette.soft}>    │ │  ╰──╯  │ │</Text>
      <Text color={palette.soft}>    │ ╰────────╯ │</Text>
      <Text color={palette.muted}>    │    ╭──╮    │</Text>
      <Text color={palette.soft}>    ╰────╯  ╰────╯</Text>
    </Box>
  )
}

function Card(props: PropsWithChildren<{ title?: string; width: number }>) {
  return (
    <Box
      flexDirection="column"
      width={props.width}
      borderStyle="round"
      borderColor={palette.dim}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      {props.title ? (
        <Box marginBottom={1}>
          <Text color={palette.accent}>{props.title}</Text>
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

function Shell(props: PropsWithChildren<{ titleLeft: string; titleRight: string; footerLeft: string; footerRight: string }>) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <AutoExit />
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

function twoColWidths(termWidth: number, leftRatio = 0.4, maxLeft = 36) {
  const contentWidth = Math.max(72, termWidth - 6)
  const gap = 2
  const leftWidth = Math.min(maxLeft, Math.floor((contentWidth - gap) * leftRatio))
  const rightWidth = contentWidth - leftWidth - gap
  return { gap, leftWidth, rightWidth }
}

export function Dashboard(props: DashboardProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.4, 36)
  const hasWallets = !!props.wallets && Object.keys(props.wallets).length > 0
  const walletNames = hasWallets ? Object.keys(props.wallets!).join(', ') : 'not configured'

  return (
    <Shell
      titleLeft={`AgentOS v${props.version}`}
      titleRight="Everything your agent needs"
      footerLeft="Run agentos --help for commands"
      footerRight="monochrome shell · phase 1"
    >
      <Box>
        <Card title="agent shell" width={leftWidth}>
          <Text color={palette.text} bold>Calm infrastructure for autonomous agents.</Text>
          <Box marginTop={1}><Text color={palette.muted}>Clean terminal surfaces. Quiet confidence. No clown makeup.</Text></Box>
          <Mascot />
          <Box marginTop={1} flexDirection="column">
            <Text color={palette.muted}>Default chain</Text>
            <Text color={palette.text}>{props.chain || 'solana'}</Text>
          </Box>
        </Card>
        <Box width={gap} />
        <Card title="quick actions" width={rightWidth}>
          <Box flexDirection="column" marginBottom={1}>
            <Text color={palette.text}>› agentos setup --keyfile ~/.config/solana/id.json --chain solana</Text>
            <Text color={palette.text}>› agentos phone search --country US</Text>
            <Text color={palette.text}>› agentos compute plans</Text>
            <Text color={palette.text}>› agentos domain check --name myagent.dev</Text>
          </Box>
          <Box marginTop={1} marginBottom={1}><Text color={palette.muted}>system status</Text></Box>
          <Box flexDirection="column">
            <StatDot ok={hasWallets} label="Wallets" value={walletNames} />
            <StatDot ok={!!props.apiOk} label="API" value={props.apiOk ? 'connected' : 'unreachable'} />
            <StatDot ok={true} label="Mode" value="CLI" />
          </Box>
        </Card>
      </Box>
    </Shell>
  )
}

export function StatusScreen(props: StatusScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.42, 38)
  const wallets = props.wallets || {}
  const hasSolana = !!wallets.solana
  const hasBase = !!wallets.base

  return (
    <Shell titleLeft={`AgentOS status · v${props.version}`} titleRight="System overview" footerLeft={props.apiOk ? 'API reachable' : 'API offline'} footerRight="phase 1.5">
      <Box>
        <Card title="overview" width={leftWidth}>
          <Text color={palette.text} bold>Runtime posture</Text>
          <Box marginTop={1} flexDirection="column">
            <StatDot ok={props.apiOk} label="API" value={props.apiOk ? 'healthy' : 'offline'} />
            <StatDot ok={hasSolana} label="Solana" value={hasSolana ? 'configured' : 'missing'} />
            <StatDot ok={hasBase} label="Base" value={hasBase ? 'configured' : 'missing'} />
          </Box>
          <Box marginTop={1}><Mascot /></Box>
        </Card>
        <Box width={gap} />
        <Card title="configuration" width={rightWidth}>
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
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.3, 28)
  const featured = props.plans[0]

  return (
    <Shell titleLeft={`AgentOS compute plans · v${props.version}`} titleRight="VPS catalog" footerLeft="Use agentos compute deploy --name <name> --type <plan>" footerRight="phase 2">
      <Box>
        <Card title="featured" width={leftWidth}>
          <Text color={palette.text} bold>{featured?.name || 'No plans'}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={palette.muted}>{featured ? `${featured.cpu} · ${featured.ram}` : 'No compute plans returned'}</Text>
            <Text color={palette.text}>{featured ? `$${featured.price}/mo` : ''}</Text>
          </Box>
          <Mascot />
        </Card>
        <Box width={gap} />
        <Card title="plans" width={rightWidth}>
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
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.34, 30)

  return (
    <Shell titleLeft={`AgentOS domain check · v${props.version}`} titleRight="Naming" footerLeft={props.available ? 'Ready to buy' : 'Try another domain'} footerRight="phase 2">
      <Box>
        <Card title="result" width={leftWidth}>
          <Text color={props.available ? palette.success : palette.error}>{props.available ? '● available' : '● taken'}</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.domain}</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
        <Card title="next" width={rightWidth}>
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
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.3, 28)
  const cheapest = [...props.items].sort((a, b) => Number(a.price) - Number(b.price))[0]

  return (
    <Shell titleLeft={`AgentOS domain pricing · v${props.version}`} titleRight="TLD pricing" footerLeft="Use agentos domain check --name <domain.tld>" footerRight="phase 2">
      <Box>
        <Card title="cheapest" width={leftWidth}>
          <Text color={palette.text} bold>{cheapest ? `.${cheapest.tld}` : 'No results'}</Text>
          <Box marginTop={1}><Text color={palette.text}>{cheapest ? `$${cheapest.price}` : ''}</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
        <Card title={`pricing for ${props.query}`} width={rightWidth}>
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
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.34, 30)
  return (
    <Shell titleLeft={`AgentOS wallet create · v${props.version}`} titleRight="Smart wallet" footerLeft="Wallet created" footerRight="phase 2.5">
      <Box>
        <Card title="created" width={leftWidth}>
          <Text color={palette.success}>● ready</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{truncateMiddle(props.address, 24)}</Text></Box>
          <Box marginTop={1}><Text color={palette.muted}>{props.chain}</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
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
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.34, 30)
  return (
    <Shell titleLeft={`AgentOS wallet status · v${props.version}`} titleRight="Policy" footerLeft="Wallet posture" footerRight="phase 2.5">
      <Box>
        <Card title="wallet" width={leftWidth}>
          <Text color={palette.text} bold>{truncateMiddle(props.address, 24)}</Text>
          <Box marginTop={1}><Text color={palette.muted}>owner</Text></Box>
          <Text color={palette.text}>{truncateMiddle(props.owner, 24)}</Text>
          <Mascot />
        </Card>
        <Box width={gap} />
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
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.34, 30)
  return (
    <Shell titleLeft={`AgentOS compute deploy · v${props.version}`} titleRight="Server provisioned" footerLeft="Use SSH to connect" footerRight="phase 2.5">
      <Box>
        <Card title="live" width={leftWidth}>
          <Text color={palette.success}>● online</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.ip}</Text></Box>
          <Box marginTop={1}><Text color={palette.muted}>{props.type}</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
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
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.28, 26)
  return (
    <Shell titleLeft={`AgentOS compute list · v${props.version}`} titleRight="Fleet" footerLeft={`${props.servers.length} server${props.servers.length === 1 ? '' : 's'}`} footerRight="phase 2.5">
      <Box>
        <Card title="fleet" width={leftWidth}>
          <Text color={palette.text} bold>{String(props.servers.length)}</Text>
          <Box marginTop={1}><Text color={palette.muted}>tracked servers</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
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
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.34, 30)
  return (
    <Shell titleLeft={`AgentOS · v${props.version}`} titleRight={props.title} footerLeft={props.footerLeft} footerRight="phase 3">
      <Box>
        <Card title="done" width={leftWidth}>
          <Text color={palette.success}>● success</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.subtitle}</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
        <Card title="details" width={rightWidth}>
          {props.details.map((detail, i) => <KeyValue key={`${detail.label}-${i}`} label={detail.label} value={detail.value} />)}
        </Card>
      </Box>
    </Shell>
  )
}

export function PricingScreen(props: PricingScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.28, 26)
  return (
    <Shell titleLeft={`AgentOS pricing · v${props.version}`} titleRight="Service rates" footerLeft="All prices in USD/USDC" footerRight="phase 3">
      <Box>
        <Card title="catalog" width={leftWidth}>
          <Text color={palette.text} bold>{String(props.services.length)}</Text>
          <Box marginTop={1}><Text color={palette.muted}>service groups</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
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

export function HealthScreen(props: HealthScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.34, 30)
  const ok = props.status === 'healthy'
  return (
    <Shell titleLeft={`AgentOS health · v${props.version}`} titleRight="API status" footerLeft={ok ? 'Service healthy' : 'Service degraded'} footerRight="phase 3">
      <Box>
        <Card title="health" width={leftWidth}>
          <Text color={ok ? palette.success : palette.error}>{ok ? '● healthy' : `● ${props.status}`}</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.apiVersion}</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
        <Card title="details" width={rightWidth}>
          <KeyValue label="Status" value={props.status} />
          <KeyValue label="Version" value={props.apiVersion} />
          <KeyValue label="Uptime" value={props.uptime} />
        </Card>
      </Box>
    </Shell>
  )
}

export function MenuScreen(props: MenuScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.32, 28)
  return (
    <Shell titleLeft={`AgentOS ${props.title} · v${props.version}`} titleRight={props.subtitle} footerLeft={props.footerLeft} footerRight="phase 4">
      <Box>
        <Card title="menu" width={leftWidth}>
          <Text color={palette.text} bold>{props.title}</Text>
          <Box marginTop={1}><Text color={palette.muted}>{props.subtitle}</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
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

export function RecordsScreen(props: RecordsScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.28, 26)
  return (
    <Shell titleLeft={`AgentOS ${props.title} · v${props.version}`} titleRight={props.subtitle} footerLeft={props.footerLeft} footerRight="phase 4">
      <Box>
        <Card title="summary" width={leftWidth}>
          <Text color={palette.text} bold>{String(props.records.length)}</Text>
          <Box marginTop={1}><Text color={palette.muted}>items</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
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

export function ErrorScreen(props: ErrorScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.3, 28)
  return (
    <Shell titleLeft={`AgentOS · v${props.version}`} titleRight={props.title} footerLeft={props.footerLeft} footerRight="phase 4">
      <Box>
        <Card title="problem" width={leftWidth}>
          <Text color={palette.error}>● blocked</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.title}</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
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
  const { gap, leftWidth, rightWidth } = twoColWidths(termWidth, 0.4, 36)
  const secondary = props.chains.filter(c => c !== props.addedChain)[0]

  return (
    <Shell titleLeft={`AgentOS setup · v${props.version}`} titleRight="Wallet configured" footerLeft="Run agentos status to verify" footerRight="phase 1.5">
      <Box>
        <Card title="setup complete" width={leftWidth}>
          <Text color={palette.success}>● configured</Text>
          <Box marginTop={1}><Text color={palette.text} bold>{props.addedChain} wallet added.</Text></Box>
          <Mascot />
        </Card>
        <Box width={gap} />
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
