import "./TopNav.css";

/**
 * Discovery-page top nav. Full-width bar with logo, centered links, and a
 * right cluster (npm install hint + GitHub link). Matches the structure
 * shown in the discovery design mockup rather than the landing page's
 * floating-pill nav.
 */
export default function TopNav() {
  return (
    <header className="topnav">
      <div className="container topnav-inner">
        <a href="/" className="brand">
          <img className="brand-mark" src="/assets/logo.png" alt="AgentOS" />
          <span>AgentOS</span>
        </a>

        <nav className="nav-links">
          <a href="/discovery">Capabilities</a>
          <a href="/#use-cases">Use Cases</a>
          <a href="/#pricing">Pricing</a>
          <a href="/docs">Docs</a>
          <a href="/changelog">Changelog</a>
        </nav>

        <div className="topnav-right">
          <code className="install-cmd">
            <span className="install-prompt">$</span>{" "}
            <span className="install-cmd-text">npm i -g @agentos/agentos</span>
          </code>
          <a
            href="https://github.com/0xArtex/AgentOS"
            target="_blank"
            rel="noopener"
            className="gh"
            aria-label="GitHub"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.3 1.9 1.3 1.1 1.9 2.9 1.4 3.6 1 .1-.8.4-1.4.8-1.7-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.3-3.2-.1-.3-.6-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
            </svg>
          </a>
        </div>
      </div>
    </header>
  );
}
