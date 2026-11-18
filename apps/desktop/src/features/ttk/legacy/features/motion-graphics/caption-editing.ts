import type { MotionGraphic } from "./model";

export type CaptionSplitResult =
  | { ok: true; first: MotionGraphic; second: MotionGraphic; splitAtMs: number }
  | { ok: false; reason: "too-few-words" | "too-short" };

export function splitCaption(item: MotionGraphic, createId: () => string = () => crypto.randomUUID()): CaptionSplitResult {
  const sourceText = (item.captionEnglish || item.text || "").trim();
  const parts = sourceText.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { ok: false, reason: "too-few-words" };

  const splitIndex = Math.max(1, Math.floor(parts.length / 2));
  const firstText = parts.slice(0, splitIndex).join(" ");
  const secondText = parts.slice(splitIndex).join(" ");
  const words = item.captionWords || [];
  const wordSplitIndex = Math.min(words.length, Math.max(1, Math.floor(words.length / 2)));
  const firstWords = words.slice(0, wordSplitIndex);
  const secondWords = words.slice(wordSplitIndex);
  const splitAtMs = secondWords.length
    ? Math.max(item.startMs + 150, secondWords[0].startMs)
    : item.startMs + Math.round((item.endMs - item.startMs) * splitIndex / parts.length);
  if (splitAtMs >= item.endMs - 150) return { ok: false, reason: "too-short" };

  const translatedParts = (item.captionTranslation || "").trim().split(/\s+/).filter(Boolean);
  const translatedSplit = translatedParts.length > 1
    ? Math.max(1, Math.floor(translatedParts.length * splitIndex / parts.length))
    : 0;
  const firstTranslation = translatedSplit ? translatedParts.slice(0, translatedSplit).join(" ") : (item.captionTranslation || "");
  const secondTranslation = translatedSplit ? translatedParts.slice(translatedSplit).join(" ") : "";
  const second: MotionGraphic = {
    ...item,
    id: createId(),
    text: secondText,
    captionEnglish: secondText,
    captionTranslation: secondTranslation,
    captionWords: secondWords,
    startMs: splitAtMs,
    endMs: item.endMs,
    durationMs: item.endMs - splitAtMs,
  };
  const first: MotionGraphic = {
    ...item,
    text: firstText,
    captionEnglish: firstText,
    captionTranslation: firstTranslation,
    captionWords: firstWords,
    endMs: splitAtMs,
    durationMs: splitAtMs - item.startMs,
  };
  return { ok: true, first, second, splitAtMs };
}

export function mergeCaptions(first: MotionGraphic, second: MotionGraphic): MotionGraphic {
  const firstText = (first.captionEnglish || first.text || "").trim();
  const secondText = (second.captionEnglish || second.text || "").trim();
  const firstTranslation = (first.captionTranslation || "").trim();
  const secondTranslation = (second.captionTranslation || "").trim();
  const mergedWords = [...(first.captionWords || []), ...(second.captionWords || [])]
    .sort((a, b) => a.startMs - b.startMs);
  const startMs = Math.min(first.startMs, second.startMs);
  const endMs = Math.max(first.endMs, second.endMs);
  const mergedText = [firstText, secondText].filter(Boolean).join(" ");
  const mergedTranslation = [firstTranslation, secondTranslation].filter(Boolean).join(" ");
  return {
    ...first,
    text: mergedText,
    captionEnglish: mergedText,
    captionTranslation: mergedTranslation,
    captionWords: mergedWords,
    startMs,
    endMs,
    durationMs: endMs - startMs,
  };
}

export function duplicateCaption(item: MotionGraphic, createId: () => string = () => crypto.randomUUID()): MotionGraphic {
  const duration = item.endMs - item.startMs;
  return {
    ...item,
    id: createId(),
    startMs: item.endMs,
    endMs: item.endMs + duration,
    durationMs: duration,
    captionWords: (item.captionWords || []).map(word => ({
      ...word,
      startMs: word.startMs + duration,
      endMs: word.endMs + duration,
    })),
  };
}

export function captionStyleFrom(item: MotionGraphic): Partial<MotionGraphic> {
  return {
    fontFamily: item.fontFamily,
    fontWeight: item.fontWeight,
    textAlign: item.textAlign,
    color: item.color,
    accent: item.accent,
    fontSize: item.fontSize,
    captionBackgroundColor: item.captionBackgroundColor,
    captionBackgroundOpacity: item.captionBackgroundOpacity,
    captionWidth: item.captionWidth,
    captionPaddingEm: item.captionPaddingEm,
    y: item.y,
  };
}
