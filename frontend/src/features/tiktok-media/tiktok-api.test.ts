import { describe, expect, it } from "vitest";

import { readExternalStoryboard } from "./tiktok-api";

describe("TikTok Media external AI draft", () => {
  it("keeps bilingual text literal and marks a fresh slide", () => {
    const slides = readExternalStoryboard(
      JSON.stringify({
        slides: [
          {
            kind: "lesson",
            heading: "Contexto",
            en: "While you're at it",
            pt: "Já que você está nisso",
            duration_ms: 5000,
          },
        ],
      }),
    );
    expect(slides).toHaveLength(1);
    expect(slides[0].en).toBe("While you're at it");
    expect(slides[0].pt).toBe("Já que você está nisso");
    expect(slides[0].id).toBeTruthy();
  });

  it("blocks invalid durations and unsupported structures", () => {
    expect(() => readExternalStoryboard('{"slides":[{"duration_ms":999}]}')).toThrow();
    expect(() => readExternalStoryboard('{"slides":[]}')).toThrow();
    expect(() => readExternalStoryboard('{"foo":"bar"}')).toThrow();
  });
});
