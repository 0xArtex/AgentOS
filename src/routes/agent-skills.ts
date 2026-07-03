/**
 * Agent Skills discovery + hosted reference serving.
 *
 * Implements the cross-vendor Agent Skills discovery convention so
 * `npx skills add https://palmyr.ai` works:
 *
 *   GET /.well-known/agent-skills/index.json  → discovery index (schema v0.2.0)
 *   GET /skill/references/:name               → a hosted reference file (text/markdown)
 *
 * The single skill (`palmyr`, type `skill-md`) points at /skill.md, whose body is
 * served by the handler in index.ts. The index advertises a `sha256:` digest over
 * the EXACT bytes served at /skill.md so clients can verify what they fetched. The
 * digest + frontmatter description are computed lazily on first request and cached,
 * keyed by the SKILL.md file's mtime + size (recomputed when the file changes).
 *
 * tsconfig does not copy non-TS assets into dist, so the skill files are read from
 * the repo path at runtime (dist/routes → ../../skills/palmyr), mirroring the
 * /skill.md handler in index.ts.
 */
import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const router = Router();

const SKILL_DIR = path.join(__dirname, "..", "..", "skills", "palmyr");
const SKILL_PATH = path.join(SKILL_DIR, "SKILL.md");
const REFERENCES_DIR = path.join(SKILL_DIR, "references");

// Reference filenames: lowercase, digits, hyphens; must end in `.md`. No slashes,
// no dots (other than the extension) → path traversal is impossible.
const REFERENCE_NAME = /^[a-z0-9-]+\.md$/;

type SkillMeta = { digest: string; description: string };
let metaCache: { key: string; value: SkillMeta } | null = null;

/** Pull the single-line `description:` out of the SKILL.md YAML frontmatter. */
function parseDescription(md: string): string {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return "";
  const m = fm[1].match(/^description:\s*(.+)$/m);
  return m ? m[1].trim() : "";
}

/**
 * Digest + description for the skill, cached on the file's mtime + size so a
 * skill edit invalidates it without a restart, but repeat requests don't re-hash.
 */
function getSkillMeta(): SkillMeta | null {
  try {
    const st = fs.statSync(SKILL_PATH);
    const key = `${st.mtimeMs}:${st.size}`;
    if (metaCache && metaCache.key === key) return metaCache.value;
    const buf = fs.readFileSync(SKILL_PATH);
    const digest = "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
    const description = parseDescription(buf.toString("utf-8"));
    const value: SkillMeta = { digest, description };
    metaCache = { key, value };
    return value;
  } catch {
    return null;
  }
}

// Discovery index — cross-vendor Agent Skills schema v0.2.0.
router.get("/.well-known/agent-skills/index.json", (_req: Request, res: Response) => {
  const meta = getSkillMeta();
  if (!meta) {
    res.status(404).json({ error: "Skill not available" });
    return;
  }
  res.json({
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: "palmyr",
        type: "skill-md",
        description: meta.description,
        url: "/skill.md",
        digest: meta.digest,
      },
    ],
  });
});

// Hosted reference files (progressive disclosure — agents fetch on demand).
router.get("/skill/references/:name", (req: Request, res: Response) => {
  const name = String(req.params.name ?? "");
  if (!REFERENCE_NAME.test(name)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const resolved = path.resolve(REFERENCES_DIR, name);
  // Defence in depth: the resolved path must stay inside the references dir.
  if (resolved !== path.join(REFERENCES_DIR, name) || !fs.existsSync(resolved)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.send(fs.readFileSync(resolved, "utf-8"));
});

export default router;
