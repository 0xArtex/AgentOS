/**
 * Captcha solver abstraction.
 *
 * Currently backed by CapSolver (https://capsolver.com). The public shape is
 * provider-agnostic so we can swap to 2Captcha / Anti-Captcha later without
 * touching the call sites.
 *
 * Env:
 *   CAPSOLVER_API_KEY   required
 *   CAPSOLVER_BASE_URL  optional (default: https://api.capsolver.com)
 */

const DEFAULT_BASE_URL = "https://api.capsolver.com";
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40; // ~2 minutes

export interface SolverConfig {
  apiKey?: string;
  baseUrl?: string;
}

function getConfig(cfg?: SolverConfig): { apiKey: string; baseUrl: string } {
  const apiKey = cfg?.apiKey || process.env.CAPSOLVER_API_KEY;
  if (!apiKey) {
    throw new Error("CAPSOLVER_API_KEY is not configured");
  }
  return { apiKey, baseUrl: cfg?.baseUrl || process.env.CAPSOLVER_BASE_URL || DEFAULT_BASE_URL };
}

export function isCaptchaSolverConfigured(): boolean {
  return Boolean(process.env.CAPSOLVER_API_KEY);
}

/* ─── TikTok: generic challenge (slider, whirl, shape-select) ──────────── */

export interface TikTokCaptchaParams {
  /** Page URL where the captcha appeared. */
  websiteURL: string;
  /** Base64 image of the challenge (if type needs it). */
  bodyImage?: string;
  /** Base64 image of the moving piece (slider-type). */
  pieceImage?: string;
  /** One of: 'slide' | 'whirl' | 'rotate' | 'shape'. CapSolver figures it out if omitted. */
  challengeType?: string;
}

export interface SliderSolution {
  /** Pixel distance to drag the slider piece. */
  x: number;
  /** Some captchas also need a y-axis drag. Optional. */
  y?: number;
}

export interface WhirlSolution {
  /** Rotation angle to align the image. Can be positive or negative. */
  angle: number;
}

export interface ShapeSolution {
  /** Array of (x, y) click points for shape-select captchas. */
  points: Array<{ x: number; y: number }>;
}

export type TikTokSolution =
  | { type: "slider"; solution: SliderSolution }
  | { type: "whirl"; solution: WhirlSolution }
  | { type: "shape"; solution: ShapeSolution };

/**
 * Submit a TikTok captcha to CapSolver and return the solution.
 * Throws on failure — callers should wrap in try/catch and degrade gracefully.
 */
export async function solveTikTokCaptcha(
  params: TikTokCaptchaParams,
  cfg?: SolverConfig
): Promise<TikTokSolution> {
  const { apiKey, baseUrl } = getConfig(cfg);

  const task: any = {
    type: "AntiTiktokTask",
    websiteURL: params.websiteURL,
  };
  if (params.bodyImage) task.bodyImage = params.bodyImage;
  if (params.pieceImage) task.pieceImage = params.pieceImage;
  if (params.challengeType) task.challengeType = params.challengeType;

  // 1. Create the task
  const createResp = await fetch(`${baseUrl}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task }),
  });
  const createBody = (await createResp.json()) as any;
  if (createBody.errorId || !createBody.taskId) {
    throw new Error(
      `CapSolver createTask failed: ${createBody.errorDescription || createBody.errorCode || "unknown"}`
    );
  }
  const taskId = createBody.taskId;

  // 2. Poll until the result is ready
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const resultResp = await fetch(`${baseUrl}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const resultBody = (await resultResp.json()) as any;

    if (resultBody.errorId) {
      throw new Error(
        `CapSolver getTaskResult failed: ${resultBody.errorDescription || resultBody.errorCode || "unknown"}`
      );
    }
    if (resultBody.status === "ready") {
      return parseTikTokSolution(resultBody.solution);
    }
    if (resultBody.status !== "processing") {
      throw new Error(`CapSolver returned unexpected status: ${resultBody.status}`);
    }
  }

  throw new Error(`CapSolver timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`);
}

function parseTikTokSolution(raw: any): TikTokSolution {
  if (!raw) throw new Error("CapSolver returned empty solution");

  // CapSolver's AntiTiktok solution shape varies by challenge type.
  if (typeof raw.x === "number") {
    return { type: "slider", solution: { x: raw.x, y: typeof raw.y === "number" ? raw.y : undefined } };
  }
  if (typeof raw.angle === "number") {
    return { type: "whirl", solution: { angle: raw.angle } };
  }
  if (Array.isArray(raw.points)) {
    return { type: "shape", solution: { points: raw.points } };
  }
  throw new Error(`Unrecognised CapSolver solution shape: ${JSON.stringify(raw).slice(0, 120)}`);
}
