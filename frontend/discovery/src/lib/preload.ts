/**
 * Sequentially fetch + decode frames into ImageBitmaps so subsequent
 * draws are cheap. Sequential (not Promise.all) on purpose: 75 parallel
 * fetches saturate the connection pool and delay the first frames.
 */
export async function preloadFrames(
  basePath: string,
  count: number
): Promise<ImageBitmap[]> {
  const out: ImageBitmap[] = [];
  for (let i = 1; i <= count; i++) {
    const url = `${basePath}/${String(i).padStart(4, "0")}.webp`;
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) {
      console.warn(`[preload] missing frame ${url}`);
      continue;
    }
    const blob = await res.blob();
    out.push(await createImageBitmap(blob));
  }
  return out;
}
