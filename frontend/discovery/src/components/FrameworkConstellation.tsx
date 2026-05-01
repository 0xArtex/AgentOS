import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import "./FrameworkConstellation.css";

gsap.registerPlugin(ScrollTrigger);

interface Framework {
  id: string;
  name: string;
  /** percent positions inside the constellation box (0..100) */
  x: number;
  y: number;
  icon: React.ReactNode;
}

const FRAMEWORKS: Framework[] = [
  {
    id: "openclaw",
    name: "OpenClaw",
    x: 58,
    y: 10,
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path d="M12 2 L22 12 L12 22 L2 12 Z" fill="#dc2626" />
      </svg>
    ),
  },
  {
    id: "claude-code",
    name: "Claude Code",
    x: 78,
    y: 30,
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          d="M12 3 L13.5 10.5 L21 12 L13.5 13.5 L12 21 L10.5 13.5 L3 12 L10.5 10.5 Z"
          fill="#cc785c"
        />
      </svg>
    ),
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    x: 88,
    y: 52,
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <circle cx="12" cy="9" r="3" fill="#9b8cff" />
        <path d="M6 20 C6 15 9 13 12 13 C15 13 18 15 18 20 Z" fill="#9b8cff" />
      </svg>
    ),
  },
  {
    id: "codex",
    name: "Codex",
    x: 78,
    y: 74,
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="#e6d6a3" strokeWidth="1.5">
        <polygon points="12,3 21,8 21,16 12,21 3,16 3,8" />
        <line x1="12" y1="3" x2="12" y2="21" />
        <line x1="3" y1="8" x2="21" y2="16" />
        <line x1="21" y1="8" x2="3" y2="16" />
      </svg>
    ),
  },
  {
    id: "any",
    name: "Any framework",
    x: 58,
    y: 92,
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {[0, 6, 12].map((y) =>
          [0, 6, 12].map((x) => (
            <rect key={`${x}-${y}`} x={x} y={y} width="3" height="3" rx="0.5" fill="var(--w60)" />
          ))
        )}
      </svg>
    ),
  },
];

const CENTER = { x: 18, y: 50 };

export default function FrameworkConstellation() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardsRef = useRef<Array<HTMLDivElement | null>>([]);
  const centerCardRef = useRef<HTMLDivElement | null>(null);
  const pathsRef = useRef<Array<SVGPathElement | null>>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    gsap.set(centerCardRef.current, { opacity: 0, scale: 0.92 });
    gsap.set(cardsRef.current, { opacity: 0, x: -16 });
    gsap.set(pathsRef.current, { strokeDashoffset: 220 });

    const trigger = ScrollTrigger.create({
      trigger: container,
      start: "top 75%",
      once: true,
      onEnter: () => {
        const tl = gsap.timeline({ defaults: { ease: "power2.out" } });
        tl.to(centerCardRef.current, { opacity: 1, scale: 1, duration: 0.6 })
          .to(
            pathsRef.current.filter(Boolean),
            { strokeDashoffset: 0, duration: 0.8, stagger: 0.08 },
            "-=0.35"
          )
          .to(
            cardsRef.current.filter(Boolean),
            { opacity: 1, x: 0, duration: 0.55, stagger: 0.08 },
            "-=0.55"
          );
      },
    });

    return () => trigger.kill();
  }, []);

  return (
    <div ref={containerRef} className="constellation" aria-hidden="true">
      <svg className="constellation-connectors" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="conn-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="rgba(200,165,103,0.85)" />
            <stop offset="1" stopColor="rgba(200,165,103,0.25)" />
          </linearGradient>
        </defs>
        {FRAMEWORKS.map((f, i) => {
          const cx = (CENTER.x + f.x) / 2;
          const d = `M ${CENTER.x} ${CENTER.y} Q ${cx} ${CENTER.y} ${f.x} ${f.y}`;
          return (
            <path
              key={f.id}
              ref={(el) => { pathsRef.current[i] = el; }}
              d={d}
              stroke="url(#conn-grad)"
              strokeWidth="0.18"
              fill="none"
              strokeDasharray="220"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>

      <div
        ref={centerCardRef}
        className="constellation-center"
        style={{ left: `${CENTER.x}%`, top: `${CENTER.y}%` }}
      >
        <span className="center-frame">
          <span className="center-label">AgentOS</span>
          <span className="center-plus">+</span>
        </span>
      </div>

      {FRAMEWORKS.map((f, i) => (
        <div
          key={f.id}
          ref={(el) => { cardsRef.current[i] = el; }}
          className="constellation-card"
          style={{ left: `${f.x}%`, top: `${f.y}%` }}
        >
          <span className="card-icon">{f.icon}</span>
          <span className="card-name">{f.name}</span>
        </div>
      ))}
    </div>
  );
}
