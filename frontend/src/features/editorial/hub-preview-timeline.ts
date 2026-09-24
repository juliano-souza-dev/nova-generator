import type { WordTiming } from "../../lib/api.types";
import type { TimelineCue } from "./CueWordTimeline";

export type TimedPiece = {
  text: string;
  startMs?: number;
  endMs?: number;
};

function coreSurface(value: string): string {
  return value.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
}

/** Maps timing onto literal editorial text without rebuilding its punctuation or whitespace. */
export function timedLiteralPieces(text: string, words: WordTiming[]): TimedPiece[] {
  const pieces: TimedPiece[] = [];
  let cursor = 0;
  for (const word of words) {
    const exact = word.surface;
    const core = coreSurface(exact);
    let index = text.indexOf(exact, cursor);
    let length = exact.length;
    if (index < 0 && core) {
      index = text.toLocaleLowerCase().indexOf(core.toLocaleLowerCase(), cursor);
      length = core.length;
    }
    if (index < 0) continue;
    if (index > cursor) pieces.push({ text: text.slice(cursor, index) });
    pieces.push({
      text: text.slice(index, index + length),
      startMs: word.start_ms,
      endMs: word.end_ms,
    });
    cursor = index + length;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor) });
  return pieces.length ? pieces : [{ text }];
}

export function cuePreviewBounds(cue: TimelineCue): { startMs: number; endMs: number } {
  const first = cue.words[0];
  const last = cue.words.at(-1);
  if (first && last && last.end_ms > first.start_ms)
    return { startMs: first.start_ms, endMs: last.end_ms };
  return { startMs: cue.subtitle_timing.start_ms, endMs: cue.subtitle_timing.end_ms };
}

export function activePreviewCue(cues: TimelineCue[], currentMs: number): TimelineCue | undefined {
  return cues.find((cue) => {
    const bounds = cuePreviewBounds(cue);
    return currentMs >= bounds.startMs && currentMs < bounds.endMs;
  });
}
