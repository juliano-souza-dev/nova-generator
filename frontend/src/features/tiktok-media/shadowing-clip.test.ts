import { describe, expect, it } from "vitest";

import type { ShadowingBlock } from "../../lib/api.types";
import { chosenDuration, suggestShadowingClip } from "./shadowing-clip";

const blocks = Array.from({ length: 8 }, (_, index): ShadowingBlock => ({
  id: `block-${index + 1}`,
  start_ms: index * 6000,
  end_ms: index * 6000 + 4000,
  pause_duration_ms: 5000,
  speaker: "A",
  word_count: 6,
  cue_ids: [`cue-${index}`],
  en: "I love learning English.",
  pt: "Adoro aprender inglês.",
}));

describe("TikTok Shadowing clip selection", () => {
  it("suggests a 35–60 second chronological practice", () => {
    const selected = suggestShadowingClip(blocks);
    expect(selected).toEqual(blocks.slice(0, 5).map((block) => block.id));
    expect(chosenDuration(blocks, selected)).toBe(45_000);
  });

  it("does not include selected blocks twice or overflow the target", () => {
    expect(chosenDuration(blocks, ["block-1", "block-1", "block-2"])).toBe(18_000);
    expect(
      suggestShadowingClip(blocks.map((block) => ({ ...block, pause_duration_ms: 9000 }))),
    ).toHaveLength(4);
  });
});
