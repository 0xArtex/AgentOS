import { useRef } from "react";
import { usePrefersReducedMotion } from "../lib/reducedMotion";
import { useReveal } from "../lib/useReveal";
import "./Hero.css";

export default function Hero() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const reduced = usePrefersReducedMotion();

  // Stagger the headline reveal so it lands after the autoplay video has
  // started establishing the scene. Trigger fires immediately on mount since
  // the hero is at the top of the viewport.
  const eyebrowRef = useReveal<HTMLParagraphElement>({ delay: 0.4 });
  const headingRef = useReveal<HTMLHeadingElement>({ delay: 0.6 });
  const subRef = useReveal<HTMLParagraphElement>({ delay: 1.0 });
  const ctaRef = useReveal<HTMLAnchorElement>({ delay: 1.2 });

  return (
    <section className="section hero-section">
      <div className="hero-stage">
        {!reduced ? (
          <video
            ref={videoRef}
            className="hero-video"
            src="/discovery/video/hero.mp4"
            poster="/discovery/video/hero-poster.webp"
            autoPlay
            muted
            playsInline
            preload="auto"
          />
        ) : (
          <img
            className="hero-video"
            src="/discovery/video/hero-poster.webp"
            alt=""
          />
        )}

        <div className="hero-overlay">
          <p ref={eyebrowRef} className="h-eyebrow">Infrastructure for AI agents</p>
          <h1 ref={headingRef} className="h-display hero-heading">
            Everything your
            <br />
            AI agent needs.
          </h1>
          <p ref={subRef} className="h-sub hero-sub">
            Provide phone numbers, email inboxes, social accounts, domains, and
            more for your agent.
          </p>
          <a ref={ctaRef} className="cta hero-cta" href="#tools">
            Get started <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>
    </section>
  );
}
