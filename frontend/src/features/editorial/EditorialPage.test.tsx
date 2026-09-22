import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { EditorialPage } from "./EditorialPage";

const mocks = vi.hoisted(() => ({
  updateCueText: vi.fn().mockResolvedValue({}),
  draftAsrCandidate: vi.fn().mockResolvedValue({ id: "s1" }),
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
    editorialScenes: vi
      .fn()
      .mockResolvedValue([{ id: "s1", project_id: "p1", order: 1, duration_ms: 2000 }]),
    editorialCues: mocks.editorialCues,
    draftAsrCandidate: mocks.draftAsrCandidate,
    updateCueText: mocks.updateCueText,
  },
}));

describe("EditorialPage", () => {
  it("loads an ASR draft and sends literal EN/PT approval", async () => {
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1&ingest_job=j1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("ASR original: “I can't… go?”")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Criar rascunho do ASR" }));
    await waitFor(() => expect(mocks.draftAsrCandidate).toHaveBeenCalledWith("p1", "j1", "editor"));
    fireEvent.change(screen.getByLabelText("Inglês aprovado"), {
      target: { value: "“I can't… go?”" },
    });
    fireEvent.change(screen.getByLabelText("Português aprovado"), {
      target: { value: "“Não posso… ir?”" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Aprovar texto" }));
    await waitFor(() =>
      expect(mocks.updateCueText).toHaveBeenCalledWith("c1", {
        author: "editor",
        approved_en: "“I can't… go?”",
        approved_pt: "“Não posso… ir?”",
      }),
    );
  });
});
