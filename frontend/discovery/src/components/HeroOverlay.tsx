import { forwardRef } from "react";
import { useReveal } from "../lib/useReveal";
import "./HeroOverlay.css";

const HeroOverlay = forwardRef<HTMLDivElement>((_, ref) => {
  const eyebrowRef = useReveal<HTMLParagraphElement>({ delay: 0.2 });
  const headingRef = useReveal<HTMLHeadingElement>({ delay: 0.35 });
  const subRef = useReveal<HTMLParagraphElement>({ delay: 0.6 });
  const ctaRef = useReveal<HTMLAnchorElement>({ delay: 0.75 });

  return (
    <div ref={ref} className="phase-overlay hero-overlay" aria-hidden="false">
      <div className="overlay-inner overlay-center">
        <p ref={eyebrowRef} className="h-eyebrow">Infrastructure for AI agents</p>
        <h1 ref={headingRef} className="h-display">
          Everything your
          <br />
          AI agent needs.
        </h1>
        <p ref={subRef} className="h-sub">
          Provide phone numbers, email inboxes, social accounts, domains, and
          more for your agent.
        </p>
        <a ref={ctaRef} className="cta" href="#tools">
          Get started <span aria-hidden="true">→</span>
        </a>
      </div>
    </div>
  );
});

HeroOverlay.displayName = "HeroOverlay";
export default HeroOverlay;
