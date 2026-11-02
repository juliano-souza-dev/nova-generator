import type { MediaCaption } from "./tiktok-api";

export type CaptionLessonSuggestion = {
  cueId: string;
  english: string;
  highlight: string;
  note: string;
};

type MaterialCard = {
  cue_id: string;
  front_en: string;
  explanation_pt: string;
  focus_text?: string;
};

/** Read the Generator's existing pedagogical material without editing literal EN/PT. */
export function proposeMaterialLessons(
  json: string,
  captions: MediaCaption[],
): { suggestions: CaptionLessonSuggestion[]; ignored: number } {
  const payload: unknown = JSON.parse(json);
  if (!payload || typeof payload !== "object") throw new Error("O material precisa ser um JSON.");
  const value = payload as Record<string, unknown>;
  if (
    value.contract !== "nova-generator-materials-output/1.0" ||
    !Array.isArray(value.anki_cards)
  ) {
    throw new Error("Use o JSON final de materiais do Generator (versão 1.0).");
  }
  const suggestions: CaptionLessonSuggestion[] = [];
  const used = new Set<string>();
  for (const candidate of value.anki_cards) {
    const card = candidate as Partial<MaterialCard> | null;
    if (!card || typeof card !== "object") continue;
    const front = typeof card.front_en === "string" ? card.front_en.trim() : "";
    const focus = typeof card.focus_text === "string" ? card.focus_text.trim() : "";
    const note = typeof card.explanation_pt === "string" ? card.explanation_pt.trim() : "";
    if (!front || !note || note.length > 300) continue;
    const available = captions.filter((caption) => caption.enabled && !used.has(caption.cue_id));
    const matchingCue =
      available.find((caption) => caption.cue_id === card.cue_id) ??
      available.find((caption) => caption.en.trim() === front) ??
      (focus
        ? available.find((caption) =>
            caption.en.toLocaleLowerCase("en").includes(focus.toLocaleLowerCase("en")),
          )
        : undefined);
    if (!matchingCue) continue;
    // Highlight uses the original cue's exact spelling and punctuation.
    const index = focus
      ? matchingCue.en.toLocaleLowerCase("en").indexOf(focus.toLocaleLowerCase("en"))
      : -1;
    suggestions.push({
      cueId: matchingCue.cue_id,
      english: matchingCue.en,
      highlight: index >= 0 ? matchingCue.en.slice(index, index + focus.length) : "",
      note,
    });
    used.add(matchingCue.cue_id);
  }
  return { suggestions, ignored: value.anki_cards.length - suggestions.length };
}
