import React, { PropsWithChildren, useEffect, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { MASCOT_STIPPLE } from './mascot-data.js'

// ─── Types ───

export type DashboardProps = {
  version: string
  chain?: string
  wallets?: Record<string, { keyfile?: string; owsWalletId?: string }> | undefined
  apiOk?: boolean
  onSelectAction?: (command: string) => void
}

export type ScreenControls = { interactive?: boolean; onBack?: () => void }

export type StatusScreenProps = { version: string; api: string; apiOk: boolean; wallets?: Record<string, { keyfile?: string; owsWalletId?: string }>; defaultChain?: string }
export type SetupScreenProps = { version: string; api: string; keyfile: string; chains: string[]; addedChain: string }
export type ComputePlansScreenProps = { version: string; plans: Array<{ name: string; cpu: string; ram: string; price: string }> }
export type DomainCheckScreenProps = { version: string; domain: string; available: boolean }
export type DomainPricingScreenProps = { version: string; query: string; items: Array<{ tld: string; price: string }> }
export type WalletCreateScreenProps = { version: string; id: string; solana: string | null; base: string | null; chains: string[] }
export type WalletStatusScreenProps = { version: string; id: string; label: string; accounts: Array<{ chainId: string; address: string }> }
export type WalletListScreenProps = { version: string; wallets: Array<{ id: string; label: string; solana: string | null; base: string | null; chains: number }> }
export type ComputeDeployScreenProps = { version: string; ip: string; id: string; type: string; name: string }
export type ComputeListScreenProps = { version: string; servers: Array<{ ip: string; type: string; status: string }> }
export type SuccessScreenProps = { version: string; title: string; subtitle: string; details: Array<{ label: string; value: string }>; footerLeft: string }
export type PricingScreenProps = { version: string; services: Array<{ name: string; items: Array<{ label: string; value: string }> }> }
export type HealthScreenProps = { version: string; status: string; uptime: string; apiVersion: string }
export type MenuScreenProps = { version: string; title: string; subtitle: string; commands: Array<{ name: string; description: string; hint?: string }>; footerLeft: string }
export type RecordsScreenProps = { version: string; title: string; subtitle: string; records: Array<{ primary: string; secondary?: string; status?: string }>; footerLeft: string }
export type ErrorScreenProps = { version: string; title: string; message: string; hint?: string; footerLeft: string }

// ─── Theme ───

const C = {
  accent: 'yellow',        // section headers, mascot, selected items
  bright: 'whiteBright',   // service names, primary values
  text: 'white',           // regular text
  label: 'yellowBright',   // key labels in key:value pairs
  muted: 'gray',           // descriptions, secondary info
  dim: 'blackBright',      // dividers, footer
  ok: 'green',
  err: 'red',
} as const

// ─── Stipple Mascot ───

function StippleMascot({ hide }: { hide?: boolean }) {
  if (hide) return null
  return (
    <Box flexDirection="column">
      {MASCOT_STIPPLE.map((line, i) => <Text key={i} color={C.accent}>{line}</Text>)}
    </Box>
  )
}

// ─── Primitives ───

function Row(props: { label: string; value: string; valueColor?: string }) {
  return (
    <Box>
      <Text color={C.label}>{props.label} </Text>
      <Text color={props.valueColor || C.bright}>{props.value}</Text>
    </Box>
  )
}

function Dot(props: { ok: boolean; label: string }) {
  return <Text color={props.ok ? C.ok : C.err}>{props.ok ? '●' : '○'} <Text color={C.muted}>{props.label}</Text></Text>
}

function Divider() {
  const { stdout } = useStdout()
  const w = Math.min((stdout?.columns || 80) - 4, 76)
  return <Text color={C.dim}>{'─'.repeat(w)}</Text>
}

// ─── Shell ───

function Shell(props: PropsWithChildren<{
  title: string
  version: string
  footer?: string
  autoExit?: boolean
  onBack?: () => void
}>) {
  useInput((input, key) => {
    if (props.onBack && (input === 'b' || key.escape)) props.onBack()
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {props.autoExit === false ? null : <AutoExit />}

      {/* Header */}
      <Box>
        <Text color={C.accent} bold>AgentOS</Text>
        <Text color={C.dim}> v{props.version}</Text>
        <Text color={C.muted}> · {props.title}</Text>
      </Box>

      <Divider />

      {/* Content */}
      <Box marginY={1} flexDirection="column">
        {props.children}
      </Box>

      <Divider />

      {/* Footer */}
      <Text color={C.dim}>{props.footer || ''}</Text>
    </Box>
  )
}

function AutoExit() {
  const { exit } = useApp()
  useEffect(() => { const t = setTimeout(() => exit(), 10); return () => clearTimeout(t) }, [exit])
  return null
}

// ─── Generic Screen ───

function Screen(props: {
  title: string
  version: string
  rows: Array<{ label: string; value: string }>
  footer?: string
  interactive?: boolean
  onBack?: () => void
}) {
  const { stdout } = useStdout()
  const narrow = (stdout?.columns || 80) < 60
  return (
    <Shell title={props.title} version={props.version} footer={props.interactive ? 'b/esc back' : props.footer} autoExit={props.interactive ? false : undefined} onBack={props.onBack}>
      <Box flexDirection="column">
        {props.rows.map((r, i) => <Row key={i} label={r.label} value={r.value} />)}
      </Box>
    </Shell>
  )
}

// ─── Dashboard ───

export function Dashboard(props: DashboardProps) {
  const { stdout } = useStdout()
  const cols = stdout?.columns || 80
  const narrow = cols < 70

  const services = [
    { name: 'Phone', actions: 'search · buy · sms · call' },
    { name: 'Email', actions: 'create · read · send' },
    { name: 'Domains', actions: 'check · pricing · buy · dns' },
    { name: 'Compute', actions: 'plans · deploy · list' },
    { name: 'Wallet', actions: 'create · status · keygen' },
    { name: 'Accounts', actions: 'X · TikTok · Reddit' },
  ]

  return (
    <Shell title="home" version={props.version} footer="Run agentos <service> <command> to get started">
      <Box flexDirection={narrow ? 'column' : 'row'}>
        {/* Left: mascot + branding */}
        <Box flexDirection="column" marginRight={narrow ? 0 : 3} marginBottom={narrow ? 1 : 0}>
          <StippleMascot hide={narrow} />
          <Text color={C.muted}>Everything agents need.</Text>
        </Box>

        {/* Right: services */}
        <Box flexDirection="column">
          <Text color={C.accent} bold>Services</Text>
          {services.map(s => (
            <Box key={s.name}>
              <Text color={C.label}>{s.name.padEnd(10)}</Text>
              <Text color={C.muted}>{s.actions}</Text>
            </Box>
          ))}

          <Box marginTop={1}>
            <Text color={C.accent} bold>Examples</Text>
          </Box>
          <Text color={C.muted}>  agentos phone search --country US</Text>
          <Text color={C.muted}>  agentos compute plans</Text>
          <Text color={C.muted}>  agentos domain check --name my.dev</Text>
          <Text color={C.muted}>  agentos --help</Text>
        </Box>
      </Box>
    </Shell>
  )
}

// ─── Screens ───

export function StatusScreen(props: StatusScreenProps & ScreenControls) {
  const w = props.wallets || {}
  return <Screen title="status" version={props.version} interactive={props.interactive} onBack={props.onBack} footer={props.apiOk ? 'API healthy' : 'API offline'} rows={[
    { label: 'API:', value: props.api },
    { label: 'Status:', value: props.apiOk ? 'healthy' : 'offline' },
    { label: 'Solana:', value: w.solana?.keyfile || 'not set' },
    { label: 'Base:', value: w.base?.keyfile || 'not set' },
    { label: 'Default:', value: props.defaultChain || 'solana' },
  ]} />
}

export function SetupScreen(props: SetupScreenProps & ScreenControls) {
  return <Screen title="setup" version={props.version} interactive={props.interactive} onBack={props.onBack} footer="Run status to verify" rows={[
    { label: 'Added:', value: props.addedChain },
    { label: 'API:', value: props.api },
    { label: 'Chains:', value: props.chains.join(', ') },
    { label: 'Keyfile:', value: props.keyfile },
  ]} />
}

export function ComputePlansScreen(props: ComputePlansScreenProps & ScreenControls) {
  return <Screen title="compute plans" version={props.version} interactive={props.interactive} onBack={props.onBack} footer="deploy --type <plan>" rows={
    props.plans.slice(0, 6).map(p => ({ label: p.name, value: `${p.cpu} · ${p.ram} · $${p.price}/mo` }))
  } />
}

export function DomainCheckScreen(props: DomainCheckScreenProps & ScreenControls) {
  return <Screen title="domain check" version={props.version} interactive={props.interactive} onBack={props.onBack} footer={props.available ? 'Ready to buy' : 'Try another'} rows={[
    { label: 'Domain:', value: props.domain },
    { label: 'Status:', value: props.available ? 'available' : 'taken' },
  ]} />
}

export function DomainPricingScreen(props: DomainPricingScreenProps & ScreenControls) {
  return <Screen title="pricing" version={props.version} interactive={props.interactive} onBack={props.onBack} footer="domain check --name <n>" rows={
    props.items.slice(0, 6).map(i => ({ label: `.${i.tld}`, value: `$${i.price}` }))
  } />
}

export function WalletCreateScreen(props: WalletCreateScreenProps & ScreenControls) {
  return <Screen title="wallet created" version={props.version} interactive={props.interactive} onBack={props.onBack} footer="Wallet ready" rows={[
    { label: 'ID:', value: props.id },
    ...(props.solana ? [{ label: 'Solana:', value: props.solana }] : []),
    ...(props.base ? [{ label: 'Base:', value: props.base }] : []),
    { label: 'Chains:', value: props.chains.join(', ') },
  ]} />
}

export function WalletStatusScreen(props: WalletStatusScreenProps & ScreenControls) {
  return <Screen title="wallet" version={props.version} interactive={props.interactive} onBack={props.onBack} footer="Encrypted vault" rows={[
    { label: 'ID:', value: props.id },
    { label: 'Label:', value: props.label },
    ...props.accounts.map(a => ({ label: a.chainId + ':', value: a.address })),
  ]} />
}

export function WalletListScreen(props: WalletListScreenProps & ScreenControls) {
  return <Screen title="wallets" version={props.version} interactive={props.interactive} onBack={props.onBack} footer={`${props.wallets.length} wallet(s)`} rows={
    props.wallets.map(w => ({ label: w.label, value: `${w.solana || w.base || 'no address'} (${w.chains} chains)` }))
  } />
}

export function ComputeDeployScreen(props: ComputeDeployScreenProps & ScreenControls) {
  return <Screen title="deployed" version={props.version} interactive={props.interactive} onBack={props.onBack} footer="Server live" rows={[
    { label: 'IP:', value: props.ip },
    { label: 'Name:', value: props.name },
    { label: 'Type:', value: props.type },
    { label: 'SSH:', value: `root@${props.ip}` },
  ]} />
}

export function ComputeListScreen(props: ComputeListScreenProps & ScreenControls) {
  return <Screen title="servers" version={props.version} interactive={props.interactive} onBack={props.onBack} footer={`${props.servers.length} server(s)`} rows={
    props.servers.slice(0, 6).map(s => ({ label: s.ip, value: `${s.type} · ${s.status}` }))
  } />
}

export function SuccessScreen(props: SuccessScreenProps & ScreenControls) {
  return <Screen title={props.title} version={props.version} interactive={props.interactive} onBack={props.onBack} footer={props.footerLeft} rows={props.details} />
}

export function PricingScreen(props: PricingScreenProps & ScreenControls) {
  return <Screen title="pricing" version={props.version} interactive={props.interactive} onBack={props.onBack} footer="All prices USD/USDC" rows={
    props.services.slice(0, 6).map(s => ({ label: s.name, value: s.items.map(i => `${i.label} $${i.value}`).join(' · ') }))
  } />
}

export function HealthScreen(props: HealthScreenProps & ScreenControls) {
  return <Screen title="health" version={props.version} interactive={props.interactive} onBack={props.onBack} footer={props.status === 'healthy' ? 'OK' : 'Degraded'} rows={[
    { label: 'Status:', value: props.status },
    { label: 'Version:', value: props.apiVersion },
    { label: 'Uptime:', value: props.uptime },
  ]} />
}

export function MenuScreen(props: MenuScreenProps & ScreenControls) {
  return <Screen title={props.title} version={props.version} interactive={props.interactive} onBack={props.onBack} footer={props.footerLeft} rows={
    props.commands.slice(0, 8).map(c => ({ label: c.name, value: [c.description, c.hint].filter(Boolean).join(' · ') }))
  } />
}

export function RecordsScreen(props: RecordsScreenProps & ScreenControls) {
  return <Screen title={props.title} version={props.version} interactive={props.interactive} onBack={props.onBack} footer={props.footerLeft} rows={
    props.records.slice(0, 8).map(r => ({ label: r.primary, value: [r.secondary, r.status].filter(Boolean).join(' · ') || '-' }))
  } />
}

export function ErrorScreen(props: ErrorScreenProps & ScreenControls) {
  return <Screen title="error" version={props.version} interactive={props.interactive} onBack={props.onBack} footer={props.footerLeft} rows={[
    { label: 'Error:', value: props.message },
    ...(props.hint ? [{ label: 'Hint:', value: props.hint }] : []),
  ]} />
}
