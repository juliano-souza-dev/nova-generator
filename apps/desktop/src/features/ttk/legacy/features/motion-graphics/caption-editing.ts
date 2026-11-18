import type { MotionGraphic } from "./model";

export type CaptionSplitResult =
  | { ok: true; first: MotionGraphic; second: MotionGraphic; splitAtMs: number }
  | { ok: false; reason: "too-few-words" | "too-short" };

export function splitCaption(
  item: MotionGraphic,
  requestedSplitAtMs?: number,
  createId: () => string = () => crypto.randomUUID(),
): CaptionSplitResult {
  const sourceText = (item.captionEnglish || item.text || "").trim();
  const parts = sourceText.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { ok: false, reason: "too-few-words" };

  const words = item.captionWords || [];
  const hasRequestedPosition = Number.isFinite(requestedSplitAtMs);
  let splitIndex: number;
  let splitAtMs: number;

  if (hasRequestedPosition) {
    const requested = requestedSplitAtMs as number;
    if (requested <= item.startMs || requested >= item.endMs) {
      return { ok: false, reason: "too-short" };
    }

    if (words.length >= 2) {
      // Snap the playhead to the closest word boundary so a word is never
      // split between the two caption blocks.
      const boundaries = words.slice(1).map((word, index) => ({
        index: index + 1,
        at: word.startMs,
      }));
      const boundary = boundaries.reduce((closest, current) =>
        Math.abs(current.at - requested) < Math.abs(closest.at - requested) ? current : closest
      );
      splitIndex = Math.max(1, Math.min(parts.length - 1,
        Math.round(boundary.index * parts.length / words.length)));
      splitAtMs = boundary.at;
    } else {
      const ratio = (requested - item.startMs) / (item.endMs - item.startMs);
      splitIndex = Math.max(1, Math.min(parts.length - 1, Math.round(parts.length * ratio)));
      splitAtMs = requested;
    }
  } else {
    splitIndex = Math.max(1, Math.floor(parts.length / 2));
    splitAtMs = words.length > 1
      ? words[Math.min(words.length - 1, Math.max(1, Math.floor(words.length / 2)))].startMs
      : item.startMs + Math.round((item.endMs - item.startMs) * splitIndex / parts.length);
  }

  if (splitAtMs < item.startMs + 150 || splitAtMs >= item.endMs - 150) {
    return { ok: false, reason: "too-short" };
  }

  const firstText = parts.slice(0, splitIndex).join(" ");
  const secondText = parts.slice(splitIndex).join(" ");
  const wordSplitIndex = words.length
    ? Math.max(0, Math.min(words.length, Math.round(splitIndex * words.length / parts.length)))
    : 0;
  const firstWords = words.slice(0, wordSplitIndex);
  const secondWords = words.slice(wordSplitIndex);

  const translatedParts = (item.captionTranslation || "").trim().split(/\s+/).filter(Boolean);
  const translatedSplit = translatedParts.length > 1
    ? Math.max(1, Math.min(translatedParts.length - 1, Math.round(translatedParts.length * splitIndex / parts.length)))
    : 0;
  const firstTranslation = translatedSplit
    ? translatedParts.slice(0, translatedSplit).join(" ")
    : (item.captionTranslation || "");
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
