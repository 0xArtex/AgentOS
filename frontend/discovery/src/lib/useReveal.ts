import { useEffect, useRef } from "react";
import { revealOnEnter } from "./scroll";

interface UseRevealOptions {
  delay?: number;
  duration?: number;
  y?: number;
  start?: string;
}

/**
 * Attach a fade-up reveal-on-scroll animation. Returns a ref to spread onto
 * the element.
 */
export function useReveal<T extends HTMLElement>(opts: UseRevealOptions = {}) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const trigger = revealOnEnter(ref.current, opts);
    return () => trigger.kill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}
