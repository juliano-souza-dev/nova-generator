import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorialPage } from "./EditorialPage";

const mocks = vi.hoisted(() => ({
  projectMedia: vi.fn().mockResolvedValue({
    state: "ready_for_review",
    can_review: true,
    ingest_job_id: "j1",
    cut_url: "/api/cut.wav",
    waveform: { sample_rate_hz: 8000, bucket_ms: 40, peaks: [0.3, 0.8] },
  }),
  startProjectMedia: vi.fn().mockResolvedValue({ state: "source_processing", can_review: false }),
  updateCueText: vi.fn().mockResolvedValue({}),
  updateCueTiming: vi.fn().mockResolvedValue({}),
  updateWordTiming: vi.fn().mockResolvedValue({}),
  updateWordTranslation: vi.fn().mockResolvedValue({}),
  groupWordTranslation: vi.fn().mockResolvedValue({}),
  ungroupWordTranslation: vi.fn().mockResolvedValue({}),
  replaceSemanticUnits: vi.fn().mockResolvedValue({}),
  realignCue: vi.fn().mockResolvedValue({}),
  editorialAssistantStatus: vi.fn().mockResolvedValue({
    groq_configured: false,
    groq_model: "openai/gpt-oss-20b",
    fallback_available: true,
  }),
  externalEditorialPackageUrl: vi.fn().mockReturnValue("/api/external.zip"),
  startEditorialAssistance: vi.fn(),
  importExternalEditorialResult: vi.fn(),
  job: vi.fn(),
  editorialCues: vi.fn().mockResolvedValue([
    {
      id: "c1",
      scene_id: "s1",
      order: 1,
      speaker: "",
      original_en: "“I can't… go?”",
      approved_en: "“I can't… go?”",
      approved_pt: "“Eu não consigo… ir?”",
      speech_timing: { start_ms: 100, end_ms: 1800 },
      subtitle_timing: { start_ms: 100, end_ms: 1800 },
      revision: 1,
      provenance: {
        source: "asr_candidate",
        approval: "draft",
        editorial_preparation: "complete",
      },
      words: [
        { id: "w1", order: 1, surface: "can't…", start_ms: 100, end_ms: 1800, pt: "não consigo" },
      ],
    },
  ]),
}));
vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    projects: vi.fn().mockResolvedValue([{ id: "p1", title: "Projeto" }]),
    projectMedia: mocks.projectMedia,
    startProjectMedia: mocks.startProjectMedia,
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
    updateWordTranslation: mocks.updateWordTranslation,
    groupWordTranslation: mocks.groupWordTranslation,
    ungroupWordTranslation: mocks.ungroupWordTranslation,
    replaceSemanticUnits: mocks.replaceSemanticUnits,
    realignCue: mocks.realignCue,
    editorialAssistantStatus: mocks.editorialAssistantStatus,
    externalEditorialPackageUrl: mocks.externalEditorialPackageUrl,
    startEditorialAssistance: mocks.startEditorialAssistance,
    importExternalEditorialResult: mocks.importExternalEditorialResult,
    job: mocks.job,
  },
}));

