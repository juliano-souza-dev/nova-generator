import type { TranscriptResult } from "../../services/desktop-api";
import type { MotionGraphic } from "./model";

export type TranscriptTimelineContext = {
  clipId: string;
  timelineStartMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
};

export function transcriptToCaptions(
  result: TranscriptResult,
  context?: TranscriptTimelineContext,
  createId: () => string = () => crypto.randomUUID(),
): MotionGraphic[] {
  const selectedCues = result.cues.filter(cue =>
    !context || (cue.endMs > context.sourceStartMs && cue.startMs < context.sourceEndMs)
  );
  return selectedCues.map(cue => {
    const sourceStart = context ? Math.max(cue.startMs, context.sourceStartMs) : cue.startMs;
    const sourceEnd = context ? Math.min(cue.endMs, context.sourceEndMs) : cue.endMs;
    const timelineStart = context ? context.timelineStartMs + sourceStart - context.sourceStartMs : sourceStart;
    const timelineEnd = timelineStart + Math.max(300, sourceEnd - sourceStart);
    const words = cue.words.filter(word => word.endMs > sourceStart && word.startMs < sourceEnd).map(word => ({
      text: word.text,
      startMs: timelineStart + Math.max(word.startMs, sourceStart) - sourceStart,
      endMs: timelineStart + Math.min(word.endMs, sourceEnd) - sourceStart,
    }));
    return {
      id: createId(),
      isCaption: true,
      captionMode: words.length ? "karaoke" as const : "source" as const,
      captionEnglish: cue.text,
      captionSourceLanguage: result.language || "auto",
      captionTranslationLanguage: "",
      captionTranslation: "",
      captionWords: words,
      captionBackgroundColor: "#000000",
      captionBackgroundOpacity: 0.76,
      captionWidth: 90,
      captionPaddingEm: 0.32,
      text: cue.text,
      icon: "",
      fontFamily: "Arial",
      fontWeight: 900,
      textAlign: "center" as const,
      startMs: timelineStart,
      endMs: timelineEnd,
      durationMs: timelineEnd - timelineStart,
      preset: "pop" as const,
      color: "#ffffff",
      accent: "#65d6c0",
      fontSize: 48,
      x: 50,
      y: 82,
      sound: "none" as const,
      soundId: "",
      soundVolume: 80,
    };
  });
}
