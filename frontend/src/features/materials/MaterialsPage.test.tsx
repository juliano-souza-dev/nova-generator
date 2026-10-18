import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../../lib/studio-api";
import { MaterialsPage } from "./MaterialsPage";

vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    projects: vi.fn(),
    externalMaterialsReview: vi.fn(),
    externalMaterialsPackageUrl: vi.fn(),
    importExternalMaterials: vi.fn(),
    approveExternalMaterials: vi.fn(),
    voices: vi.fn(),
    materials: vi.fn(),
    updateMaterial: vi.fn(),
    prepareMaterialAudio: vi.fn(),
    job: vi.fn(),
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
  editorial_ready: true,
  highlights: [{ en: "Can I help?", pt: "Posso ajudar?", kind: "unidade semântica" }],
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
  beforeEach(() => vi.resetAllMocks());

  it("shows sending, queue and worker status without silently ignoring Prepare WAV", async () => {
    vi.mocked(studioApi.projects).mockResolvedValue([
      { id: "project-1", title: "Lesson" } as never,
    ]);
    vi.mocked(studioApi.voices).mockResolvedValue([
      { id: "voice-1", name: "Ana", version: 2 } as never,
    ]);
    vi.mocked(studioApi.materials).mockResolvedValue({
      cards: [{ ...card, audio_ready: false, audio_url: null }],
      voice_id: "voice-1",
      voice_version: 2,
    });
    vi.mocked(studioApi.externalMaterialsReview).mockResolvedValue({
      status: "pending",
      source_sha256: "",
      document: null,
    });
    vi.mocked(studioApi.externalMaterialsPackageUrl).mockReturnValue("/ai-package.json");
    vi.mocked(studioApi.latestMaterialExport).mockRejectedValue({ status: 404 });
    let acceptRequest!: (job: Awaited<ReturnType<typeof studioApi.prepareMaterialAudio>>) => void;
    vi.mocked(studioApi.prepareMaterialAudio).mockImplementation(
      () => new Promise((resolve) => { acceptRequest = resolve; }),
    );
    vi.mocked(studioApi.job).mockResolvedValue({
      id: "audio-job-1",
      status: "queued",
    } as never);
    mount();

    const prepare = await screen.findByRole("button", { name: "Preparar WAV" });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    expect(screen.getByRole("button", { name: "Enviando…" })).toBeDisabled();
    expect(screen.getByText(/Enviando solicitação de áudio ao worker/)).toBeInTheDocument();
    acceptRequest({ id: "audio-job-1", status: "queued" } as never);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Na fila" })).toBeDisabled(),
    );
    expect(await screen.findByText("Tarefa recebida. Aguardando o worker.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver monitor de jobs" })).toHaveAttribute(
      "href", "/jobs",
    );
  });

  it("shows API rejection next to the affected WAV button and allows retry", async () => {
    vi.mocked(studioApi.projects).mockResolvedValue([
      { id: "project-1", title: "Lesson" } as never,
    ]);
    vi.mocked(studioApi.voices).mockResolvedValue([
      { id: "voice-1", name: "Ana", version: 2 } as never,
    ]);
    vi.mocked(studioApi.materials).mockResolvedValue({
      cards: [{ ...card, audio_ready: false, audio_url: null }],
      voice_id: "voice-1",
      voice_version: 2,
    });
    vi.mocked(studioApi.externalMaterialsReview).mockResolvedValue({
      status: "pending", source_sha256: "", document: null,
    });
    vi.mocked(studioApi.externalMaterialsPackageUrl).mockReturnValue("/ai-package.json");
    vi.mocked(studioApi.latestMaterialExport).mockRejectedValue({ status: 404 });
    vi.mocked(studioApi.prepareMaterialAudio).mockRejectedValue(
      new Error("Worker de voz indisponível"),
    );
    mount();

    const prepare = await screen.findByRole("button", { name: "Preparar WAV" });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    expect(
      await screen.findByText(/Não foi possível iniciar a síntese: Worker de voz indisponível/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preparar WAV" })).toBeEnabled();
  });

  it("enqueues each selected WAV individually and prevents duplicate submissions", async () => {
    vi.mocked(studioApi.projects).mockResolvedValue([
      { id: "project-1", title: "Lesson" } as never,
    ]);
    vi.mocked(studioApi.voices).mockResolvedValue([
      { id: "voice-1", name: "Ana", version: 2 } as never,
    ]);
    vi.mocked(studioApi.materials).mockResolvedValue({
      cards: [
        { ...card, audio_ready: false, audio_url: null },
        { ...card, cue_id: "cue-2", cue_order: 2, approved_en: "Hello.", audio_ready: false, audio_url: null },
      ],
      voice_id: "voice-1",
      voice_version: 2,
    });
    vi.mocked(studioApi.externalMaterialsReview).mockResolvedValue({
      status: "pending", source_sha256: "", document: null,
    });
    vi.mocked(studioApi.externalMaterialsPackageUrl).mockReturnValue("/ai-package.json");
    vi.mocked(studioApi.latestMaterialExport).mockRejectedValue({ status: 404 });
    vi.mocked(studioApi.prepareMaterialAudio).mockImplementation(async (_project, cueId) => ({
      id: `job-${cueId}`, status: "queued",
    }) as never);
    vi.mocked(studioApi.job).mockImplementation(async (jobId) => ({
      id: jobId, status: "queued",
    }) as never);
    mount();
    const prepare = await screen.findByRole("button", { name: "Preparar selecionados" });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    await waitFor(() => expect(studioApi.prepareMaterialAudio).toHaveBeenCalledTimes(2));
    expect(studioApi.prepareMaterialAudio).toHaveBeenCalledWith("project-1", "cue-1", "voice-1");
    expect(studioApi.prepareMaterialAudio).toHaveBeenCalledWith("project-1", "cue-2", "voice-1");
    await waitFor(() => expect(prepare).toBeDisabled());
    expect(await screen.findAllByRole("button", { name: "Na fila" })).toHaveLength(2);
  });

  it("blocks Anki synthesis for a legacy voice with a short reference", async () => {
    vi.mocked(studioApi.projects).mockResolvedValue([
      { id: "project-1", title: "Lesson" } as never,
    ]);
    vi.mocked(studioApi.voices).mockResolvedValue([
      {
        id: "voice-1",
        name: "Juliana",
        version: 3,
        reference_ready: false,
        reference_message: "A referência desta voz precisa ter pelo menos 6 segundos.",
      } as never,
    ]);
    vi.mocked(studioApi.externalMaterialsReview).mockResolvedValue({
      status: "pending",
      source_sha256: "",
      document: null,
    });
    vi.mocked(studioApi.externalMaterialsPackageUrl).mockReturnValue("/ai-package.json");
    vi.mocked(studioApi.materials).mockResolvedValue({
      cards: [{ ...card, audio_ready: false, audio_url: null }],
      voice_id: "voice-1",
      voice_version: 3,
    });
    vi.mocked(studioApi.latestMaterialExport).mockRejectedValue({ status: 404 });
    vi.mocked(studioApi.prepareMaterialAudio).mockClear();
    mount();

    expect(
      await screen.findByText(/A referência desta voz precisa ter pelo menos 6 segundos/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Atualizar voz na Biblioteca" })).toHaveAttribute(
      "href",
      "/voices",
    );
    expect(screen.getByRole("button", { name: "Preparar WAV" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preparar selecionados" })).toBeDisabled();
    expect(studioApi.prepareMaterialAudio).not.toHaveBeenCalled();
  });

  it("prepares WAV for approved cards without external pedagogical material", async () => {
    vi.mocked(studioApi.projects).mockResolvedValue([
      { id: "project-1", title: "Lesson" } as never,
    ]);
    vi.mocked(studioApi.voices).mockResolvedValue([
      { id: "voice-1", name: "Ana", version: 2 } as never,
    ]);
    vi.mocked(studioApi.externalMaterialsReview).mockResolvedValue({
      status: "pending",
      source_sha256: "",
      document: null,
    });
    vi.mocked(studioApi.externalMaterialsPackageUrl).mockReturnValue("/ai-package.json");
    vi.mocked(studioApi.materials).mockResolvedValue({
      cards: [
        { ...card, audio_ready: false, audio_url: null, reel_start_ms: null, reel_end_ms: null },
      ],
      voice_id: "voice-1",
      voice_version: 2,
    });
    vi.mocked(studioApi.latestMaterialExport).mockRejectedValue({ status: 404 });
    vi.mocked(studioApi.prepareMaterialAudio).mockResolvedValue({
      id: "audio-job-1",
      status: "queued",
    });
    mount();

    const prepare = await screen.findByRole("button", { name: "Preparar WAV" });
    await waitFor(() => expect(prepare).toBeEnabled());
    expect(screen.getByRole("button", { name: "Preparar selecionados" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Exportar APKG" })).toBeDisabled();
    fireEvent.click(prepare);
    await waitFor(() =>
      expect(studioApi.prepareMaterialAudio).toHaveBeenCalledWith("project-1", "cue-1", "voice-1"),
    );
  });

  it("exports prepared Anki cards without an approved external pedagogical JSON", async () => {
    vi.mocked(studioApi.projects).mockResolvedValue([
      { id: "project-1", title: "Lesson" } as never,
    ]);
    vi.mocked(studioApi.voices).mockResolvedValue([
      { id: "voice-1", name: "Ana", version: 2 } as never,
    ]);
    vi.mocked(studioApi.externalMaterialsReview).mockResolvedValue({
      status: "pending",
      source_sha256: "",
      document: null,
    });
    vi.mocked(studioApi.externalMaterialsPackageUrl).mockReturnValue("/ai-package.json");
    vi.mocked(studioApi.materials).mockResolvedValue({
      cards: [card],
      voice_id: "voice-1",
      voice_version: 2,
    });
    vi.mocked(studioApi.latestMaterialExport).mockRejectedValue({ status: 404 });
    vi.mocked(studioApi.exportMaterials).mockResolvedValue({
      job_id: "job-1",
      status: "queued",
      apkg_url: null,
      manifest_url: null,
      reel_url: null,
    });
    mount();
    await screen.findByText("Café?");
    const exportButton = screen.getByRole("button", { name: "Exportar APKG" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await waitFor(() =>
      expect(studioApi.exportMaterials).toHaveBeenCalledWith("project-1", "voice-1"),
    );
  });

  it("still blocks audio when a card is not editorially prepared", async () => {
    vi.mocked(studioApi.projects).mockResolvedValue([
      { id: "project-1", title: "Lesson" } as never,
    ]);
    vi.mocked(studioApi.voices).mockResolvedValue([
      { id: "voice-1", name: "Ana", version: 2 } as never,
    ]);
    vi.mocked(studioApi.externalMaterialsReview).mockResolvedValue({
      status: "approved",
      source_sha256: "a".repeat(64),
      document: null,
    });
    vi.mocked(studioApi.externalMaterialsPackageUrl).mockReturnValue("/ai-package.json");
    vi.mocked(studioApi.materials).mockResolvedValue({
      cards: [{ ...card, editorial_ready: false, audio_ready: false, audio_url: null }],
      voice_id: "voice-1",
      voice_version: 2,
    });
    vi.mocked(studioApi.latestMaterialExport).mockRejectedValue({ status: 404 });
    mount();
    expect(
      await screen.findByText(/A preparação editorial ainda não está completa/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preparar WAV" })).not.toBeInTheDocument();
  });

  it("shows literal approved text, canonical preview, reel interval and submits selection", async () => {
    vi.mocked(studioApi.externalMaterialsReview).mockResolvedValue({
      status: "approved",
      source_sha256: "a".repeat(64),
      document: null,
    });
    vi.mocked(studioApi.externalMaterialsPackageUrl).mockReturnValue("/ai-package.json");
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
    expect(screen.getByText("Can I help?")).toBeInTheDocument();
    expect(screen.getByText("Posso ajudar?")).toBeInTheDocument();
    expect(screen.getByLabelText("Áudio do card 1.1")).toHaveAttribute("src", card.audio_url);
    expect(screen.getByText("0.00 s–0.60 s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver como no iHub" }));
    expect(screen.getByRole("dialog", { name: "Prévia do card no iHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show answer" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar prévia" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
