import { describe, expect, it } from "vitest";
import { nudgeTiming, setTimingEdge, snapTime, validateTimeline } from "./timeline";

describe("timeline helpers", () => {
  it("snaps time and keeps timing valid", () => {
    expect(snapTime(112, 1000)).toBe(100);
    expect(nudgeTiming({ start_ms: 100, end_ms: 300 }, "start", 400, 1000)).toEqual({
      start_ms: 275,
      end_ms: 300,
    });
  });
  it("marks cue boundaries at the snapped playhead", () => {
    expect(setTimingEdge({ start_ms: 100, end_ms: 500 }, "start", 212, 1000)).toEqual({
      start_ms: 200,
      end_ms: 500,
    });
    expect(setTimingEdge({ start_ms: 100, end_ms: 500 }, "end", 463, 1000)).toEqual({
      start_ms: 100,
      end_ms: 475,
    });
  });
  it("reports word timing outside a cue", () => {
    expect(
      validateTimeline([
        {
          order: 1,
          speech_timing: { start_ms: 100, end_ms: 200 },
          words: [{ surface: "Hi", start_ms: 50, end_ms: 150 }],
        } as never,
      ]),
    ).toContain("Palavra “Hi”: fora do cue.");
  });
});
