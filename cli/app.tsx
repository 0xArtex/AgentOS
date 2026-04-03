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

const palette = {
  text: 'white',
  muted: 'gray',
  dim: 'blackBright',
  accent: 'white',
  success: 'greenBright',
  error: 'redBright',
  soft: 'whiteBright',
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
      <Text color={palette.soft}>       ╭────────╮</Text>
      <Text color={palette.soft}>       │  ◕  ◕ │</Text>
      <Text color={palette.soft}>       │   ▔▔  │</Text>
      <Text color={palette.soft}>       ╰─╮  ╭─╯</Text>
      <Text color={palette.soft}>         │  │</Text>
      <Text color={palette.soft}>       ╭─╯  ╰─╮</Text>
      <Text color={palette.soft}>       ╰──────╯</Text>
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
    >
      {props.title ? (
        <Box marginBottom={1}>
          <Text color={palette.muted}>{props.title}</Text>
        </Box>
      ) : null}
      {props.children}
    </Box>
  )
}

function StatDot(props: { ok: boolean; label: string; value: string }) {
  return (
    <Box>
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
    <Box>
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
  return <Text color={palette.dim}>{'─'.repeat(width)}</Text>
}

function Shell(props: PropsWithChildren<{ titleLeft: string; titleRight: string; footerLeft: string; footerRight: string }>) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <AutoExit />
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={palette.text}>{props.titleLeft}</Text>
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

export function Dashboard(props: DashboardProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const contentWidth = Math.max(72, termWidth - 6)
  const gap = 2
  const leftWidth = Math.min(36, Math.floor((contentWidth - gap) * 0.4))
  const rightWidth = contentWidth - leftWidth - gap
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
          <Text color={palette.text} bold>
            Calm infrastructure for autonomous agents.
          </Text>
          <Mascot />
          <Box marginTop={1} flexDirection="column">
            <Text color={palette.muted}>Default chain</Text>
            <Text color={palette.text}>{props.chain || 'solana'}</Text>
          </Box>
        </Card>

        <Box width={gap} />

        <Card title="quick actions" width={rightWidth}>
          <Box flexDirection="column" marginBottom={1}>
            <Text color={palette.text}>agentos setup --keyfile ~/.config/solana/id.json --chain solana</Text>
            <Text color={palette.text}>agentos phone search --country US</Text>
            <Text color={palette.text}>agentos compute plans</Text>
            <Text color={palette.text}>agentos domain check --name myagent.dev</Text>
          </Box>

          <Box marginTop={1} marginBottom={1}>
            <Text color={palette.muted}>status</Text>
          </Box>
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
  const contentWidth = Math.max(72, termWidth - 6)
  const gap = 2
  const leftWidth = Math.min(38, Math.floor((contentWidth - gap) * 0.42))
  const rightWidth = contentWidth - leftWidth - gap
  const wallets = props.wallets || {}
  const hasSolana = !!wallets.solana
  const hasBase = !!wallets.base

  return (
    <Shell
      titleLeft={`AgentOS status · v${props.version}`}
      titleRight="System overview"
      footerLeft={props.apiOk ? 'API reachable' : 'API offline'}
      footerRight="phase 1.5"
    >
      <Box>
        <Card title="overview" width={leftWidth}>
          <Text color={palette.text} bold>
            Runtime posture
          </Text>
          <Box marginTop={1} flexDirection="column">
            <StatDot ok={props.apiOk} label="API" value={props.apiOk ? 'healthy' : 'offline'} />
            <StatDot ok={hasSolana} label="Solana" value={hasSolana ? 'configured' : 'missing'} />
            <StatDot ok={hasBase} label="Base" value={hasBase ? 'configured' : 'missing'} />
          </Box>
          <Box marginTop={1}>
            <Mascot />
          </Box>
        </Card>

        <Box width={gap} />

        <Card title="configuration" width={rightWidth}>
          <KeyValue label="API" value={props.api} />
          <KeyValue label="Solana" value={hasSolana ? wallets.solana!.keyfile : 'not configured'} />
          <KeyValue label="Base" value={hasBase ? wallets.base!.keyfile : 'not configured'} />
          <KeyValue label="Default" value={props.defaultChain || 'solana'} />
          <Box marginTop={1}>
            <Text color={palette.muted}>next</Text>
          </Box>
          <Text color={palette.text}>agentos setup --keyfile ~/.config/solana/id.json --chain solana</Text>
        </Card>
      </Box>
    </Shell>
  )
}

export function ComputePlansScreen(props: ComputePlansScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const contentWidth = Math.max(72, termWidth - 6)
  const gap = 2
  const leftWidth = Math.min(28, Math.floor((contentWidth - gap) * 0.3))
  const rightWidth = contentWidth - leftWidth - gap
  const featured = props.plans[0]

  return (
    <Shell
      titleLeft={`AgentOS compute plans · v${props.version}`}
      titleRight="VPS catalog"
      footerLeft="Use agentos compute deploy --name <name> --type <plan>"
      footerRight="phase 2"
    >
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
  const contentWidth = Math.max(72, termWidth - 6)
  const gap = 2
  const leftWidth = Math.min(30, Math.floor((contentWidth - gap) * 0.34))
  const rightWidth = contentWidth - leftWidth - gap

  return (
    <Shell
      titleLeft={`AgentOS domain check · v${props.version}`}
      titleRight="Naming"
      footerLeft={props.available ? 'Ready to buy' : 'Try another domain'}
      footerRight="phase 2"
    >
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
  const contentWidth = Math.max(72, termWidth - 6)
  const gap = 2
  const leftWidth = Math.min(28, Math.floor((contentWidth - gap) * 0.3))
  const rightWidth = contentWidth - leftWidth - gap
  const cheapest = [...props.items].sort((a, b) => Number(a.price) - Number(b.price))[0]

  return (
    <Shell
      titleLeft={`AgentOS domain pricing · v${props.version}`}
      titleRight="TLD pricing"
      footerLeft="Use agentos domain check --name <domain.tld>"
      footerRight="phase 2"
    >
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

export function SetupScreen(props: SetupScreenProps) {
  const { stdout } = useStdout()
  const termWidth = Math.max(80, stdout?.columns || 100)
  const contentWidth = Math.max(72, termWidth - 6)
  const gap = 2
  const leftWidth = Math.min(36, Math.floor((contentWidth - gap) * 0.4))
  const rightWidth = contentWidth - leftWidth - gap
  const secondary = props.chains.filter(c => c !== props.addedChain)[0]

  return (
    <Shell
      titleLeft={`AgentOS setup · v${props.version}`}
      titleRight="Wallet configured"
      footerLeft="Run agentos status to verify"
      footerRight="phase 1.5"
    >
      <Box>
        <Card title="setup complete" width={leftWidth}>
          <Text color={palette.success}>● configured</Text>
          <Box marginTop={1}>
            <Text color={palette.text} bold>
              {props.addedChain} wallet added.
            </Text>
          </Box>
          <Mascot />
        </Card>

        <Box width={gap} />

        <Card title="details" width={rightWidth}>
          <KeyValue label="API" value={props.api} />
          <KeyValue label="Chain" value={props.chains.join(', ')} />
          <KeyValue label="Keyfile" value={props.keyfile} />
          <Box marginTop={1}>
            <Text color={palette.muted}>next</Text>
          </Box>
          <Text color={palette.text}>agentos status</Text>
          {props.chains.length === 1 ? (
            <Text color={palette.text}>
              {`agentos setup --keyfile <path> --chain ${props.addedChain === 'solana' ? 'base' : 'solana'}`}
            </Text>
          ) : secondary ? (
            <Text color={palette.muted}>{secondary} wallet already present</Text>
          ) : null}
        </Card>
      </Box>
    </Shell>
  )
}
