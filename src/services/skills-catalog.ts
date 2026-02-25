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
    description: "Solana, Base, DeFi, token research, wallet management, on-chain analytics",
    skills: [
      s("solana-dev", "Solana Development", "End-to-end Solana development with @solana/kit, Anchor, Pinocchio, LiteSVM"),
      s("solana-ecosystem", "Solana Ecosystem", "Deep knowledge of Solana protocols, APIs, DeFi, and token launches"),
      s("solana-agents", "Solana AI Agents", "AI agent infrastructure, frameworks, and tools on Solana"),
      s("agentwallet", "Agent Wallet", "Crypto wallets for AI agents with x402 payment signing and policy controls"),
      s("x402", "x402 Protocol", "Build APIs that accept crypto payments via HTTP 402"),
      s("helius", "Helius RPC", "Helius API key signup and Solana RPC access"),
      s("token-research", "Token Research", "On-chain token analysis, price data, holder distribution"),
    ]
  },
  {
    id: "social",
    name: "Social & Marketing",
    emoji: "📢",
    description: "X/Twitter posting, social media management, content creation, audience growth",
    skills: [
      s("aisa-twitter-api", "X/Twitter API", "Search X in real time, extract posts, and post content", "aisapay"),
      s("flirtingbots", "Social Agents", "Your OpenClaw agent handles social interactions", "chemzo"),
      s("clawder", "Clawder Social", "Sync identity, browse post cards, swipe with comments", "assassin808"),
      s("vibes", "Social Presence", "Social presence layer for AI agents", "binora"),
      s("avatar-video-messages", "Video Messages", "Generate and send AI avatar video messages", "thewulf7"),
      s("content-id-guide", "Content Strategy", "Organize and understand content for creators", "otherpowers"),
      s("meta-video-ad-deconstructor", "Ad Deconstructor", "Deconstruct video ad creatives for analysis", "fortytwode"),
    ]
  },
  {
    id: "research",
    name: "Search & Research",
    emoji: "🔍",
    description: "Web search, deep research, data extraction, knowledge gathering",
    skills: [
      s("web", "Web Browsing", "Web search, browsing, and data gathering from URLs"),
      s("cellcog", "Deep Research", "#1 on DeepResearch Bench — advanced research workflows", "nitishgargiitd"),
      s("deepwiki", "DeepWiki", "Query deep knowledge bases for code and documentation", "arun-8687"),
      s("get-tldr", "TL;DR Summaries", "Get summaries of any URL or content", "itobey"),
      s("openinsider", "SEC Insider Data", "Fetch SEC Form 4 insider trading data", "stuhorsman"),
      s("learn", "Auto-Learn", "Dynamically generate knowledge skills by searching docs and extracting info"),
      s("solvr-kb", "Knowledge Base", "Search and contribute to developer knowledge bases", "fcavalcantirj"),
    ]
  },
  {
    id: "coding",
    name: "Coding & Development",
    emoji: "💻",
    description: "Code generation, debugging, testing, multi-agent development workflows",
    skills: [
      s("coding-agent", "Coding Agent", "Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent", "steipete"),
      s("python", "Python Best Practices", "Python coding guidelines and best practices", "adarshdigievo"),
      s("backend-patterns", "Backend Patterns", "Backend architecture, API design, database patterns", "charmmm718"),
      s("tdd-guide", "Test-Driven Dev", "TDD workflow with test generation and coverage tracking", "alirezarezvani"),
      s("debug-pro", "Debug Pro", "Systematic debugging methodology across languages", "cmanfre7"),
      s("cc-godmode", "Multi-Agent Dev", "Self-orchestrating multi-agent development workflows", "cubetribe"),
      s("docker-sandbox", "Docker Sandbox", "Create and manage Docker sandboxed environments", "gitgoodordietrying"),
      s("mcp-builder", "MCP Builder", "Guide for creating MCP (Model Context Protocol) servers", "seanphan"),
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
    description: "Memory, task management, scheduling, identity, file management",
    skills: [
      s("cognitive-memory", "Cognitive Memory", "Intelligent multi-store memory system with human-like recall", "icemilo414"),
      s("agent-config", "Agent Config", "Intelligently modify agent core context files", "thatguysizemore"),
      s("agent-identity-kit", "Identity Kit", "Portable identity system for AI agents", "ryancampbell"),
      s("quests", "Quest Tracker", "Track humans through complex multi-step processes", "poloio"),
      s("pndr", "Personal Productivity", "Ideas, tasks, journal, habits, package tracking", "dgershman"),
      s("executing-plans", "Plan Executor", "Use when you have a written implementation plan", "chenleiyanquan"),
      s("idea-coach", "Idea Coach", "AI-powered idea and problem manager with GitHub integration", "udiedrichsen"),
      s("task-status", "Task Status", "Send short status updates for long-running tasks", "mightyprime1"),
      s("evolver", "Self-Evolution", "A self-evolution engine for AI agents", "autogame-17"),
      s("rationality", "Rational Thinking", "Structured framework for systematic thinking", "xertrov"),
    ]
  },
  {
    id: "communication",
    name: "Communication",
    emoji: "💬",
    description: "Email, messaging, WhatsApp, notifications, voice",
    skills: [
      s("whatsapp-styling-guide", "WhatsApp Styling", "Format messages for WhatsApp correctly", "rubenfb23"),
      s("voice-reply", "Voice Reply", "Local text-to-speech using Piper voices", "stolot0mt0m"),
      s("danube", "Multi-Platform API", "100+ API tools (Gmail, GitHub, Notion, etc.) through MCP", "preston-thiele"),
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
    description: "Data analysis, visualization, spreadsheets, databases",
    skills: [
      s("copilot-money", "Personal Finance", "Query personal finance data from Copilot Money", "jayhickey"),
      s("commit-analyzer", "Commit Analyzer", "Analyze git commit patterns and development activity", "bobrenze-bot"),
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
    description: "Agent-to-agent protocols, orchestration, fleet management",
    skills: [
      s("agent-council", "Agent Council", "Toolkit for creating autonomous AI agents and managing them", "itsahedge"),
      s("ec-task-orchestrator", "Task Orchestrator", "Autonomous multi-agent task orchestration", "henrino3"),
      s("joko-orchestrator", "Joko Orchestrator", "Deterministic autonomous planning and coordination", "oyi77"),
      s("perry-coding-agents", "Multi-Agent Coding", "Dispatch coding tasks to multiple agents", "gricha"),
      s("clawprint", "Agent Discovery", "Agent discovery, trust, and exchange", "yugovit"),
      s("ooze-agents", "Agent Identity", "Visual identity that evolves with reputation", "jschwerberg"),
      s("agenticflow-skill", "Agentic Workflows", "Build AI workflows, agents, and automation", "seanphan"),
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
