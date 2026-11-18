export type CaptionWord = {
  text: string; startMs: number; endMs: number; translation?: string; pt?: string;
  ptGroup?: string; ptGroupRole?: "lead" | "member" | "";
  originalStartMs?: number; originalEndMs?: number; confidenceScore?: number | null;
  reviewStatus?: "pending" | "aligned" | "approved" | "flagged";
  alignmentSource?: "auto" | "manual" | "estimated" | "none" | "translation_timing";
};
export function captionWordsForTimeline(words: CaptionWord[], captionStartMs: number, captionEndMs: number): CaptionWord[] {
  if (!words.length || captionStartMs <= 0) return words;
  const duration = Math.max(0, captionEndMs - captionStartMs);
  const hasRelativeTimes = words.some(word => word.startMs < captionStartMs - 250)
    && Math.max(...words.map(word => word.endMs)) <= duration + 500;
  if (!hasRelativeTimes) return words;
  return words.map(word => ({ ...word, startMs: word.startMs + captionStartMs, endMs: word.endMs + captionStartMs }));
}

export type CaptionSemanticGroup = { id: string; text: string; startMs: number; endMs: number; firstWordIndex: number; lastWordIndex: number };
export function captionSemanticGroups(words: CaptionWord[]): CaptionSemanticGroup[] {
  const completeMapping = words.every(word => !!word.ptGroup?.trim() || !!word.pt?.trim() || !!word.translation?.trim());
  if (!completeMapping) return [];
  const grouped = new Map<string, CaptionSemanticGroup>();
  words.forEach((word, index) => {
    const text = (word.pt || word.translation || "").trim();
    const id = word.ptGroup?.trim() || (text ? `__word_${index}` : "");
    if (!id) return;
    const current = grouped.get(id);
    if (!current) grouped.set(id, { id, text, startMs: word.startMs, endMs: word.endMs, firstWordIndex: index, lastWordIndex: index });
    else {
      current.startMs = Math.min(current.startMs, word.startMs);
      current.endMs = Math.max(current.endMs, word.endMs);
      current.firstWordIndex = Math.min(current.firstWordIndex, index);
      current.lastWordIndex = Math.max(current.lastWordIndex, index);
      if (!current.text && text) current.text = text;
    }
  });
  return [...grouped.values()].filter(group => group.text && group.endMs > group.startMs).sort((a,b) => a.startMs-b.startMs);
}

export type MotionGraphic = { id: string; visible?: boolean; locked?: boolean; isCaption?: boolean; captionSourceLanguage?: string; captionTranslationLanguage?: string; captionMode?: "source" | "bilingual" | "karaoke"; captionEnglish?: string; captionTranslation?: string; captionWords?: CaptionWord[]; captionBackgroundColor?: string; captionBackgroundOpacity?: number; captionWidth?: number; captionPaddingEm?: number; text: string; icon?: string; lucideIconName?: string; lucideIconAnchor?: "left" | "right" | "top" | "bottom"; lucideIconSize?: number; lucideIconColor?: string; elements?: Array<{ type: string; content: string }>; fontFamily?: string; fontWeight?: number; textAlign?: "left" | "center" | "right"; startMs: number; endMs: number; durationMs: number; entranceDurationMs?: number; preset: "pop" | "slide" | "zoom" | "typewriter" | "impact" | "composition"; typewriterDurationMs?: number; color: string; accent: string; fontSize: number; x: number; y: number; sound: "pop" | "whoosh" | "impact" | "click" | "none"; soundId?: string; soundVolume?: number };

export function motionAnimationTiming(item: Pick<MotionGraphic, "entranceDurationMs" | "typewriterDurationMs">) {
  // Entrance speed is independent from how long the layer remains on screen.
  const configuredEntrance = Number.isFinite(item.entranceDurationMs) && (item.entranceDurationMs ?? 0) > 0
    ? item.entranceDurationMs!
    : 700;
  const entranceDurationMs = Math.max(100, Math.min(10000, configuredEntrance));
  const configuredWriting = Number.isFinite(item.typewriterDurationMs) && (item.typewriterDurationMs ?? 0) > 0
    ? item.typewriterDurationMs!
    : 1500;
  const typewriterDurationMs = Math.max(100, Math.min(10000, configuredWriting));
  return { entranceDurationMs, typewriterDurationMs };
}

export function motionPreviewState(item: MotionGraphic, playheadMs: number) {
  if (item.isCaption) return { text: item.captionEnglish || item.text, transform: "none", opacity: 1 };
  const { entranceDurationMs: entranceDuration, typewriterDurationMs: writingDuration } = motionAnimationTiming(item);
  const progress = Math.max(0, Math.min(1, (playheadMs - item.startMs) / entranceDuration));
  const writingProgress = Math.max(0, Math.min(1, (playheadMs - item.startMs) / writingDuration));
  const eased = 1 - Math.pow(1 - progress, 3);
  let transform = "none";
  let opacity = 1;
  let text = (item.icon ? item.icon + " " : "") + item.text;

  switch (item.preset) {
    case "typewriter": {
      const characters = Array.from(text);
      const visible = characters.length ? Math.min(characters.length, Math.floor(writingProgress * characters.length) + 1) : 0;
      text = characters.slice(0, visible).join("");
      break;
    }
    case "pop":
      transform = `scale(${0.35 + 0.65 * eased})`;
      break;
    case "slide":
      transform = `translateX(${(1 - eased) * 100}%)`;
      break;
    case "zoom":
      transform = `scale(${2.4 - 1.4 * eased})`;
      opacity = Math.min(1, progress * 4);
      break;
    case "impact": {
      const scale = progress < 0.65
        ? 3 - 2.12 * (progress / 0.65)
        : 0.88 + 0.12 * ((progress - 0.65) / 0.35);
      transform = `scale(${scale})`;
      opacity = Math.min(1, progress * 4);
      break;
    }
  }
  return { text, transform, opacity };
}
