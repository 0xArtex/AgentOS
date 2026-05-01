import { forwardRef } from "react";
import FrameworkConstellation from "./FrameworkConstellation";
import "./IntegrationsOverlay.css";

const IntegrationsOverlay = forwardRef<HTMLDivElement>((_, ref) => {
  return (
    <div ref={ref} className="phase-overlay integrations-overlay">
      <div className="container overlay-inner overlay-split">
        <div className="overlay-text">
          <p className="h-eyebrow">Chapter II</p>
          <h2 className="h-display">
            Integrates with
            <br />
            the tools your
            <br />
            agents already use.
          </h2>
          <p className="h-sub">
            AgentOS plugs into OpenClaw, Claude Code, Hermes Agent, Codex, and
            any other AI framework — so your agents can do more, together.
          </p>
          <a className="cta" href="#tools">
            Explore integrations <span aria-hidden="true">→</span>
          </a>
        </div>
        <div className="overlay-side">
          <FrameworkConstellation />
        </div>
      </div>
    </div>
  );
});

IntegrationsOverlay.displayName = "IntegrationsOverlay";
export default IntegrationsOverlay;
