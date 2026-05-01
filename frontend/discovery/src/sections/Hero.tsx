import { useRef } from "react";
import { usePrefersReducedMotion } from "../lib/reducedMotion";
import "./Hero.css";

export default function Hero() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const reduced = usePrefersReducedMotion();

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
          <p className="h-eyebrow">Infrastructure for AI agents</p>
          <h1 className="h-display hero-heading">
            Everything your
            <br />
            AI agent needs.
          </h1>
          <p className="h-sub hero-sub">
            Provide phone numbers, email inboxes, social accounts, domains, and
            more for your agent.
          </p>
          <a className="cta hero-cta" href="#tools">
            Get started <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>
    </section>
  );
}
