interface Props {
  category: string;
  size?: number;
}

/**
 * Inline SVG icon per capability category. Each row in the Tools table renders
 * one of these, picked by the row's `category` field. Single-color (currentColor)
 * so they pick up the gold accent from the wrapper.
 */
export default function CategoryIcon({ category, size = 16 }: Props) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (category) {
    case "phone":
      return (
        <svg {...props}>
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.8 12.8 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.8 12.8 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z" />
        </svg>
      );
    case "voice":
      return (
        <svg {...props}>
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
      );
    case "email":
      return (
        <svg {...props}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <polyline points="3 7 12 13 21 7" />
        </svg>
      );
    case "domain":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </svg>
      );
    case "compute":
      return (
        <svg {...props}>
          <rect x="3" y="3.5" width="18" height="6" rx="1.5" />
          <rect x="3" y="14.5" width="18" height="6" rx="1.5" />
          <line x1="7" y1="6.5" x2="7.01" y2="6.5" />
          <line x1="7" y1="17.5" x2="7.01" y2="17.5" />
        </svg>
      );
    case "twitter":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.16 17.52h1.833L7.084 4.126H5.117Z" />
        </svg>
      );
    case "tiktok":
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
          <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.83a8.16 8.16 0 0 0 4.77 1.52V6.9a4.85 4.85 0 0 1-1.84-.21Z" />
        </svg>
      );
    case "keys":
      return (
        <svg {...props}>
          <circle cx="7.5" cy="15.5" r="3.5" />
          <path d="m10 13 9.5-9.5M16 6l3 3" />
        </svg>
      );
    case "compound":
      return (
        <svg {...props}>
          <path d="M12 2 4 6v6c0 5 4 8 8 10 4-2 8-5 8-10V6Z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    case "dispatch":
      return (
        <svg {...props}>
          <circle cx="6" cy="12" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="18" cy="18" r="2" />
          <line x1="8.6" y1="11" x2="15.4" y2="6.7" />
          <line x1="8.6" y1="13" x2="15.4" y2="17.3" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}
