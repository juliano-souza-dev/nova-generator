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

  it("keeps visible separation between timed words", () => {
    render(
      <EditorialHubPreview
        mediaUrl="/cut.mp4"
        cues={[cue]}
        initialTimeMs={100}
        onClose={vi.fn()}
        onEditCue={vi.fn()}
      />,
    );
    const timedWords = document.querySelectorAll(".hub-preview-en span");
    expect(timedWords).toHaveLength(3);
    expect(getComputedStyle(timedWords[0]).marginRight).not.toBe("0px");
  });

  it("waits for the requested cue seek before starting playback", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const nextCue: TimelineCue = {
      ...cue, id: "c2", order: 2,
      speech_timing: { start_ms: 1900, end_ms: 2300 },
      subtitle_timing: { start_ms: 1900, end_ms: 2300 },
      words: [{ id: "w4", order: 1, surface: "Later", start_ms: 1900, end_ms: 2300, pt: "Depois" }],
    };
    render(
      <EditorialHubPreview
        mediaUrl="/cut.mp4"
        cues={[cue, nextCue]}
        initialTimeMs={1900}
        onClose={vi.fn()}
        onEditCue={vi.fn()}
      />,
    );
    const video = screen.getByLabelText("Prévia do vídeo no iHub") as HTMLVideoElement;
    let readyState = HTMLMediaElement.HAVE_NOTHING;
    Object.defineProperty(video, "readyState", { configurable: true, get: () => readyState });
    expect(video.currentTime).toBe(1.9);
    expect(play).not.toHaveBeenCalled();

    // Browsers may reset a pre-metadata seek to zero as the media initializes.
    video.currentTime = 0;
    readyState = HTMLMediaElement.HAVE_METADATA;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(1.9);
    expect(play).not.toHaveBeenCalled();

    readyState = HTMLMediaElement.HAVE_ENOUGH_DATA;
    fireEvent.seeked(video);
    expect(play).toHaveBeenCalledOnce();
    expect(video.currentTime).toBe(1.9);
    expect(screen.getByRole("button", { name: "Editar cue" })).toBeEnabled();
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
        onEditCue={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dual" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".hub-preview-pt")).toHaveTextContent("“Posso ajudar?”");
    fireEvent.click(screen.getByRole("button", { name: "PT" }));
    expect(screen.getByRole("button", { name: "PT" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByRole("button", { name: "EN" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("edits the cue playing now, including after seeking to another cue", () => {
    const onEditCue = vi.fn();
    const nextCue: TimelineCue = {
      ...cue,
      id: "c2",
      order: 2,
      approved_en: "Next cue!",
      speech_timing: { start_ms: 1200, end_ms: 1900 },
      subtitle_timing: { start_ms: 1200, end_ms: 1900 },
      words: [{ id: "w4", order: 1, surface: "Next cue!", start_ms: 1200, end_ms: 1900, pt: "Próxima cue!" }],
    };
    render(
      <EditorialHubPreview
        mediaUrl="/cut.mp4"
        cues={[cue, nextCue]}
        initialTimeMs={100}
        onClose={vi.fn()}
        onEditCue={onEditCue}
      />,
    );

    const edit = screen.getByRole("button", { name: "Editar cue" });
    expect(edit).toBeEnabled();
    fireEvent.click(edit);
    expect(onEditCue).toHaveBeenCalledWith("c1");

    const video = screen.getByLabelText("Prévia do vídeo no iHub") as HTMLVideoElement;
    video.currentTime = 1.5;
    fireEvent.timeUpdate(video);
    fireEvent.click(edit);
    expect(onEditCue).toHaveBeenLastCalledWith("c2");

    video.currentTime = 1.05;
    fireEvent.timeUpdate(video);
    expect(edit).toBeDisabled();
  });
});
