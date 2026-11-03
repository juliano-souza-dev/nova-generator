import type { ShadowingBlock } from "../../lib/api.types";

export const MIN_SHADOWING_VIDEO_MS = 35_000;
export const MAX_SHADOWING_VIDEO_MS = 60_000;

export function practiceDuration(block: ShadowingBlock): number {
  return block.end_ms - block.start_ms + block.pause_duration_ms;
}

export function chosenDuration(blocks: ShadowingBlock[], ids: string[]): number {
  const chosen = new Set(ids);
  return blocks
    .filter((block) => chosen.has(block.id))
    .reduce((ms, block) => ms + practiceDuration(block), 0);
}

/** Select chronological blocks, skipping anything that would exceed the 60 s cap. */
export function suggestShadowingClip(blocks: ShadowingBlock[]): string[] {
  const chosen: string[] = [];
  let total = 0;
  for (const block of blocks) {
    const duration = practiceDuration(block);
    if (duration <= 0 || total + duration > MAX_SHADOWING_VIDEO_MS || chosen.length >= 12) continue;
    chosen.push(block.id);
    total += duration;
    if (total >= 45_000) break;
  }
  return chosen;
}
