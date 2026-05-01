import { useEffect, useRef } from "react";
import { preloadFrames } from "../lib/preload";

interface Props {
  framePath: string;
  frameCount: number;
  /** Section height in viewport heights. 200vh = 100vh of pinned scrub. */
  scrollHeightVh?: number;
  children?: React.ReactNode;
}

export default function ScrollFrameCanvas({
  framePath,
  frameCount,
  scrollHeightVh = 200,
  children,
}: Props) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frames = useRef<ImageBitmap[]>([]);
  const lastDrawn = useRef<number>(-1);

  useEffect(() => {
    const canvas = canvasRef.current;
    const section = sectionRef.current;
    if (!canvas || !section) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    let cancelled = false;
    let rafId = 0;

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
      const bmp = frames.current[index];
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

    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const rect = section.getBoundingClientRect();
        const scrollable = section.offsetHeight - window.innerHeight;
        if (scrollable <= 0) return;
        const progress = Math.min(Math.max(-rect.top / scrollable, 0), 1);
        const idx = Math.min(frameCount - 1, Math.floor(progress * (frameCount - 1)));
        if (idx !== lastDrawn.current && frames.current[idx]) drawFrame(idx);
      });
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", onScroll, { passive: true });

    preloadFrames(framePath, frameCount).then((bitmaps) => {
      if (cancelled) {
        for (const b of bitmaps) b.close();
        return;
      }
      frames.current = bitmaps;
      drawFrame(0);
      onScroll();
    });

    return () => {
      cancelled = true;
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", onScroll);
      if (rafId) cancelAnimationFrame(rafId);
      for (const b of frames.current) b.close();
      frames.current = [];
    };
  }, [framePath, frameCount]);

  return (
    <section
      ref={sectionRef}
      className="section section-pinned"
      style={{ height: `${scrollHeightVh}vh` }}
    >
      <div className="sticky-stage">
        <canvas ref={canvasRef} className="section-canvas" />
        <div className="overlay">{children}</div>
      </div>
    </section>
  );
}
