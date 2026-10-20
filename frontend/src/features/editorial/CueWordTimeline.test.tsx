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
        onPlayContext={vi.fn()}
        onPreviousWord={vi.fn()}
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
  it("shows an uncluttered word-sync workflow while preserving cue and word timings", () => {
    const mark = vi.fn();
    const context = vi.fn();
    const advance = vi.fn();
    const word = { ...cue.words[0], start_ms: 1150, end_ms: 1550 };
    render(
      <CueWordTimeline
        cues={[{ ...cue, words: [word] }]}
        durationMs={10000}
        playheadMs={1210}
        playing={false}
        zoom={4}
        selectedCueId="cue-1"
        selectedWordId="word-1"
        onPlayToggle={vi.fn()}
        onPlayContext={context}
        onPreviousWord={vi.fn()}
        onContinuousPlayToggle={vi.fn()}
        onSaveAndNext={advance}
        onPlayheadChange={vi.fn()}
        onZoomChange={vi.fn()}
        onSelectCue={vi.fn()}
        onSelectWord={vi.fn()}
        onSetEdge={mark}
        onEdgeDragStart={vi.fn()}
        onEdgeChange={vi.fn()}
        onNudge={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    const guide = screen.getByLabelText("Sincronização da palavra selecionada");
    expect(within(guide).getByText("Hello")).toBeInTheDocument();
    expect(within(guide).getByText("1.15 s")).toBeInTheDocument();
    expect(within(guide).getByText("1.55 s")).toBeInTheDocument();
    fireEvent.click(within(guide).getByRole("button", { name: "Ouvir com contexto" }));
    fireEvent.click(within(guide).getByRole("button", { name: /Marcar início/ }));
    fireEvent.click(within(guide).getByRole("button", { name: /Marcar fim/ }));
    fireEvent.click(within(guide).getByRole("button", { name: /Salvar e próxima/ }));
    expect(context).toHaveBeenCalledOnce();
    expect(mark).toHaveBeenNthCalledWith(1, "start");
    expect(mark).toHaveBeenNthCalledWith(2, "end");
    expect(advance).toHaveBeenCalledOnce();
    expect(screen.getByText("Zoom, ajuste em milissegundos e outros controles"))
      .toBeInTheDocument();
    expect(screen.getByLabelText("Ajustes precisos da palavra").closest("details"))
      .not.toHaveAttribute("open");
  });

});
