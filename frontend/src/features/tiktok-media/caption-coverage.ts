import type { MediaCaption } from "./tiktok-api";

export type CaptionGap = { startMs: number; endMs: number };

/** Find uncaptioned cut intervals without inventing text for real pauses. */
export function captionGaps(
  captions: MediaCaption[],
  durationMs: number,
  minimumMs = 800,
): CaptionGap[] {
  if (durationMs <= 0) return [];
  const gaps: CaptionGap[] = [];
  let cursor = 0;
  for (const caption of captions
    .filter((item) => item.enabled)
    .sort((a, b) => a.start_ms - b.start_ms)) {
    const start = Math.max(0, Math.min(durationMs, caption.start_ms));
    const end = Math.max(start, Math.min(durationMs, caption.end_ms));
    if (start - cursor >= minimumMs) gaps.push({ startMs: cursor, endMs: start });
    cursor = Math.max(cursor, end);
  }
  if (durationMs - cursor >= minimumMs) gaps.push({ startMs: cursor, endMs: durationMs });
  return gaps;
}

export function lastCaptionEnd(captions: MediaCaption[]): number {
  return captions.reduce(
    (latest, caption) => (caption.enabled ? Math.max(latest, caption.end_ms) : latest),
    0,
  );
}
