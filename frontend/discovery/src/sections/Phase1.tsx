import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { preloadFrames } from "../lib/preload";
import { usePrefersReducedMotion } from "../lib/reducedMotion";
import HeroOverlay from "../components/HeroOverlay";
import IntegrationsOverlay from "../components/IntegrationsOverlay";
import "./Phase.css";

gsap.registerPlugin(ScrollTrigger);

const FRAME_PATH = "/discovery/frames/hero-to-integrations/desktop";
const FRAME_COUNT = 76;
const HEIGHT_VH = 500;

// Scroll progress checkpoints (0..1 over the full pinned section).
//
// The first 15% holds the hero (video autoplaying + hero overlay visible). The
// canvas takes over invisibly between 5–25% (its frame 0001 is the same scene
// as the video's last frame, so swapping looks like the video froze). Frames
// scrub 25–75%; canvas freezes at frame 76 from 75% onward. Integrations
// overlay fades in 78–95% over the static last frame.
const HERO_FADE_START = 0.15;
const HERO_FADE_END = 0.25;
const VIDEO_FADE_START = 0.05;
const VIDEO_FADE_END = 0.20;
const SCRUB_START = 0.25;
const SCRUB_END = 0.75;
const INT_FADE_START = 0.78;
const INT_FADE_END = 0.95;

function clamp01(t: number) {
  return Math.max(0, Math.min(1, t));
}

function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  return outMin + clamp01((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

export default function Phase1() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const heroRef = useRef<HTMLDivElement | null>(null);
  const intRef = useRef<HTMLDivElement | null>(null);
  const framesRef = useRef<ImageBitmap[]>([]);
  const lastDrawn = useRef<number>(-1);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const section = sectionRef.current;
    const canvas = canvasRef.current;
    if (!section || !canvas) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    let cancelled = false;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFrame(lastDrawn.current >= 0 ? lastDrawn.current : 0);
    };

    const drawFrame = (index: number) => {
      const bmp = framesRef.current[index];
      if (!bmp) return;
      const cw = window.innerWidth;
      const ch = window.innerHeight;
      const ir = bmp.width / bmp.height;
      const cr = cw / ch;
      let dw = cw, dh = ch, dx = 0, dy = 0;
      if (ir > cr) {
        dh = ch;
        dw = dh * ir;
        dx = (cw - dw) / 2;
      } else {
        dw = cw;
        dh = dw / ir;
        dy = (ch - dh) / 2;
      }
      ctx.drawImage(bmp, dx, dy, dw, dh);
      lastDrawn.current = index;
    };

    const onUpdate = (progress: number) => {
      // Canvas frame: hold at 0 before SCRUB_START, scrub between SCRUB_START
      // and SCRUB_END, freeze at last frame after.
      let frameIdx = 0;
      if (progress >= SCRUB_END) frameIdx = FRAME_COUNT - 1;
      else if (progress > SCRUB_START) {
        frameIdx = Math.min(
          FRAME_COUNT - 1,
          Math.floor(mapRange(progress, SCRUB_START, SCRUB_END, 0, FRAME_COUNT - 1))
        );
      }
      if (frameIdx !== lastDrawn.current && framesRef.current[frameIdx]) drawFrame(frameIdx);

      if (videoRef.current) {
        videoRef.current.style.opacity = String(
          1 - mapRange(progress, VIDEO_FADE_START, VIDEO_FADE_END, 0, 1)
        );
      }

      if (heroRef.current) {
        const op = 1 - mapRange(progress, HERO_FADE_START, HERO_FADE_END, 0, 1);
        heroRef.current.style.opacity = String(op);
        heroRef.current.style.transform = `translateY(${(1 - op) * -32}px)`;
      }

      if (intRef.current) {
        const op = mapRange(progress, INT_FADE_START, INT_FADE_END, 0, 1);
        intRef.current.style.opacity = String(op);
        intRef.current.style.transform = `translateY(${(1 - op) * 32}px)`;
      }
    };

    resize();
    window.addEventListener("resize", resize);

    const trigger = ScrollTrigger.create({
      trigger: section,
      start: "top top",
      end: "bottom bottom",
      scrub: 0.5,
      onUpdate: (self) => onUpdate(self.progress),
    });

    preloadFrames(FRAME_PATH, FRAME_COUNT).then((bitmaps) => {
      if (cancelled) {
        for (const b of bitmaps) b.close();
        return;
      }
      framesRef.current = bitmaps;
      drawFrame(0);
      onUpdate(0);
    });

    return () => {
      cancelled = true;
      window.removeEventListener("resize", resize);
      trigger.kill();
      for (const b of framesRef.current) b.close();
      framesRef.current = [];
    };
  }, []);

  return (
    <section ref={sectionRef} className="phase" style={{ height: `${HEIGHT_VH}vh` }}>
      <div className="phase-stage">
        <canvas ref={canvasRef} className="phase-canvas" />
        {!reduced && (
          <video
            ref={videoRef}
            className="phase-video"
            src="/discovery/video/hero.mp4"
            poster="/discovery/video/hero-poster.webp"
            autoPlay
            muted
            playsInline
            preload="auto"
          />
        )}
        <HeroOverlay ref={heroRef} />
        <IntegrationsOverlay ref={intRef} />
      </div>
    </section>
  );
}
