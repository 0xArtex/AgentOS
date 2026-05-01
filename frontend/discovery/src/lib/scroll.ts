import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/**
 * Wire a smooth scroll-driven progress callback to a section. The section
 * itself owns its height (e.g. 200vh) and contains a sticky-positioned stage;
 * we don't pin via GSAP because CSS sticky already does that — we just need
 * progress 0→1 as the section travels through the viewport.
 *
 * scrub: 0.5 lerps progress over half a second so frame transitions feel
 * smooth even when the user flicks the trackpad.
 */
export function setupScrub(
  trigger: HTMLElement,
  onProgress: (progress: number) => void
): ScrollTrigger {
  return ScrollTrigger.create({
    trigger,
    start: "top top",
    end: "bottom bottom",
    scrub: 0.5,
    onUpdate: (self) => onProgress(self.progress),
  });
}

interface RevealOptions {
  delay?: number;
  duration?: number;
  y?: number;
  start?: string;
}

/** Fade-up reveal on scroll-into-view. Idempotent: safe to call once per node. */
export function revealOnEnter(el: HTMLElement, opts: RevealOptions = {}): ScrollTrigger {
  const { delay = 0, duration = 0.9, y = 32, start = "top 80%" } = opts;
  gsap.set(el, { opacity: 0, y });
  return ScrollTrigger.create({
    trigger: el,
    start,
    once: true,
    onEnter: () => {
      gsap.to(el, {
        opacity: 1,
        y: 0,
        duration,
        delay,
        ease: "power2.out",
      });
    },
  });
}
