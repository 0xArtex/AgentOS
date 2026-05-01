#!/usr/bin/env bash
# Extract WebP frame sequences for the /discovery scroll-scrub transitions and
# copy the hero MP4 to its serve location. Idempotent: cleans target dirs first.
#
# Inputs (gitignored):  discovery-build/videos/Hero.mp4
#                       discovery-build/videos/Hero-to-integrations.mp4
#                       discovery-build/videos/integrations-to-tools.mp4
# Outputs (committed):  public/discovery/video/hero.mp4
#                       public/discovery/video/hero-poster.webp
#                       public/discovery/frames/<transition>/<viewport>/NNNN.webp
#
# Usage: bash scripts/discovery/extract-frames.sh
# Requires: ffmpeg on PATH.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VIDEOS="$ROOT/discovery-build/videos"
OUT_VIDEO="$ROOT/public/discovery/video"
OUT_FRAMES="$ROOT/public/discovery/frames"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "error: ffmpeg not found on PATH. Install with: winget install Gyan.FFmpeg" >&2
  exit 1
fi

# Hero: keep as MP4 (browser hardware-decodes; cheaper than scrubbing frames).
HERO_SRC="$VIDEOS/Hero.mp4"
mkdir -p "$OUT_VIDEO"
echo "→ hero: copying MP4 + extracting poster"
cp "$HERO_SRC" "$OUT_VIDEO/hero.mp4"
ffmpeg -y -hide_banner -loglevel error -sseof -0.1 -i "$HERO_SRC" \
  -vframes 1 -vf "scale=1920:-1" -q:v 80 "$OUT_VIDEO/hero-poster.webp"

# Transitions: extract frames for scroll-scrubbing. Desktop + mobile variants.
# 15fps × 5s = 75 frames. Mobile drops to 6fps × 5s = 30 frames at half-res.
extract_transition() {
  local src="$1"
  local name="$2"
  local desktop_dir="$OUT_FRAMES/$name/desktop"
  local mobile_dir="$OUT_FRAMES/$name/mobile"

  rm -rf "$desktop_dir" "$mobile_dir"
  mkdir -p "$desktop_dir" "$mobile_dir"

  echo "→ $name: extracting desktop frames (1920w, 15fps)"
  ffmpeg -y -hide_banner -loglevel error -i "$src" \
    -vf "fps=15,scale=1920:-2" -q:v 75 \
    "$desktop_dir/%04d.webp"

  echo "→ $name: extracting mobile frames (960w, 6fps)"
  ffmpeg -y -hide_banner -loglevel error -i "$src" \
    -vf "fps=6,scale=960:-2" -q:v 70 \
    "$mobile_dir/%04d.webp"

  local desktop_count
  desktop_count="$(ls "$desktop_dir" | wc -l | tr -d ' ')"
  local mobile_count
  mobile_count="$(ls "$mobile_dir" | wc -l | tr -d ' ')"
  echo "  desktop: $desktop_count frames, mobile: $mobile_count frames"
}

extract_transition "$VIDEOS/Hero-to-integrations.mp4" "hero-to-integrations"
extract_transition "$VIDEOS/integrations-to-tools.mp4" "integrations-to-tools"

echo "✓ done"
