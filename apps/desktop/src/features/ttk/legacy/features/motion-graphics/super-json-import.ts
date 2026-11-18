import type { CaptionWord, MotionGraphic } from "./model";

export function parseSuperJsonCues(rawCues: unknown[], playheadMs: number): MotionGraphic[] {
  return rawCues.flatMap(rawCue => {
            if (!rawCue || typeof rawCue !== "object") return [];
            const cue = rawCue as Record<string, unknown>;
            const asNumber = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
            const cueStart = cue.start_ms !== undefined ? asNumber(cue.start_ms, 0) : asNumber(cue.start, 0) * 1000;
            const cueEnd = cue.end_ms !== undefined ? asNumber(cue.end_ms, cueStart + 1500) : asNumber(cue.end, cueStart / 1000 + 1.5) * 1000;
            if (cueEnd <= cueStart) return [];
            const english = String(cue.approved_en ?? cue.en ?? cue.text_en ?? cue.text ?? "").trim();
            const portuguese = String(cue.pt ?? cue.translation_pt ?? cue.text_pt ?? "").trim();
            if (!english && !portuguese) return [];
            const rawWords = Array.isArray(cue.words) ? cue.words : [];
            const words: CaptionWord[] = rawWords.flatMap(rawWord => {
              if (!rawWord || typeof rawWord !== "object") return [];
              const word = rawWord as Record<string, unknown>;
              const wordText = String(word.text ?? word.word_text ?? "").trim();
              if (!wordText) return [];
              let start = asNumber(word.start_ms ?? word.startMs, cueStart);
              let end = asNumber(word.end_ms ?? word.endMs, start + 180);
              if (start < cueStart - 500 && end <= cueEnd - cueStart + 500) {
                start += cueStart;
                end += cueStart;
              }
              start = Math.max(cueStart, start);
              end = Math.min(cueEnd, Math.max(start + 50, end));
              if (end <= start) return [];
              return [{
                text: wordText, startMs: start, endMs: end,
                translation: String(word.pt ?? word.translation ?? "").trim(),
                pt: String(word.pt ?? "").trim(),
                ptGroup: String(word.pt_group ?? word.ptGroup ?? "").trim() || undefined,
                ptGroupRole: (["lead", "member"].includes(String(word.pt_group_role ?? word.ptGroupRole ?? "")) ? String(word.pt_group_role ?? word.ptGroupRole) : "") as CaptionWord["ptGroupRole"],
                originalStartMs: typeof word.original_start_ms === "number" ? word.original_start_ms : undefined,
                originalEndMs: typeof word.original_end_ms === "number" ? word.original_end_ms : undefined,
                confidenceScore: typeof word.confidence_score === "number" ? word.confidence_score : null,
                reviewStatus: ["pending", "aligned", "approved", "flagged"].includes(String(word.review_status)) ? word.review_status as CaptionWord["reviewStatus"] : undefined,
                alignmentSource: ["auto", "manual", "estimated", "none", "translation_timing"].includes(String(word.alignment_source)) ? word.alignment_source as CaptionWord["alignmentSource"] : undefined,
              }];
            }).sort((a,b) => a.startMs - b.startMs);
            const startMs = playheadMs + cueStart;
            const endMs = playheadMs + cueEnd;
            return [{
              id: crypto.randomUUID(),
              isCaption: true,
              captionMode: words.length ? "karaoke" as const : portuguese ? "bilingual" as const : "source" as const,
              captionEnglish: english,
              captionTranslation: portuguese,
              captionWords: words.map(word => ({ ...word, startMs: playheadMs + word.startMs, endMs: playheadMs + word.endMs })),
              captionBackgroundColor: "#000000",
              captionBackgroundOpacity: 0.76,
              captionWidth: 90,
              captionPaddingEm: 0.32,
              text: portuguese ? english + "\n" + portuguese : english || portuguese,
              icon: "",
              fontFamily: "Arial",
              fontWeight: 900,
              textAlign: "center",
              startMs,
              endMs,
              durationMs: endMs - startMs,
              preset: "pop" as const,
              color: "#ffffff",
              accent: "#65d6c0",
              fontSize: 48,
              x: 50,
              y: 82,
              sound: "none" as const,
              soundId: "",
              soundVolume: 80,
            }];
  });
}


import type { SceneSpec } from "../../shared/scene-spec";

export function sceneSpecToMotionGraphics(parsed: SceneSpec, playheadMs: number): MotionGraphic[] {
  return parsed.scenes.flatMap(scene =>
        scene.blocks.map(block => {
          const startMs = playheadMs + (block.startOffsetMs ?? 0);
          const endMs = startMs + (block.durationMs ?? scene.durationMs);
          return {
            id: crypto.randomUUID(),
            text: block.text,
            icon: block.icon ?? "",
            lucideIconName: block.iconName ?? "",
            lucideIconAnchor: block.iconAnchor ?? "left",
            lucideIconSize: block.iconSize,
            lucideIconColor: block.iconColor,
            fontFamily: "Arial",
            fontWeight: 900,
            textAlign: block.align ?? "center",
            startMs,
            endMs,
            durationMs: endMs - startMs,
            preset: "pop" as const,
            color: block.color,
            accent: block.accent ?? "#65d6c0",
            fontSize: block.fontSize,
            x: block.x,
            y: block.y,
            sound: "none" as const,
            soundId: "",
            soundVolume: 80,
          };
        }),
  );
}


export function sceneTemplateToMotionGraphics(
  scene: SceneSpec["scenes"][number],
  playheadMs: number,
): MotionGraphic[] {
  return scene.blocks.map(block => {
    const startMs = playheadMs + (block.startOffsetMs ?? 0);
    const endMs = startMs + (block.durationMs ?? scene.durationMs);
    return {
      id: crypto.randomUUID(),
      text: block.text,
      icon: block.icon ?? "",
      fontFamily: "Arial",
      fontWeight: 900,
      textAlign: block.align ?? "center",
      startMs,
      endMs,
      durationMs: endMs - startMs,
      preset: "pop" as const,
      color: block.color,
      accent: block.accent ?? "#65d6c0",
      fontSize: block.fontSize,
      x: block.x,
      y: block.y,
      sound: "none" as const,
      soundId: "",
      soundVolume: 80,
    };
  });
}
