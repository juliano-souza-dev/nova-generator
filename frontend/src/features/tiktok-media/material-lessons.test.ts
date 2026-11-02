import { describe, expect, it } from "vitest";

import { proposeMaterialLessons } from "./material-lessons";
import type { MediaCaption } from "./tiktok-api";

const caption = (cue_id: string, en: string): MediaCaption => ({
  cue_id,
  start_ms: 0,
  end_ms: 2000,
  en,
  pt: "Tradução revisada",
  highlight: "",
  note: "",
  enabled: true,
});

describe("material lessons for music captions", () => {
  it("matches cue IDs or literal expressions and never rewrites translation", () => {
    const captions = [caption("c1", "You can count on me."), caption("c2", "I will be there.")];
    const json = JSON.stringify({
      contract: "nova-generator-materials-output/1.0",
      anki_cards: [
        {
          cue_id: "other",
          front_en: "Count on me",
          focus_text: "count on",
          explanation_pt: "Contar com alguém.",
        },
        {
          cue_id: "c2",
          front_en: "Wrong text",
          focus_text: "be there",
          explanation_pt: "Estar presente.",
        },
      ],
    });
    const result = proposeMaterialLessons(json, captions);
    expect(result.ignored).toBe(0);
    expect(result.suggestions.map((item) => item.highlight)).toEqual(["count on", "be there"]);
    expect(captions[0].en).toBe("You can count on me.");
    expect(captions[0].pt).toBe("Tradução revisada");
  });

  it("rejects other contracts and ignores unmatched or overly long explanations", () => {
    expect(() => proposeMaterialLessons('{"contract":"other","anki_cards":[]}', [])).toThrow(
      /Generator/,
    );
    const result = proposeMaterialLessons(
      JSON.stringify({
        contract: "nova-generator-materials-output/1.0",
        anki_cards: [
          { cue_id: "c1", front_en: "Hi", explanation_pt: "x".repeat(301) },
          { cue_id: "missing", front_en: "Unknown", explanation_pt: "Explicação" },
        ],
      }),
      [caption("c1", "Hi")],
    );
    expect(result).toEqual({ suggestions: [], ignored: 2 });
  });
});
