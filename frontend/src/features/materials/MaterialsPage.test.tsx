import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { studioApi } from "../../lib/studio-api";
import { MaterialsPage } from "./MaterialsPage";

vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    projects: vi.fn(),
    voices: vi.fn(),
    materials: vi.fn(),
    updateMaterial: vi.fn(),
    prepareMaterialAudio: vi.fn(),
    exportMaterials: vi.fn(),
    materialExport: vi.fn(),
    latestMaterialExport: vi.fn(),
    publishMaterialExport: vi.fn(),
  },
}));

const card = {
  cue_id: "cue-1",
  scene_order: 1,
  cue_order: 1,
  approved_en: "Café?",
  approved_pt: "Café.",
  tags: ["lesson"],
  included: true,
  speaker: "Ana",
  speech_start_ms: 100,
  speech_end_ms: 700,
  reel_start_ms: 0,
  reel_end_ms: 600,
  audio_ready: true,
  audio_url: "/api/projects/project-1/materials/cue-1/audio?voice_id=voice-1&voice_version=2",
  audio_error: null,
};

function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <MaterialsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MaterialsPage", () => {
  it("shows literal approved text, canonical preview, reel interval and submits selection", async () => {
    vi.mocked(studioApi.projects).mockResolvedValue([
      { id: "project-1", title: "Lesson" } as never,
    ]);
    vi.mocked(studioApi.voices).mockResolvedValue([
      { id: "voice-1", name: "Ana", version: 2 } as never,
    ]);
    vi.mocked(studioApi.materials).mockResolvedValue({
      cards: [card],
      voice_id: "voice-1",
      voice_version: 2,
    });
    vi.mocked(studioApi.updateMaterial).mockResolvedValue({ ...card, included: false });
    vi.mocked(studioApi.exportMaterials).mockResolvedValue({
      job_id: "job-1",
      status: "queued",
      apkg_url: null,
      manifest_url: null,
      reel_url: null,
    });
    vi.mocked(studioApi.materialExport).mockResolvedValue({
      job_id: "job-1",
      status: "succeeded",
      apkg_url: "/anki.apkg",
      manifest_url: "/manifest.json",
      reel_url: "/reel.mp4",
    });
    vi.mocked(studioApi.latestMaterialExport).mockRejectedValue({ status: 404 });
    vi.mocked(studioApi.publishMaterialExport).mockResolvedValue({
      youtube_video_id: "bbbbbbbbbbb",
      youtube_url: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
      hub_final_url: "/hub_final.json",
    });
    mount();
    expect(await screen.findByText("Café?")).toBeInTheDocument();
    expect(screen.getByLabelText("Áudio do card 1.1")).toHaveAttribute("src", card.audio_url);
    expect(screen.getByText("0.00 s–0.60 s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Incluir card 1.1" }));
    await waitFor(() =>
      expect(studioApi.updateMaterial).toHaveBeenCalledWith("project-1", "cue-1", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Exportar APKG" }));
    await waitFor(() =>
      expect(studioApi.exportMaterials).toHaveBeenCalledWith("project-1", "voice-1"),
    );
    expect(await screen.findByRole("link", { name: "Baixar APKG" })).toHaveAttribute(
      "href",
      "/anki.apkg",
    );
    fireEvent.change(screen.getByLabelText("URL ou ID do reel no YouTube"), {
      target: { value: "bbbbbbbbbbb" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirmo que fiz o upload/ }));
    fireEvent.click(screen.getByRole("button", { name: "Gerar hub_final.json" }));
    await waitFor(() =>
      expect(studioApi.publishMaterialExport).toHaveBeenCalledWith(
        "project-1",
        "job-1",
        "bbbbbbbbbbb",
      ),
    );
  });
});
