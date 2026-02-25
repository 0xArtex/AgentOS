/**
 * Skills Catalog — curated skills organized by category
 * 
 * Sources:
 * - ClawHub (clawhub.ai) — OpenClaw's public skills registry
 * - awesome-openclaw-skills — community-curated list (2868 skills)
 * - Custom AgentOS skills
 * 
 * Each skill has: slug, name, description, source URL, install command
 */

export interface Skill {
  slug: string;
  name: string;
  description: string;
  source: string; // GitHub URL or clawhub URL
  install: string; // npx clawhub@latest install <slug>
}

export interface SkillCategory {
  id: string;
  name: string;
  emoji: string;
  description: string;
  skills: Skill[];
}

function s(slug: string, name: string, description: string, author?: string): Skill {
  const src = author
    ? `https://github.com/openclaw/skills/tree/main/skills/${author}/${slug}`
    : `https://clawhub.ai/skills/${slug}`;
  return { slug, name, description, source: src, install: `npx clawhub@latest install ${slug}` };
}

export const SKILL_CATEGORIES: SkillCategory[] = [
  {
    id: "crypto",
    name: "Crypto & Web3",
    emoji: "🪙",
    description: "Trading, DeFi, token launches, wallets, on-chain data — Solana + Base + EVM",
    skills: [
      { slug: "bankr", name: "Bankr", description: "Trade tokens, launch tokens, DCA, limit orders, portfolio tracking across Base, Solana, Ethereum, Polygon. Earn trading fees.", source: "https://bankr.bot", install: "npx clawhub@latest install bankr" },
      { slug: "frames", name: "Frames", description: "Pay-per-use agent tools: image gen, video, market data, web scraping. Crypto payments abstracted.", source: "https://frames.ag", install: "npx clawhub@latest install frames" },
      s("agentwallet", "Agent Wallet", "Cross-chain crypto wallet with payment signing, policy controls, and transaction management"),
      s("solana-dev", "Solana Development", "Build on Solana: @solana/kit, Anchor, Pinocchio, program deployment"),
      s("solana-ecosystem", "Solana Ecosystem", "Jupiter, Raydium, Tensor, Helius, DeFi protocols, token launches on Solana"),
      s("helius", "Helius RPC", "Solana RPC access, DAS API, webhooks, transaction parsing via Helius"),
      s("token-research", "Token Research", "On-chain token analysis, price feeds, holder distribution, liquidity data"),
    ]
  },
  {
    id: "social",
    name: "Social & Marketing",
    emoji: "📢",
    description: "X/Twitter posting, social media management, content creation, audience growth",
    skills: [
      s("aisa-twitter-api", "X/Twitter API", "Search X, extract posts, post content, manage threads and engagement", "aisapay"),
      s("vibes", "Social Presence", "Social presence layer — manage reputation and visibility across platforms", "binora"),
      s("avatar-video-messages", "Video Messages", "Generate and send AI avatar video messages for engagement", "thewulf7"),
      s("clawder", "Clawder Social", "Agent social network — discover, connect, and interact with other agents", "assassin808"),
    ]
  },
  {
    id: "research",
    name: "Search & Research",
    emoji: "🔍",
    description: "Web search, deep research, data extraction, summarization",
    skills: [
      s("web", "Web Browsing", "Search the web, fetch pages, extract content from any URL"),
      s("cellcog", "Deep Research", "#1 on DeepResearch Bench — multi-step research with source verification", "nitishgargiitd"),
      s("get-tldr", "TL;DR Summaries", "Summarize any URL, article, or document instantly", "itobey"),
      s("openinsider", "SEC Insider Data", "Fetch SEC Form 4 insider trading filings in real time", "stuhorsman"),
      s("deepwiki", "DeepWiki", "Query deep knowledge bases for code repos and documentation", "arun-8687"),
    ]
  },
  {
    id: "coding",
    name: "Coding & Development",
    emoji: "💻",
    description: "Code generation, debugging, testing, multi-agent dev, Docker sandboxes",
    skills: [
      s("coding-agent", "Multi-Agent Coding", "Dispatch tasks to Codex, Claude Code, or OpenCode workers", "steipete"),
      s("cc-godmode", "God Mode", "Self-orchestrating multi-agent development workflows", "cubetribe"),
      s("docker-sandbox", "Docker Sandbox", "Spin up isolated Docker environments for safe code execution", "gitgoodordietrying"),
      s("debug-pro", "Debug Pro", "Systematic debugging with breakpoints, profiling, and root cause analysis", "cmanfre7"),
      s("test-runner", "Test Runner", "Write and run tests across any language and framework", "cmanfre7"),
      s("mcp-builder", "MCP Builder", "Build MCP (Model Context Protocol) servers and tool integrations", "seanphan"),
    ]
  },
  {
    id: "devops",
    name: "DevOps & Cloud",
    emoji: "☁️",
    description: "Docker, servers, CI/CD, deployment, infrastructure management",
    skills: [
      s("docker-essentials", "Docker Essentials", "Essential Docker commands and container workflows", "arnarsson"),
      s("ssh-tunnel", "SSH Tunneling", "SSH tunneling, port forwarding, and remote access", "gitgoodordietrying"),
      s("perry-workspaces", "Docker Workspaces", "Create and manage isolated Docker workspaces", "gricha"),
      s("coder-workspaces", "Coder Workspaces", "Manage Coder workspaces and AI coding tasks", "developmentcats"),
      s("smart-auto-updater", "Auto Updater", "Smart auto-updater with AI-powered impact analysis", "ruiwang20010702"),
    ]
  },
  {
    id: "browser",
    name: "Browser & Automation",
    emoji: "🌐",
    description: "Web automation, scraping, browser control, form filling",
    skills: [
      s("browse", "Browser Automation", "Creating and deploying browser automation functions", "pkiv"),
      s("regex-patterns", "Regex Patterns", "Practical regex patterns across languages and use cases", "gitgoodordietrying"),
    ]
  },
  {
    id: "general",
    name: "General & Productivity",
    emoji: "⚡",
    description: "Memory, task management, scheduling, identity, self-improvement",
    skills: [
      s("cognitive-memory", "Cognitive Memory", "Multi-store memory system — short-term, long-term, episodic recall", "icemilo414"),
      s("agent-identity-kit", "Identity Kit", "Portable identity system — keys, profiles, cross-platform auth", "ryancampbell"),
      s("quests", "Quest Tracker", "Guide through complex multi-step real-world processes", "poloio"),
      s("pndr", "Personal Productivity", "Tasks, journal, habits, package tracking, idea management", "dgershman"),
      s("evolver", "Self-Evolution", "Self-improvement engine — agent learns from mistakes and adapts", "autogame-17"),
      s("task-status", "Task Status", "Send live status updates during long-running operations", "mightyprime1"),
    ]
  },
  {
    id: "communication",
    name: "Communication",
    emoji: "💬",
    description: "Email, messaging, voice, multi-platform integrations",
    skills: [
      s("danube", "Danube Tools", "100+ API integrations: Gmail, GitHub, Notion, Slack, Calendar via MCP", "preston-thiele"),
      s("voice-reply", "Voice Reply", "Local text-to-speech — reply with voice in any conversation", "stolot0mt0m"),
      s("aster", "Mobile CoPilot", "Give your AI its own phone — calls, SMS, app control", "satyajiit"),
    ]
  },
  {
    id: "media",
    name: "Media & Content",
    emoji: "🎬",
    description: "Image generation, video creation, audio, streaming",
    skills: [
      s("fal-assets", "Image Generation", "Generate images and videos using fal.ai API"),
      s("generate-images", "Gemini Images", "Generate images using Google Gemini on fal.ai"),
      s("generate-video", "Video Generation", "Generate videos using Veo 3 and Kling 3 on fal.ai"),
      s("video-agent", "Video Agent", "Generate AI avatar videos with HeyGen API", "michaelwang11394"),
      s("video-cog", "Video Production", "Long-form AI video production with multi-agent workflows", "nitishgargiitd"),
      s("manim-composer", "Math Animations", "Create mathematical animations with Manim", "inclinedadarsh"),
      s("mux-video", "Mux Video", "Video infrastructure for ingesting and streaming", "dktrn9ne"),
    ]
  },
  {
    id: "data",
    name: "Data & Analytics",
    emoji: "📊",
    description: "Finance data, analytics, market monitoring, reporting",
    skills: [
      s("copilot-money", "Personal Finance", "Query portfolio data, balances, spending from Copilot Money", "jayhickey"),
      s("commit-analyzer", "Commit Analyzer", "Analyze git activity, dev velocity, and contribution patterns", "bobrenze-bot"),
      s("openinsider", "Insider Trading", "Real-time SEC Form 4 filings — who's buying and selling", "stuhorsman"),
    ]
  },
  {
    id: "security",
    name: "Security",
    emoji: "🔒",
    description: "Security scanning, password management, vulnerability detection",
    skills: [
      s("healthcheck", "Security Hardening", "Host security hardening and risk-tolerance configuration"),
      s("skill-vetting", "Skill Vetting", "Vet ClawHub skills for security before installation", "eddygk"),
      s("side-peace", "Secret Handoff", "Minimal secure secret handoff between agents", "bitbrujo"),
    ]
  },
  {
    id: "agent-infra",
    name: "Agent Infrastructure",
    emoji: "🤖",
    description: "Multi-agent orchestration, fleet management, agent-to-agent protocols",
    skills: [
      s("ec-task-orchestrator", "Task Orchestrator", "Spawn and coordinate multiple agents on complex tasks autonomously", "henrino3"),
      s("perry-coding-agents", "Agent Fleet", "Dispatch tasks to a fleet of coding agents in parallel", "gricha"),
      s("perry-workspaces", "Agent Workspaces", "Isolated Docker workspaces per agent on your tailnet", "gricha"),
      s("clawprint", "Agent Discovery", "Find, verify, and exchange capabilities with other agents", "yugovit"),
      s("arbiter", "Human Review", "Push decisions to humans for async review and approval", "5hanth"),
    ]
  },
];

