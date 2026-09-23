import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { EditorialPage } from "./EditorialPage";

const mocks = vi.hoisted(() => ({
  updateCueText: vi.fn().mockResolvedValue({}),
  updateCueTiming: vi.fn().mockResolvedValue({}),
  updateWordTiming: vi.fn().mockResolvedValue({}),
  editorialCues: vi.fn().mockResolvedValue([
    {
      id: "c1",
      scene_id: "s1",
      order: 1,
      speaker: "",
      original_en: "“I can't… go?”",
      approved_en: "",
      approved_pt: "",
      speech_timing: { start_ms: 100, end_ms: 1800 },
      subtitle_timing: { start_ms: 100, end_ms: 1800 },
      revision: 1,
      provenance: { source: "asr_candidate", approval: "draft" },
      words: [{ id: "w1", order: 1, surface: "can't…", start_ms: 100, end_ms: 1800 }],
    },
  ]),
}));
vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    projects: vi.fn().mockResolvedValue([{ id: "p1", title: "Projeto" }]),
    projectMedia: vi.fn().mockResolvedValue({
      ingest_job_id: "j1",
      cut_url: "/api/cut.wav",
      waveform: { sample_rate_hz: 8000, bucket_ms: 40, peaks: [0.3, 0.8] },
    }),
    openEditorialReview: vi.fn().mockResolvedValue({
      status: "ready",
      ingest_job_id: "j1",
      cut_url: "/api/cut.wav",
      scene: {
        id: "s1",
        project_id: "p1",
        order: 1,
        duration_ms: 2000,
        provenance: { ingest_job_id: "j1" },
      },
    }),
    editorialCues: mocks.editorialCues,
    updateCueText: mocks.updateCueText,
    updateCueTiming: mocks.updateCueTiming,
    updateWordTiming: mocks.updateWordTiming,
  },
}));

describe("EditorialPage", () => {
  it("presents a focused workstation and sends literal EN/PT approval", async () => {
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1&ingest_job=j1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("“I can't… go?”")).toBeInTheDocument();
    expect(screen.queryByText("Demonstração da timeline")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("ID do job ASR concluído")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Player do corte da cena")).toHaveAttribute("src", "/api/cut.wav");
    expect(document.querySelectorAll(".wave-bar")).toHaveLength(160);
    fireEvent.change(screen.getByLabelText("Inglês aprovado"), {
      target: { value: "“I can't… go?”" },
    });
    fireEvent.change(screen.getByLabelText("Português aprovado"), {
      target: { value: "“Não posso… ir?”" },
    });
    expect(screen.getByText("Alterações não salvas")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Aprovar cue" }));
    await waitFor(() =>
      expect(mocks.updateCueText).toHaveBeenCalledWith("c1", {
        author: "local-editor",
        approved_en: "“I can't… go?”",
        approved_pt: "“Não posso… ir?”",
      }),
    );
  });

  it("supports cue navigation, problem state and an accessible word inspector", async () => {
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Selecione uma palavra" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /can't…/ }));
    expect(screen.getByRole("heading", { name: "Palavra “can't…”" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Marcar problema" }));
    expect(screen.getAllByText("Problema marcado")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Cue anterior" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Próximo cue" })).toBeDisabled();
  });
});