describe("EditorialPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectMedia.mockResolvedValue({
      state: "ready_for_review",
      can_review: true,
      ingest_job_id: "j1",
      cut_url: "/api/cut.wav",
      waveform: { sample_rate_hz: 8000, bucket_ms: 40, peaks: [0.3, 0.8] },
    });
    mocks.editorialCues.mockResolvedValue([
      {
        id: "c1",
        scene_id: "s1",
        order: 1,
        speaker: "",
        original_en: "“I can't… go?”",
        approved_en: "“I can't… go?”",
        approved_pt: "“Eu não consigo… ir?”",
        speech_timing: { start_ms: 100, end_ms: 1800 },
        subtitle_timing: { start_ms: 100, end_ms: 1800 },
        revision: 1,
        provenance: {
          source: "asr_candidate",
          approval: "draft",
          editorial_preparation: "complete",
        },
        words: [
          {
            id: "w1",
            order: 1,
            surface: "can't…",
            start_ms: 100,
            end_ms: 1800,
            pt: "não consigo",
          },
        ],
      },
    ]);
  });

  it("presents a focused workstation and sends literal EN/PT approval", async () => {
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1&ingest_job=j1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("Player do corte da cena")).toBeInTheDocument();
    expect(screen.getAllByText("“I can't… go?”")).toHaveLength(2);
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
        approve: true,
      }),
    );
  });

  it("blocks the workstation while a mandatory word translation is missing", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([
      {
        ...cue,
        words: cue.words.map((word) => ({ ...word, pt: undefined })),
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "A cena ainda possui lacunas" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Player do corte da cena")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: /Baixar pacote para IA externa/ }),
    ).toBeInTheDocument();
  });

  it("offers the external fallback when Groq status cannot be loaded", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([
      {
        ...cue,
        approved_pt: "",
        provenance: { source: "asr_candidate", approval: "draft" },
      },
    ]);
    mocks.editorialAssistantStatus.mockRejectedValueOnce(new Error("offline"));
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText("Não foi possível consultar a Groq. Use o pacote para IA externa."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Baixar pacote para IA externa/ })).toBeInTheDocument();
  });

  it("explains a validated source and starts processing from the empty state", async () => {
    mocks.projectMedia.mockResolvedValueOnce({ state: "source_validated", can_review: false });
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Vídeo validado" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Iniciar processamento" }));
    await waitFor(() => expect(mocks.startProjectMedia).toHaveBeenCalledWith("p1"));
  });

  it("supports cue navigation and an accessible word inspector", async () => {
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Selecione uma palavra" }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("list", { name: "Palavras do cue selecionado" })).getByRole(
        "button",
        { name: /can't…/ },
      ),
    );
    expect(screen.getByRole("heading", { name: "Palavra “can't…”" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cue anterior" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Próximo cue" })).toBeDisabled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "IN (ms)" }), {
      target: { value: "125" },
    });
    expect(screen.getByRole("button", { name: "Salvar palavra" })).toBeEnabled();
  });

  it("groups contiguous words under one natural translation", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      {
        ...cue,
        original_en: "Can I help?",
        words: [
          { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 350, pt: "Posso" },
          { id: "w2", order: 2, surface: "I", start_ms: 360, end_ms: 480, pt: "eu" },
          {
            id: "w3",
            order: 3,
            surface: "help?",
            start_ms: 490,
            end_ms: 800,
            pt: "ajudar?",
          },
        ],
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const wordList = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(wordList).getByRole("button", { name: /Can/ }));
    fireEvent.change(screen.getByLabelText("Tradução natural da unidade"), {
      target: { value: "Posso ajudar?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Agrupar próxima" }));
    await waitFor(() =>
      expect(mocks.groupWordTranslation).toHaveBeenCalledWith(
        "c1",
        "w1",
        "next",
        "Posso ajudar?",
        "local-editor",
      ),
    );
    expect(screen.getByText(/Can I help.*Posso ajudar/)).toBeInTheDocument();
  });

  it("keeps AI semantic units local until the operator saves the draft", async () => {
    const cue = (await mocks.editorialCues())[0];
    const words = [
      { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 350, pt: "Posso" },
      { id: "w2", order: 2, surface: "I", start_ms: 360, end_ms: 480, pt: "eu" },
      { id: "w3", order: 3, surface: "help?", start_ms: 490, end_ms: 800, pt: "ajudar?" },
    ];
    mocks.editorialCues.mockResolvedValue([{ ...cue, original_en: "Can I help?", words }]);
    mocks.editorialAssistantStatus.mockResolvedValueOnce({
      groq_configured: true,
      groq_model: "test-model",
      fallback_available: true,
    });
    mocks.startEditorialAssistance.mockResolvedValueOnce({ job_id: "job-ai", status: "queued" });
    mocks.job.mockResolvedValueOnce({
      status: "succeeded",
      output: {
        scene_id: "s1",
        input_sha256: "a".repeat(64),
        provider: "groq",
        model: "test-model",
        rate_limits: {},
        suggestions: [
          {
            cue_id: "c1",
            order: 1,
            approved_en: "Can I help?",
            approved_pt: "Posso ajudar?",
            notes: "Pergunta natural.",
            word_translations: [
              { word_id: "w1", pt: "Posso" },
              { word_id: "w2", pt: "eu" },
              { word_id: "w3", pt: "ajudar?" },
            ],
            semantic_units: [{ word_ids: ["w1", "w2", "w3"], pt: "Posso ajudar?" }],
          },
        ],
      },
    });
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const suggest = await screen.findByRole("button", { name: "Sugerir com Groq" });
    await waitFor(() => expect(suggest).toBeEnabled());
    fireEvent.click(suggest);
    expect(await screen.findByLabelText("Unidades sugeridas")).toHaveTextContent(
      "Can I help? → Posso ajudar?",
    );
    fireEvent.click(screen.getByRole("button", { name: "Aplicar grupo" }));
    expect(mocks.replaceSemanticUnits).not.toHaveBeenCalled();
    expect(screen.getByText("Alterações não salvas")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() =>
      expect(mocks.replaceSemanticUnits).toHaveBeenCalledWith(
        "c1",
        cue.revision,
        [{ word_ids: ["w1", "w2", "w3"], pt: "Posso ajudar?" }],
        "local-editor",
      ),
    );
    expect(mocks.updateWordTiming).not.toHaveBeenCalled();
  });

  it("realigns the next cue to a 10 ms gap when G saves an expanded cue", async () => {
    const first = (await mocks.editorialCues())[0];
    const second = {
      ...first,
      id: "c2",
      order: 2,
      original_en: "Next.",
      speech_timing: { start_ms: 1810, end_ms: 1950 },
      subtitle_timing: { start_ms: 1810, end_ms: 1950 },
      words: [
        { id: "w2", order: 1, surface: "Next.", start_ms: 1810, end_ms: 1950, pt: "Próximo." },
      ],
    };
    mocks.editorialCues.mockResolvedValue([first, second]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    await screen.findByLabelText("Player do corte da cena");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Aumentar cue atrasando o fim em 25 milissegundos",
      }),
    );
    fireEvent.keyDown(window, { key: "g" });
    await waitFor(() => expect(mocks.realignCue).toHaveBeenCalledWith("c2", 1835, "local-editor"));
  });

  it("opens the synchronized iHub preview from the current cue with Ctrl+Enter", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    await screen.findByLabelText("Player do corte da cena");
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    const preview = await screen.findByRole("dialog", { name: "Vídeo e legendas sincronizadas" });
    expect(preview).toBeInTheDocument();
    expect(screen.getByLabelText("Prévia do vídeo no iHub")).toHaveAttribute("src", "/api/cut.wav");
    expect(screen.getByRole("button", { name: "Dual" })).toHaveAttribute("aria-pressed", "true");
  });
});
