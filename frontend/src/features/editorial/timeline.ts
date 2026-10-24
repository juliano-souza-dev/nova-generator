import type { Cue, Timing, WordTiming } from "../../lib/api.types";

export const SNAP_MS = 25;

export function snapTime(value: number, durationMs: number, snapMs = SNAP_MS): number {
  return Math.max(0, Math.min(durationMs, Math.round(value / snapMs) * snapMs));
}

export function timeToPercent(timeMs: number, durationMs: number): number {
  return durationMs <= 0 ? 0 : (timeMs / durationMs) * 100;
}

export function nudgeTiming(
  timing: Timing,
  edge: "start" | "end",
  deltaMs: number,
  durationMs: number,
): Timing {
  const next = snapTime(timing[`${edge}_ms`] + deltaMs, durationMs);
  if (edge === "start") return { ...timing, start_ms: Math.min(next, timing.end_ms - SNAP_MS) };
  return { ...timing, end_ms: Math.max(next, timing.start_ms + SNAP_MS) };
}

export function setTimingEdge(
  timing: Timing,
  edge: "start" | "end",
  timeMs: number,
  durationMs: number,
): Timing {
  const next = snapTime(timeMs, durationMs);
  if (edge === "start") return { ...timing, start_ms: Math.min(next, timing.end_ms - SNAP_MS) };
  return { ...timing, end_ms: Math.max(next, timing.start_ms + SNAP_MS) };
}

/**
 * Recalculate each child's highlight interval when the parent speech interval
 * changes. Equal duration translates the words; a resized cue scales them
 * proportionally, preserving order and gaps where there is enough room.
 * This is a timing preview, not speech re-alignment from audio.
 */
export function remapWordsToCue(
  words: WordTiming[],
  from: Timing,
  to: Timing,
): WordTiming[] {
  if (from.start_ms === to.start_ms && from.end_ms === to.end_ms) return words;
  const oldSpan = from.end_ms - from.start_ms;
  const newSpan = to.end_ms - to.start_ms;
  if (oldSpan <= 0 || newSpan < words.length)
    throw new Error("Cue muito curta para acomodar todas as palavras.");

  const project = (timeMs: number) => {
    const offset = Math.max(0, Math.min(oldSpan, timeMs - from.start_ms));
    return to.start_ms + Math.round((offset * newSpan) / oldSpan);
  };
  let previousEnd = to.start_ms;
  return words.map((word, index) => {
    const remaining = words.length - index - 1;
    const start = Math.max(previousEnd, Math.min(project(word.start_ms), to.end_ms - remaining - 1));
    const end = Math.max(start + 1, Math.min(project(word.end_ms), to.end_ms - remaining));
    previousEnd = end;
    const changed = start !== word.start_ms || end !== word.end_ms;
    const provenance = { ...word.provenance };
    if (changed) {
      delete provenance.word_timing_reviewed;
      delete provenance.word_timing_reviewed_by;
      provenance.timing_remapped_with_cue = true;
    }
    return { ...word, start_ms: start, end_ms: end, provenance };
  });
}

/**
 * A boundary word may be moved into the silence between two cues. The target
 * cue will expand atomically on the server, so use its neighbor's boundary as
 * the outer limit of that drop zone, not only its current speech interval.
 */
export function adjacentWordDestination<T extends Cue & { words: WordTiming[] }>(
  cues: T[], cueId: string, wordId: string, startMs: number, endMs: number,
): T | undefined {
  if (startMs < 0 || endMs <= startMs) return undefined;
  const index = cues.findIndex((cue) => cue.id === cueId);
  if (index < 0) return undefined;
  const source = cues[index];
  const wordIndex = source.words.findIndex((word) => word.id === wordId);
  if (wordIndex < 0 || source.words.length <= 1) return undefined;
  const previous = cues[index - 1];
  if (wordIndex === 0 && previous &&
      startMs >= previous.speech_timing.start_ms &&
      endMs <= Math.max(previous.speech_timing.end_ms, source.speech_timing.start_ms)) {
    return previous;
  }
  const next = cues[index + 1];
  if (wordIndex === source.words.length - 1 && next &&
      startMs >= Math.min(next.speech_timing.start_ms, source.speech_timing.end_ms) &&
      endMs <= next.speech_timing.end_ms) {
    return next;
  }
  return undefined;
}

export function validateTimeline(
  cues: Array<Cue & { words: WordTiming[] }>,
  options: { ignoreDraftWordOutsideCueId?: string } = {},
): string[] {
  return cues.flatMap((cue) => {
    const errors: string[] = [];
    if (cue.speech_timing.start_ms >= cue.speech_timing.end_ms)
      errors.push(`Cue ${cue.order}: intervalo inválido.`);
    cue.words.forEach((word, index) => {
      const prior = cue.words[index - 1];
      if (word.start_ms >= word.end_ms)
        errors.push(`Palavra “${word.surface}”: intervalo inválido.`);
      if (prior && word.start_ms < prior.end_ms)
        errors.push(`Palavra “${word.surface}”: sobrepõe a anterior.`);
      if ((word.start_ms < cue.speech_timing.start_ms || word.end_ms > cue.speech_timing.end_ms) &&
          (!options.ignoreDraftWordOutsideCueId || word.id !== options.ignoreDraftWordOutsideCueId))
        errors.push(`Palavra “${word.surface}”: fora do cue.`);
    });
    return errors;
  });
}
