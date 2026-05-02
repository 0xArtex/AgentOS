import "./TopNav.css";

/**
 * Floating pill nav — mirrors the markup and behavior of the landing page
 * nav (public/index.html) so branding stays consistent across pages.
 * Cross-page anchors use absolute `/` paths so they navigate to the landing
 * page's sections from anywhere.
 */
export default function TopNav() {
  return (
    <nav className="topnav">
      <div className="nav-container">
        <div className="nav-inner">
          <a href="/" className="nav-logo">
            <img src="/assets/logo.png" alt="AgentOS" />
            AgentOS
          </a>
          <div className="nav-links">
            <a href="/#features">Features</a>
            <a href="/#how-it-works">How it works</a>
            <a href="/#pricing">Pricing</a>
            <a href="/#faq">FAQ</a>
            <a
              href="https://github.com/0xArtex/AgentOS"
              target="_blank"
              rel="noopener"
            >
              GitHub
            </a>
          </div>
          <a href="/skill.md" className="nav-cta">
            Get started →
          </a>
        </div>
      </div>
    </nav>
  );
}
