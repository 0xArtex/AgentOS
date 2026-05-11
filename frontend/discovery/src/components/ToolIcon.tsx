import OpenClawColor from "@lobehub/icons/es/OpenClaw/components/Color";

interface Props {
  /** Capability name — used for per-tool overrides (e.g. configure_openclaw). */
  name: string;
  /** Capability category — used for the default mapping. */
  category: string;
  size?: number;
}

/**
 * Brand icon per capability. Per-name overrides take priority over
 * category-based defaults so e.g. `configure_openclaw` can show the
 * OpenClaw mark while the rest of `compute` shows the Palmyr mark.
 *
 * Three rendering modes:
 *  - `mono`   – external branded asset, drained of color via grayscale filter
 *  - `invert` – dark logo on white bg (e.g. Palmyr), flipped via invert filter
 *  - `raw`    – inline SVG using `currentColor`, no filter, color set by CSS
 */
type Filter = "mono" | "invert" | "raw";

type IconConfig = { alt: string; filter: Filter } & (
  | { kind: "img"; src: string }
  | { kind: "svg"; node: React.ReactNode }
);

function PhoneSvg({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.8 12.8 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.8 12.8 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z" />
    </svg>
  );
}

function XSvg({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.16 17.52h1.833L7.084 4.126H5.117Z" />
    </svg>
  );
}

function TikTokSvg({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.83a8.16 8.16 0 0 0 4.77 1.52V6.9a4.85 4.85 0 0 1-1.84-.21Z" />
    </svg>
  );
}

function map(name: string, category: string, size: number): IconConfig {
  // Per-name overrides first
  if (name === "configure_openclaw") {
    return {
      kind: "svg",
      alt: "OpenClaw",
      filter: "mono",
      node: <OpenClawColor size={size} />,
    };
  }

  switch (category) {
    case "phone":
    case "voice":
      return { kind: "svg", alt: "Phone", filter: "raw", node: <PhoneSvg size={size} /> };
    case "email":
      return { kind: "img", src: "/assets/logos/gmail.svg", alt: "Gmail", filter: "mono" };
    case "domain":
      return {
        kind: "img",
        src: "/assets/logos/cloudflare-icon.svg",
        alt: "Cloudflare",
        filter: "mono",
      };
    case "compute":
      return { kind: "img", src: "/assets/logo.png", alt: "Palmyr", filter: "invert" };
    case "twitter":
      return { kind: "svg", alt: "X", filter: "raw", node: <XSvg size={size} /> };
    case "tiktok":
      return { kind: "svg", alt: "TikTok", filter: "raw", node: <TikTokSvg size={size} /> };
    case "compound":
    case "dispatch":
    case "keys":
    case "other":
    default:
      return { kind: "img", src: "/assets/logo.png", alt: "Palmyr", filter: "invert" };
  }
}

export default function ToolIcon({ name, category, size = 20 }: Props) {
  const cfg = map(name, category, size);
  const filterClass = `tool-icon-${cfg.filter}`;

  if (cfg.kind === "img") {
    return (
      <img
        src={cfg.src}
        alt={cfg.alt}
        width={size}
        height={size}
        className={`tool-icon-img ${filterClass}`}
      />
    );
  }
  return (
    <span
      className={`tool-icon-svg ${filterClass}`}
      role="img"
      aria-label={cfg.alt}
    >
      {cfg.node}
    </span>
  );
}
