import { forwardRef } from "react";
import "./HeroOverlay.css";

const HeroOverlay = forwardRef<HTMLDivElement>((_, ref) => {
  return (
    <div ref={ref} className="phase-overlay hero-overlay" aria-hidden="false">
      <div className="overlay-inner overlay-center">
        <p className="h-eyebrow">Infrastructure for AI agents</p>
        <h1 className="h-display">
          Everything your
          <br />
          AI agent needs.
        </h1>
        <p className="h-sub">
          Provide phone numbers, email inboxes, social accounts, domains, and
          more for your agent.
        </p>
        <a className="cta" href="#tools">
          Get started <span aria-hidden="true">→</span>
        </a>
      </div>
    </div>
  );
});

HeroOverlay.displayName = "HeroOverlay";
export default HeroOverlay;
