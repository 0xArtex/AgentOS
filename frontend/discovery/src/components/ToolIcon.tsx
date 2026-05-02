import OpenClawColor from "@lobehub/icons/es/OpenClaw/components/Color";

interface Props {
  category: string;
  size?: number;
}

/**
 * Brand icon per capability category — maps the abstract category to the
 * underlying real-world provider's logo (Telnyx for phone, Hetzner for
 * compute hosting, OpenClaw for orchestration, etc.). Uses lobehub's
 * branded SVGs where available and falls back to the static SVGs in
 * /public/assets/logos/ for brands lobehub doesn't ship.
 *
 * AgentOS-orchestrated categories (compound, dispatch, keys, other) get
 * the AgentOS mark.
 */

type IconConfig =
  | { kind: "img"; src: string; alt: string }
  | { kind: "svg"; node: React.ReactNode; alt: string };

function map(category: string, size: number): IconConfig {
  switch (category) {
    case "phone":
    case "voice":
      return { kind: "img", src: "/assets/logos/telnyx.png", alt: "Telnyx" };
    case "email":
      return { kind: "img", src: "/assets/logos/gmail.svg", alt: "Gmail" };
    case "domain":
      return { kind: "img", src: "/assets/logos/cloudflare-icon.svg", alt: "Cloudflare" };
    case "compute":
      return {
        kind: "svg",
        alt: "OpenClaw",
        node: <OpenClawColor size={size} />,
      };
    case "twitter":
      return {
        kind: "svg",
        alt: "X",
        node: (
          <svg viewBox="0 0 24 24" width={size} height={size} fill="#fff" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.16 17.52h1.833L7.084 4.126H5.117Z" />
          </svg>
        ),
      };
    case "tiktok":
      return {
        kind: "svg",
        alt: "TikTok",
        node: (
          <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
            <path
              d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.83a8.16 8.16 0 0 0 4.77 1.52V6.9a4.85 4.85 0 0 1-1.84-.21Z"
              fill="#ee1d52"
            />
          </svg>
        ),
      };
    case "compound":
    case "dispatch":
    case "keys":
    case "other":
    default:
      return { kind: "img", src: "/assets/logo.png", alt: "AgentOS" };
  }
}

export default function ToolIcon({ category, size = 20 }: Props) {
  const cfg = map(category, size);
  if (cfg.kind === "img") {
    return (
      <img
        src={cfg.src}
        alt={cfg.alt}
        width={size}
        height={size}
        className="tool-icon-img"
      />
    );
  }
  return <span className="tool-icon-svg" role="img" aria-label={cfg.alt}>{cfg.node}</span>;
}
