import { describe, expect, it } from "vitest";

import { captionGaps, lastCaptionEnd } from "./caption-coverage";
import type { MediaCaption } from "./tiktok-api";

const cue = (start_ms: number, end_ms: number, enabled = true): MediaCaption => ({
  cue_id: `${start_ms}`,
  start_ms,
  end_ms,
  enabled,
  en: "Hello",
  pt: "Olá",
  highlight: "",
});

describe("caption export coverage", () => {
  it("reports audible windows without filling silences or changing text", () => {
    const captions = [cue(2000, 4000), cue(5000, 7000), cue(9000, 12000, false)];
    expect(captionGaps(captions, 15000)).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 4000, endMs: 5000 },
      { startMs: 7000, endMs: 15000 },
    ]);
    expect(lastCaptionEnd(captions)).toBe(7000);
    expect(captions[0].en).toBe("Hello");
  });

  it("ignores short breathing gaps, returns no gaps for unknown duration", () => {
    expect(captionGaps([cue(0, 1700), cue(2100, 3000)], 3300)).toEqual([]);
    expect(captionGaps([cue(0, 1000)], 0)).toEqual([]);
    expect(lastCaptionEnd([cue(0, 1200, false)])).toBe(0);
  });
});
