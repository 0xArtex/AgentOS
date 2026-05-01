// Direct-path imports of the Color variants. Importing from the package
// root via { OpenClaw } returns a CompoundedIcon whose attached `.Color`
// property the TS types don't expose cleanly through React.memo.
import OpenClawIcon from "@lobehub/icons/es/OpenClaw/components/Color";
import ClaudeCodeIcon from "@lobehub/icons/es/ClaudeCode/components/Color";
import HermesAgentIcon from "@lobehub/icons/es/HermesAgent/components/Mono";
import CodexIcon from "@lobehub/icons/es/Codex/components/Color";
import "./FrameworkConstellation.css";

interface Framework {
  id: string;
  name: string;
  /** percent of viewport width / height — anchored to match the empty card
   * outlines baked into h2i frame 0076. */
  x: number;
  y: number;
  Icon: React.ComponentType<{ size?: number | string }>;
}

const FRAMEWORKS: Framework[] = [
  { id: "openclaw",    name: "OpenClaw",      x: 76.5, y: 23,   Icon: OpenClawIcon },
  { id: "claude-code", name: "Claude Code",   x: 82.5, y: 39.5, Icon: ClaudeCodeIcon },
  { id: "hermes",      name: "Hermes Agent",  x: 82.5, y: 55.5, Icon: HermesAgentIcon },
  { id: "codex",       name: "Codex",         x: 82.5, y: 71.5, Icon: CodexIcon },
  { id: "any",         name: "Any framework", x: 76.5, y: 87,   Icon: AnyFrameworkIcon },
];

const CENTER = { x: 50.5, y: 50 };

function AnyFrameworkIcon({ size = 16 }: { size?: number | string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      {[0, 6, 12].map((y) =>
        [0, 6, 12].map((x) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="3.2" height="3.2" rx="0.6" fill="rgba(243,238,226,0.55)" />
        ))
      )}
    </svg>
  );
}

export default function FrameworkConstellation() {
  return (
    <div className="constellation" aria-hidden="true">
      <div
        className="constellation-center"
        style={{ left: `${CENTER.x}%`, top: `${CENTER.y}%` }}
      >
        <span className="center-mark">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19" />
          </svg>
          <span className="center-name">AgentOS</span>
          <span className="center-plus">+</span>
        </span>
      </div>

      {FRAMEWORKS.map(({ id, name, x, y, Icon }) => (
        <div
          key={id}
          className="constellation-card"
          style={{ left: `${x}%`, top: `${y}%` }}
        >
          <span className="card-icon"><Icon size={18} /></span>
          <span className="card-name">{name}</span>
        </div>
      ))}
    </div>
  );
}
