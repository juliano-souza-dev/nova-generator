import type { Cue, Timing, WordTiming } from "../../lib/api.types";

export const SNAP_MS = 25;

export function snapTime(value: number, durationMs: number, snapMs = SNAP_MS): number {
  return Math.max(0, Math.min(durationMs, Math.round(value / snapMs) * snapMs));
}

export function timeToPercent(timeMs: number, durationMs: number): number {
  return durationMs <= 0 ? 0 : (timeMs / durationMs) * 100;
}

export function nudgeTiming(timing: Timing, edge: "start" | "end", deltaMs: number, durationMs: number): Timing {
  const next = snapTime(timing[`${edge}_ms`] + deltaMs, durationMs);
  if (edge === "start") return { ...timing, start_ms: Math.min(next, timing.end_ms - SNAP_MS) };
  return { ...timing, end_ms: Math.max(next, timing.start_ms + SNAP_MS) };
}

export function validateTimeline(cues: Array<Cue & { words: WordTiming[] }>): string[] {
  return cues.flatMap((cue) => {
    const errors: string[] = [];
    if (cue.speech_timing.start_ms >= cue.speech_timing.end_ms) errors.push(`Cue ${cue.order}: intervalo inválido.`);
    cue.words.forEach((word, index) => {
      const prior = cue.words[index - 1];
      if (word.start_ms >= word.end_ms) errors.push(`Palavra “${word.surface}”: intervalo inválido.`);
      if (prior && word.start_ms < prior.end_ms) errors.push(`Palavra “${word.surface}”: sobrepõe a anterior.`);
      if (word.start_ms < cue.speech_timing.start_ms || word.end_ms > cue.speech_timing.end_ms) errors.push(`Palavra “${word.surface}”: fora do cue.`);
    });
    return errors;
  });
}
