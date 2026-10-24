import { describe, expect, it } from "vitest";
import {
  adjacentWordDestination, nudgeTiming, remapWordsToCue, setTimingEdge, snapTime,
  validateTimeline,
} from "./timeline";

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
  it("recognizes the adjacent-cue gap as a transfer destination", () => {
    const cues = [
      { id: "left", speech_timing: { start_ms: 100, end_ms: 350 }, words: [
        { id: "a", start_ms: 100, end_ms: 250 },
      ] },
      { id: "right", speech_timing: { start_ms: 1100, end_ms: 2000 }, words: [
        { id: "b", start_ms: 1200, end_ms: 1400 },
        { id: "c", start_ms: 1500, end_ms: 1900 },
      ] },
    ] as unknown as Parameters<typeof adjacentWordDestination>[0];
    expect(adjacentWordDestination(cues, "right", "b", 400, 650)?.id).toBe("left");
    expect(adjacentWordDestination(cues, "right", "c", 400, 650)).toBeUndefined();
    expect(adjacentWordDestination(cues, "right", "b", 400, 1200)).toBeUndefined();
    expect(adjacentWordDestination(cues, "left", "a", 850, 1000)).toBeUndefined();
  });
  it("rescales word highlights when the parent cue is shortened from 20s to 30s", () => {
    const words = [
      { id: "1", order: 1, surface: "Hello", start_ms: 20000, end_ms: 24000 },
      { id: "2", order: 2, surface: "there", start_ms: 30000, end_ms: 34000 },
      { id: "3", order: 3, surface: "friend", start_ms: 36000, end_ms: 40000 },
    ];
    const moved = remapWordsToCue(
      words,
      { start_ms: 20000, end_ms: 40000 },
      { start_ms: 30000, end_ms: 40000 },
    );
    expect(moved.map(({ start_ms, end_ms }) => [start_ms, end_ms])).toEqual([
      [30000, 32000],
      [35000, 37000],
      [38000, 40000],
    ]);
    expect(words[0].start_ms).toBe(20000);
    expect(moved[1].id).toBe("2");
  });

  it("translates every child timing when the cue moves without resizing", () => {
    const words = [{ id: "1", order: 1, surface: "Hi", start_ms: 20050, end_ms: 20300, provenance: { word_timing_reviewed: true } }];
    const moved = remapWordsToCue(
      words,
      { start_ms: 20000, end_ms: 40000 },
      { start_ms: 30000, end_ms: 50000 },
    );
    expect(moved[0].start_ms).toBe(30050);
    expect(moved[0].end_ms).toBe(30300);
    expect(moved[0].provenance?.word_timing_reviewed).toBeUndefined();
  });

  it("refuses to squeeze more words into milliseconds than available", () => {
    const words = [
      { id: "1", order: 1, surface: "One", start_ms: 20000, end_ms: 20300 },
      { id: "2", order: 2, surface: "Two", start_ms: 20400, end_ms: 20600 },
      { id: "3", order: 3, surface: "Three", start_ms: 20700, end_ms: 20900 },
    ];
    expect(() =>
      remapWordsToCue(
        words,
        { start_ms: 20000, end_ms: 40000 },
        { start_ms: 30000, end_ms: 30002 },
      ),
    ).toThrow(/muito curta/);
  });

});