/**
 * Get all categories
 */
export function getAllCategories(): SkillCategory[] {
  return SKILL_CATEGORIES;
}

/**
 * Get a category by ID
 */
export function getCategory(id: string): SkillCategory | undefined {
  return SKILL_CATEGORIES.find(c => c.id === id);
}

/**
 * Search skills by keyword
 */
export function searchSkills(query: string): Skill[] {
  const q = query.toLowerCase();
  const results: Skill[] = [];
  for (const cat of SKILL_CATEGORIES) {
    for (const skill of cat.skills) {
      if (
        skill.slug.includes(q) ||
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q)
      ) {
        results.push(skill);
      }
    }
  }
  return results;
}

/**
 * Resolve skill IDs from a list of category/skill names
 * e.g. ["crypto", "research", "browser"] → full skill lists
 */
export function resolveSkills(requested: string[]): Skill[] {
  const skills: Skill[] = [];
  const seen = new Set<string>();

  for (const req of requested) {
    const r = req.toLowerCase().trim();

    // "all" = every skill in every category
    if (r === "all") {
      for (const c of SKILL_CATEGORIES) {
        for (const skill of c.skills) {
          if (!seen.has(skill.slug)) {
            seen.add(skill.slug);
            skills.push(skill);
          }
        }
      }
      continue;
    }

    // Check if it's a category ID
    const cat = SKILL_CATEGORIES.find(c => c.id === r || c.name.toLowerCase().includes(r));
    if (cat) {
      for (const skill of cat.skills) {
        if (!seen.has(skill.slug)) {
          seen.add(skill.slug);
          skills.push(skill);
        }
      }
      continue;
    }

    // Check if it's a specific skill slug
    for (const c of SKILL_CATEGORIES) {
      for (const skill of c.skills) {
        if (skill.slug === r || skill.name.toLowerCase().includes(r)) {
          if (!seen.has(skill.slug)) {
            seen.add(skill.slug);
            skills.push(skill);
          }
        }
      }
    }
  }

  return skills;
}

/**
 * Get total skill count
 */
export function getTotalSkillCount(): number {
  return SKILL_CATEGORIES.reduce((sum, cat) => sum + cat.skills.length, 0);
}
