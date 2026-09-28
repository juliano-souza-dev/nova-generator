import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CueWordTimeline, type TimelineCue } from "./CueWordTimeline";

const cue: TimelineCue = {
  id: "cue-1",
  scene_id: "scene-1",
  order: 1,
  speaker: "",
  original_en: "Hello",
  approved_en: "Hello",
  approved_pt: "Olá",
  speech_timing: { start_ms: 1000, end_ms: 3000 },
  subtitle_timing: { start_ms: 1000, end_ms: 3000 },
  revision: 1,
  provenance: { source: "asr_candidate", approval: "draft", editorial_preparation: "complete" },
  words: [{ id: "word-1", order: 1, surface: "Hello", start_ms: 1000, end_ms: 3000 }],
};

describe("CueWordTimeline", () => {
  it("pans the visible audio window with the mouse wheel over the waveform", () => {
    render(
      <CueWordTimeline
        cues={[cue]}
        waveform={{ bucket_ms: 40, peaks: [0.2, 0.8] }}
        durationMs={10000}
        playheadMs={1000}
        playing={false}
        zoom={2}
        selectedCueId="cue-1"
        onPlayToggle={vi.fn()}
        onContinuousPlayToggle={vi.fn()}
        onSaveAndNext={vi.fn()}
        onPlayheadChange={vi.fn()}
        onZoomChange={vi.fn()}
        onSelectCue={vi.fn()}
        onSelectWord={vi.fn()}
        onSetEdge={vi.fn()}
        onEdgeDragStart={vi.fn()}
        onEdgeChange={vi.fn()}
        onNudge={vi.fn()}
        onUndo={vi.fn()}
      />,
    );

    const ruler = screen.getByLabelText("Intervalo visível");
    expect(within(ruler).getByText("0.00 s")).toBeInTheDocument();
    const wheelWasNotAllowedToScroll = fireEvent.wheel(
      screen.getByRole("img", { name: "Waveform, cues e tempos das palavras" }),
      { deltaY: 100 },
    );
    expect(wheelWasNotAllowedToScroll).toBe(false);
    expect(within(ruler).getByText("0.50 s")).toBeInTheDocument();
  });
});
