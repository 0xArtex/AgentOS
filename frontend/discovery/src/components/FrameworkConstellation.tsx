import OpenClawIcon from "@lobehub/icons/es/OpenClaw/components/Color";
import ClaudeCodeIcon from "@lobehub/icons/es/ClaudeCode/components/Color";
import HermesAgentIcon from "@lobehub/icons/es/HermesAgent/components/Mono";
import CodexIcon from "@lobehub/icons/es/Codex/components/Color";
import { useCanvasOverlay } from "../lib/useCanvasOverlay";
import "./FrameworkConstellation.css";

interface Framework {
  id: string;
  name: string;
  /**
   * Image-relative percentages, measured from h2i frame 0076 (the empty
   * card outlines baked into the canvas). The parent .constellation div
   * is sized to mirror the actual displayed-image area, so percentages
   * here line up with the image regardless of viewport aspect.
   */
  x: number;
  y: number;
  Icon: React.ComponentType<{ size?: number | string }>;
}

const FRAMEWORKS: Framework[] = [
  { id: "openclaw",    name: "OpenClaw",      x: 80.2, y: 23.9, Icon: OpenClawIcon },
  { id: "claude-code", name: "Claude Code",   x: 84.9, y: 38.0, Icon: ClaudeCodeIcon },
  { id: "hermes",      name: "Hermes Agent",  x: 84.9, y: 53.7, Icon: HermesAgentIcon },
  { id: "codex",       name: "Codex",         x: 84.9, y: 69.4, Icon: CodexIcon },
  { id: "any",         name: "Any framework", x: 80.2, y: 83.3, Icon: AnyFrameworkIcon },
];

const CENTER = { x: 65, y: 51 };

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
  const overlayStyle = useCanvasOverlay();

  return (
    <div className="constellation" style={overlayStyle} aria-hidden="true">
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
