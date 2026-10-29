import { describe, expect, it } from "vitest";

import { handwritingProgress, lyricWords } from "./lyric-timing";

describe("progressive lyric cues", () => {
  it("keeps spaces and literal text while lighting up the current word", () => {
    const text = "I'll be there.  Sempre!";
    const start = lyricWords(text, 1000, 5000, 1000);
    expect(start.map((word) => word.text).join("")).toBe(text);
    expect(start.map((word) => word.state)).toEqual(["active", "upcoming", "upcoming", "upcoming"]);
    const middle = lyricWords(text, 1000, 5000, 3500);
    expect(middle.some((word) => word.state === "active")).toBe(true);
    expect(middle.some((word) => word.state === "done")).toBe(true);
    expect(lyricWords(text, 1000, 5000, 5000).every((word) => word.state === "done")).toBe(true);
  });

  it("supports empty captions and short Unicode words", () => {
    expect(lyricWords("", 0, 1000, 500)).toEqual([]);
    expect(
      lyricWords("Oi! ❤️", 0, 1000, 500)
        .map((item) => item.text)
        .join(""),
    ).toBe("Oi! ❤️");
  });
});


describe("handwritten subtitle reveal", () => {
  it("reveals progressively, clamps and reaches full text before the end", () => {
    expect(handwritingProgress(1000, 4000, 900)).toBe(0);
    expect(handwritingProgress(1000, 4000, 2200)).toBe(50);
    expect(handwritingProgress(1000, 4000, 3400)).toBe(100);
    expect(handwritingProgress(1000, 4000, 5000)).toBe(100);
  });
});
