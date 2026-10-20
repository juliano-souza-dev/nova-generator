import { describe, expect, it } from "vitest";
import type { WordTiming } from "../../lib/api.types";
import { reconcileCueWords } from "./reconcileCueWords";

const surfaces = ["Not", " until", " I", " speak", " to", " you!", " Lizzie!"];
const words: WordTiming[] = surfaces.map((surface, index) => ({
  id: "word-" + index,
  order: index + 1,
  surface,
  start_ms: 12750 + index * 340,
  end_ms: 12900 + index * 340,
  pt: ["Não", "até", "eu", "falar", "com", "você", "Lizzie"][index],
}));

describe("approved-English word reconciliation", () => {
  it("drops the intruding word immediately, retaining Lizzie's identity and timing", () => {
    const result = reconcileCueWords("Not until I speak to  Lizzie!", words);
    expect(result.error).toBeUndefined();
    expect(result.words.map((word) => word.surface)).toEqual([
      "Not", " until", " I", " speak", " to", "  Lizzie!",
    ]);
    expect(result.words.map((word) => word.id)).toEqual([
      "word-0", "word-1", "word-2", "word-3", "word-4", "word-6",
    ]);
    expect(result.words[5].start_ms).toBe(words[6].start_ms);
    expect(result.words[5].end_ms).toBe(words[6].end_ms);
    expect(result.words[5].pt).toBe("Lizzie");
    expect(words).toHaveLength(7);
  });

  it("keeps word identity for a typo or punctuation fix", () => {
    const updated = reconcileCueWords("Not until I speak to you, Lizzie!", words);
    expect(updated.error).toBeUndefined();
    expect(updated.words).toHaveLength(7);
    expect(updated.words[5].id).toBe("word-5");
    expect(updated.words[5].surface).toBe(" you,");
  });

  it("estimates each inserted word separately without discarding original anchors", () => {
    const result = reconcileCueWords("Not until I speak to you and Lizzie!", words);
    expect(result.error).toBeUndefined();
    expect(result.insertedCount).toBe(1);
    expect(result.words).toHaveLength(8);
    expect(result.words[6].surface).toBe(" and");
    expect(result.words[6].provenance?.editorial_timing_estimated).toBe(true);
    expect(result.words[6].start_ms).toBeGreaterThan(words[5].end_ms);
    expect(result.words[6].end_ms).toBeGreaterThan(result.words[6].start_ms);
    expect(result.words[7].id).toBe(words[6].id);
    expect(result.words[7].start_ms).toBeGreaterThanOrEqual(result.words[6].end_ms);
  });

  it("extends a short cue using speaking-rate estimates for all new words", () => {
    const base = [{
      id: "what", order: 1, surface: "What's", start_ms: 29550, end_ms: 29930, pt: "o que",
    }];
    const result = reconcileCueWords("What's the point?", base, 29550);
    expect(result.words.map((word) => word.surface)).toEqual(["What's", " the", " point?"]);
    expect(result.insertedCount).toBe(2);
    expect(result.words[0].start_ms).toBe(29550);
    expect(result.words[0].end_ms).toBe(29930);
    expect(result.words[1].start_ms).toBeGreaterThan(result.words[0].end_ms);
    expect(result.words[2].start_ms).toBeGreaterThanOrEqual(result.words[1].end_ms);
    expect(result.suggestedEndMs).toBeGreaterThan(29930);
  });

  it("invalidates a partially deleted semantic group instead of keeping a stale translation", () => {
    const originals: WordTiming[] = words.map((word) => ({ ...word }));
    originals[4] = {
      ...originals[4],
      semantic_group_id: "semantic-one",
      semantic_group_role: "lead",
      pt: "com você",
    };
    originals[5] = {
      ...originals[5],
      semantic_group_id: "semantic-one",
      semantic_group_role: "member",
      pt: null,
    };
    const result = reconcileCueWords("Not until I speak to Lizzie!", originals);
    expect(result.error).toBeUndefined();
    expect(result.words[4].semantic_group_id).toBeNull();
    expect(result.words[4].provenance?.translation_review_required).toBe(true);
  });
});
