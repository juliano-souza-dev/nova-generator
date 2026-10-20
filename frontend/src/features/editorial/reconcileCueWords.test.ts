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

  it("does not invent timestamps for an added word", () => {
    const result = reconcileCueWords("Not until I speak to you and Lizzie!", words);
    expect(result.error).toMatch(/tempos IN\/OUT/);
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
