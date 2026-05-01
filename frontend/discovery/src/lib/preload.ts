/**
 * Fire all frame fetches in parallel and resolve as bitmaps. The optional
 * `onFirstFrame` callback fires the moment frame 0001 finishes decoding so
 * the caller can paint it without waiting for the full sequence — keeps
 * first paint fast even though the network does a burst of 76 requests.
 *
 * `cache: "force-cache"` lets the browser reuse a `<link rel="preload">`-
 * primed entry for frame 0001 (zero round-trip on cold load).
 */
export function preloadFrames(
  basePath: string,
  count: number,
  onFirstFrame?: (bmp: ImageBitmap) => void
): Promise<ImageBitmap[]> {
  const promises: Promise<ImageBitmap>[] = [];
  for (let i = 1; i <= count; i++) {
    const url = `${basePath}/${String(i).padStart(4, "0")}.webp`;
    const p = fetch(url, { cache: "force-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`frame ${url}: ${r.status}`);
        return r.blob();
      })
      .then((b) => createImageBitmap(b));
    if (i === 1 && onFirstFrame) {
      p.then(onFirstFrame).catch(() => {
        /* will surface via Promise.all rejection */
      });
    }
    promises.push(p);
  }
  return Promise.all(promises);
}
