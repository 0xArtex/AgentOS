import { forwardRef } from "react";
import "./HeroOverlay.css";

/**
 * Hero overlay text. Initial opacity/transform is set imperatively by Phase1
 * via gsap.set, and the entrance reveal runs once the first canvas frame
 * decodes — that way text + canvas land in sync rather than racing each
 * other on the network.
 */
const HeroOverlay = forwardRef<HTMLDivElement>((_, ref) => {
  return (
    <div ref={ref} className="phase-overlay hero-overlay" aria-hidden="false">
      <div className="overlay-inner overlay-center">
        <p className="h-eyebrow hero-fx">Infrastructure for AI agents</p>
        <h1 className="h-display hero-fx">
          Everything your
          <br />
          AI agent needs.
        </h1>
        <p className="h-sub hero-fx">
          Provide phone numbers, email inboxes, social accounts, domains, and
          more for your agent.
        </p>
        <a className="cta hero-fx" href="#tools">
          Get started <span aria-hidden="true">→</span>
        </a>
      </div>
    </div>
  );
});

HeroOverlay.displayName = "HeroOverlay";
export default HeroOverlay;
