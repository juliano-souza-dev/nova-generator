import { describe, expect, it } from "vitest";

import { lyricWords } from "./lyric-timing";

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
