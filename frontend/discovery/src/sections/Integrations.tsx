import { useReveal } from "../lib/useReveal";
import FrameworkConstellation from "../components/FrameworkConstellation";
import "./Integrations.css";

export default function Integrations() {
  const eyebrowRef = useReveal<HTMLParagraphElement>({ delay: 0.0 });
  const headingRef = useReveal<HTMLHeadingElement>({ delay: 0.1 });
  const subRef = useReveal<HTMLParagraphElement>({ delay: 0.25 });
  const ctaRef = useReveal<HTMLAnchorElement>({ delay: 0.35 });

  return (
    <section className="section integrations-section">
      <div className="container integrations-grid">
        <div className="integrations-text">
          <p ref={eyebrowRef} className="h-eyebrow">Chapter II</p>
          <h2 ref={headingRef} className="h-display">
            Integrates with
            <br />
            the tools your
            <br />
            agents already use.
          </h2>
          <p ref={subRef} className="h-sub">
            AgentOS plugs into OpenClaw, Claude Code, Hermes Agent, Codex, and
            any other AI framework — so your agents can do more, together.
          </p>
          <a ref={ctaRef} className="cta" href="#tools">
            Explore integrations <span aria-hidden="true">→</span>
          </a>
        </div>
        <div className="integrations-constellation">
          <FrameworkConstellation />
        </div>
      </div>
    </section>
  );
}
