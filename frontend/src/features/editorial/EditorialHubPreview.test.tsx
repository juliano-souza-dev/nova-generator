import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineCue } from "./CueWordTimeline";
import { EditorialHubPreview } from "./EditorialHubPreview";
import { activePreviewCue, cuePreviewBounds, timedLiteralPieces } from "./hub-preview-timeline";

const cue: TimelineCue = {
  id: "c1",
  scene_id: "s1",
  order: 1,
  speaker: "Mike",
  original_en: "Can I help?",
  approved_en: "“Can I help?”",
  approved_pt: "“Posso ajudar?”",
  speech_timing: { start_ms: 80, end_ms: 950 },
  subtitle_timing: { start_ms: 80, end_ms: 950 },
  revision: 1,
  words: [
    { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 250, pt: null },
    { id: "w2", order: 2, surface: "I", start_ms: 300, end_ms: 380, pt: null },
    { id: "w3", order: 3, surface: "help?", start_ms: 420, end_ms: 800, pt: null },
  ],
};

describe("EditorialHubPreview", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  it("preserves literal punctuation while attaching timings to matching words", () => {
    const pieces = timedLiteralPieces(cue.approved_en, cue.words);
    expect(pieces.map((piece) => piece.text).join("")).toBe("“Can I help?”");
    expect(pieces.filter((piece) => piece.startMs !== undefined)).toHaveLength(3);
  });

  it("uses reviewed word bounds and leaves real gaps outside any active word", () => {
    expect(cuePreviewBounds(cue)).toEqual({ startMs: 100, endMs: 800 });
    expect(activePreviewCue([cue], 99)).toBeUndefined();
    expect(activePreviewCue([cue], 275)?.id).toBe("c1");
    const pieces = timedLiteralPieces(cue.approved_en, cue.words);
    expect(
      pieces.some(
        (piece) => piece.startMs !== undefined && 275 >= piece.startMs && 275 < (piece.endMs ?? 0),
      ),
    ).toBe(false);
  });

  it("switches between PT, EN and Dual and closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <EditorialHubPreview
        mediaUrl="/cut.mp4"
        cues={[cue]}
        initialTimeMs={100}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dual" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "PT" }));
    expect(screen.getByRole("button", { name: "PT" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByRole("button", { name: "EN" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
