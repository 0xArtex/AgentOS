import "./Integrations.css";

export default function Integrations() {
  return (
    <section className="section integrations-section">
      <div className="container integrations-grid">
        <div className="integrations-text">
          <p className="h-eyebrow">Chapter II</p>
          <h2 className="h-display">
            Integrates with
            <br />
            the tools your
            <br />
            agents already use.
          </h2>
          <p className="h-sub">
            AgentOS plugs into OpenClaw, Claude Code, Hermes Agent, Codex, and
            any other AI framework — so your agents can do more, together.
          </p>
          <a className="cta" href="#tools">
            Explore integrations <span aria-hidden="true">→</span>
          </a>
        </div>
        <div className="integrations-constellation" aria-hidden="true">
          {/* TODO: render the framework constellation (OpenClaw / Claude Code /
              Hermes / Codex / Any framework) connected to a center "AgentOS+"
              node. Placeholder for now. */}
        </div>
      </div>
    </section>
  );
}
