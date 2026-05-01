import { useEffect, useState } from "react";

/**
 * Returns CSS styles for an absolutely-positioned div that mirrors the
 * actual displayed area of an `object-fit: cover` 16:9 canvas — accounting
 * for the cropping when the viewport's aspect differs from the image's.
 *
 * Children of this overlay can be positioned at image-relative percentages
 * and they'll line up with content baked into the canvas frame regardless
 * of viewport size.
 */
const IMAGE_ASPECT = 16 / 9;

export function useCanvasOverlay(): React.CSSProperties {
  const [style, setStyle] = useState<React.CSSProperties>({
    position: "absolute",
    inset: 0,
  });

  useEffect(() => {
    const update = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const va = vw / vh;
      if (va >= IMAGE_ASPECT) {
        // Viewport wider than image: image fills width, overflows vertically.
        const ih = vw / IMAGE_ASPECT;
        setStyle({
          position: "absolute",
          left: 0,
          top: (vh - ih) / 2,
          width: vw,
          height: ih,
        });
      } else {
        // Viewport narrower (rare on desktop): image fills height, overflows horizontally.
        const iw = vh * IMAGE_ASPECT;
        setStyle({
          position: "absolute",
          top: 0,
          left: (vw - iw) / 2,
          width: iw,
          height: vh,
        });
      }
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return style;
}
