import { describe, expect, it } from "vitest";

import type { EditorialCue } from "../../lib/api.types";
import {
  activeCaptionAt,
  adjustCaptionTiming,
  captionsFromApprovedCues,
  durationLabel,
} from "./caption-timeline";

function cue(
  id: string,
  start_ms: number,
  end_ms: number,
  approved_en: string,
  approved_pt: string,
  approval: string = "approved",
): EditorialCue {
  return {
    id,
    scene_id: "scene-1",
    order: 1,
    speaker: "",
    original_en: approved_en,
    approved_en,
    approved_pt,
    revision: 1,
    speech_timing: { start_ms, end_ms },
    subtitle_timing: { start_ms, end_ms },
    provenance: { approval },
    words: [],
  };
}

describe("TikTok video caption timeline", () => {
  it("keeps verified translations and cut-relative timing, even when original source starts at 30 seconds", () => {
    const imported = captionsFromApprovedCues([
      cue("cue-2", 4200, 5300, "  I mean…", "Quer dizer…"),
      cue("cue-1", 1200, 2100, "Don't stop!", "Não pare!"),
      cue("draft", 2300, 2800, "Draft", "Rascunho", "draft"),
    ]);
    expect(imported.map((part) => part.cue_id)).toEqual(["cue-1", "cue-2"]);
    expect(imported[0]).toMatchObject({
      start_ms: 1200,
      end_ms: 2100,
      en: "Don't stop!",
      pt: "Não pare!",
    });
    expect(imported[1].en).toBe("  I mean…");
    // Do not subtract a 30_000ms full-source IN point from cut-relative timestamps.
    expect(activeCaptionAt(imported, 4500)?.cue_id).toBe("cue-2");
    expect(activeCaptionAt(imported, 3100)).toBeNull();
    expect(activeCaptionAt(imported, 5300)).toBeNull();
  });

  it("prevents subtitle overlap and preserves the original list if a time change is invalid", () => {
    const source = captionsFromApprovedCues([
      cue("first", 1000, 1800, "First", "Primeira"),
      cue("second", 2500, 3500, "Second", "Segunda"),
    ]);
    expect(adjustCaptionTiming(source, "first", { start_ms: 1000, end_ms: 2600 }, 5000)).toBe(
      source,
    );
    expect(
      adjustCaptionTiming(source, "first", { start_ms: 1100, end_ms: 2000 }, 5000)[0],
    ).toMatchObject({
      start_ms: 1100,
      end_ms: 2000,
    });
    expect(adjustCaptionTiming(source, "first", { start_ms: 2000, end_ms: 1900 }, 5000)).toBe(
      source,
    );
  });

  it("provides readable mm:ss.t labels for the scrubber", () => {
    expect(durationLabel(0)).toBe("00:00.0");
    expect(durationLabel(62350)).toBe("01:02.3");
  });

  it("refuses to silently truncate an approved scene larger than the 200-caption contract", () => {
    const veryLongScene = Array.from({ length: 201 }, (_, i) =>
      cue(`cue-${i}`, i * 1000, i * 1000 + 800, "Line", "Fala"),
    );
    expect(() => captionsFromApprovedCues(veryLongScene)).toThrow(/201 falas/);
  });
});
