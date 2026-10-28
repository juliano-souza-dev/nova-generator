import { describe, expect, it } from "vitest";

import {
  buildMusicLesson,
  MUSIC_LESSON_EXAMPLE,
  musicLessonAiPrompt,
  musicLessonDuration,
  parseMusicClock,
} from "./music-lesson";

describe("TikTokMedia English with Music", () => {
  it("parses minute:second markers and rejects impossible timestamps", () => {
    expect(parseMusicClock("00:15")).toBe(15);
    expect(parseMusicClock("01:10")).toBe(70);
    expect(parseMusicClock("03:60")).toBeNull();
    expect(parseMusicClock("not a time")).toBeNull();
  });

  it("creates a seven-frame, exactly 55-second lesson for Count on Me", () => {
    const slides = buildMusicLesson(MUSIC_LESSON_EXAMPLE);
    expect(slides).toHaveLength(7);
    expect(slides.reduce((total, slide) => total + slide.duration_ms, 0)).toBe(55_000);
    expect(slides.map((slide) => slide.duration_ms)).toEqual([
      6000, 7000, 8000, 8000, 10000, 10000, 6000,
    ]);
    expect(slides.map((slide) => slide.kind)).toEqual([
      "cover",
      "lyric",
      "lesson",
      "lesson",
      "example",
      "example",
      "challenge",
    ]);
    expect(slides[4].en).toBe("If you need help, I'll help you.");
    expect(slides[5].pt).toBe("Se a entrega atrasar, vou te ligar.");
    expect(slides[6].en).toBe("If it rains, I'll stay home.");
    expect(slides[6].pt).toContain("Como você diria");
    expect(new Set(slides.map((slide) => slide.id)).size).toBe(7);
  });

  it.each([30, 45, 60])("keeps %i-second cuts exact and all frames renderable", (seconds) => {
    const input = {
      ...MUSIC_LESSON_EXAMPLE,
      start: "00:00",
      end: `00:${String(seconds).padStart(2, "0")}`,
    };
    if (seconds === 60) input.end = "01:00";
    expect(musicLessonDuration(input)).toBe(seconds);
    const slides = buildMusicLesson(input);
    expect(slides.reduce((sum, slide) => sum + slide.duration_ms, 0)).toBe(seconds * 1000);
    expect(slides.every((slide) => slide.duration_ms >= 1000 && slide.duration_ms <= 20000)).toBe(
      true,
    );
  });

  it("rejects invalid lengths, reversed markers, and empty editorial content", () => {
    expect(() => buildMusicLesson({ ...MUSIC_LESSON_EXAMPLE, end: "00:25" })).toThrow(/30 e 60/);
    expect(() => buildMusicLesson({ ...MUSIC_LESSON_EXAMPLE, end: "00:10" })).toThrow(/30 e 60/);
    expect(() => buildMusicLesson({ ...MUSIC_LESSON_EXAMPLE, end: "01:16" })).toThrow(/30 e 60/);
    expect(() => buildMusicLesson({ ...MUSIC_LESSON_EXAMPLE, expression: "" })).toThrow(
      /expression/,
    );
  });

  it("prepares a reviewable AI request without fetching song lyrics", () => {
    const prompt = musicLessonAiPrompt(MUSIC_LESSON_EXAMPLE);
    expect(prompt).toContain("55 segundos");
    expect(prompt).toContain("Count on Me");
    expect(prompt).toContain("Não invente nem reproduza letra protegida");
  });
});
