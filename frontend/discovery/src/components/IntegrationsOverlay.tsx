import { forwardRef } from "react";
import FrameworkConstellation from "./FrameworkConstellation";
import "./IntegrationsOverlay.css";

const IntegrationsOverlay = forwardRef<HTMLDivElement>((_, ref) => {
  return (
    <div ref={ref} className="phase-overlay integrations-overlay">
      <div className="integrations-text">
        <p className="h-eyebrow">Chapter II</p>
        <h2 className="integrations-headline">
          Integrates with
          <br />
          the tools your
          <br />
          agents already use.
        </h2>
        <p className="integrations-sub">
          AgentOS plugs into OpenClaw, Claude Code, Hermes Agent, Codex, and
          any other AI framework — so your agents can do more, together.
        </p>
        <a className="cta integrations-cta" href="#tools">
          Explore integrations <span aria-hidden="true">→</span>
        </a>
      </div>
      <FrameworkConstellation />
    </div>
  );
});

IntegrationsOverlay.displayName = "IntegrationsOverlay";
export default IntegrationsOverlay;
