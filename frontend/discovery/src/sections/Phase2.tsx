import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { preloadFrames } from "../lib/preload";
import "./Phase.css";

gsap.registerPlugin(ScrollTrigger);

const FRAME_PATH = "/discovery/frames/integrations-to-tools/desktop";
const FRAME_COUNT = 76;
const HEIGHT_VH = 400;

// Phase2 picks up where Phase1 ended visually — frame 0001 of i2t matches
// frame 76 of h2i (same empty constellation view). The integrations overlay
// stays in Phase1 only; here we just scrub the i2t transition and let the
// last frame hand off to the Tools table that follows in normal flow.
const SCRUB_START = 0.10;
const SCRUB_END = 0.85;

function clamp01(t: number) {
  return Math.max(0, Math.min(1, t));
}

function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  return outMin + clamp01((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

export default function Phase2() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framesRef = useRef<ImageBitmap[]>([]);
  const lastDrawn = useRef<number>(-1);

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
      let frameIdx = 0;
      if (progress >= SCRUB_END) frameIdx = FRAME_COUNT - 1;
      else if (progress > SCRUB_START) {
        frameIdx = Math.min(
          FRAME_COUNT - 1,
          Math.floor(mapRange(progress, SCRUB_START, SCRUB_END, 0, FRAME_COUNT - 1))
        );
      }
      if (frameIdx !== lastDrawn.current && framesRef.current[frameIdx]) drawFrame(frameIdx);
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

    preloadFrames(FRAME_PATH, FRAME_COUNT, (firstBmp) => {
      if (cancelled) return;
      framesRef.current[0] = firstBmp;
      drawFrame(0);
    }).then((bitmaps) => {
      if (cancelled) {
        for (const b of bitmaps) b.close();
        return;
      }
      framesRef.current = bitmaps;
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
      </div>
    </section>
  );
}
