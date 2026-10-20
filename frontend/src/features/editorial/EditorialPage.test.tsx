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
  completeWordTimingReview: vi.fn().mockResolvedValue({
    provenance: { word_timing_reviewed: true },
  }),
  updateWordTranslation: vi.fn().mockResolvedValue({}),
  updateWordSurface: vi.fn().mockResolvedValue({ approved_en: "I stay." }),
  fitCueToWords: vi.fn().mockResolvedValue({}),
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
  importExternalEditorialResults: vi.fn(),
  mergeEditorialCues: vi.fn(),
  splitEditorialCue: vi.fn(),
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
    completeWordTimingReview: mocks.completeWordTimingReview,
    updateWordTranslation: mocks.updateWordTranslation,
    updateWordSurface: mocks.updateWordSurface,
    fitCueToWords: mocks.fitCueToWords,
    groupWordTranslation: mocks.groupWordTranslation,
    ungroupWordTranslation: mocks.ungroupWordTranslation,
    replaceSemanticUnits: mocks.replaceSemanticUnits,
    realignCue: mocks.realignCue,
    editorialAssistantStatus: mocks.editorialAssistantStatus,
    externalEditorialPackageUrl: mocks.externalEditorialPackageUrl,
    startEditorialAssistance: mocks.startEditorialAssistance,
    importExternalEditorialResult: mocks.importExternalEditorialResult,
    importExternalEditorialResults: mocks.importExternalEditorialResults,
    mergeEditorialCues: mocks.mergeEditorialCues,
    splitEditorialCue: mocks.splitEditorialCue,
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

  it("saves a corrected AI word and updates the canonical cue text", async () => {
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(list).getByRole("button", { name: /can't/ }));
    const field = await screen.findByRole("textbox", { name: "Corrigir palavra em inglês" });
    fireEvent.change(field, { target: { value: "can" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar palavra" }));
    await waitFor(() =>
      expect(mocks.updateWordSurface).toHaveBeenCalledWith("c1", "w1", "can", "local-editor"),
    );
  });

  it("offers to adjust a cue whose words exceed its speech interval", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([
      {
        ...cue,
        words: [
          { ...cue.words[0], start_ms: 50, end_ms: 1900 },
        ],
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const button = await screen.findByRole("button", { name: "Ajustar limites às palavras" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(mocks.fitCueToWords).toHaveBeenCalledWith("c1", "local-editor"),
    );
  });

  it("links approved editorial projects to Shadowing instead of Anki materials", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      { ...cue, provenance: { ...cue.provenance, approval: "approved" } },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const action = await screen.findByRole("link", { name: "Preparar shadowing" });
    expect(action).toHaveAttribute("href", "/shadowing?project=p1");
  });

  it("separates AI preparation from manual cue approval in the review context", async () => {
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("0 de 1 aprovados")).toBeInTheDocument();
    expect(screen.getByText("Preparação de IA completa")).toBeInTheDocument();
  });

  it("presents a focused workstation and sends literal EN/PT approval", async () => {
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1&ingest_job=j1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("Player do corte da cena")).toBeInTheDocument();
    expect(screen.getAllByText("“I can't… go?”").length).toBeGreaterThanOrEqual(2);
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
      await screen.findByRole("link", { name: /Baixar blocos de texto para IA externa/ }),
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
    expect(
      screen.getByRole("link", { name: /Baixar blocos de texto para IA externa/ }),
    ).toBeInTheDocument();
  });

  it("imports an external editorial result dropped into the import area", async () => {
    mocks.importExternalEditorialResult.mockResolvedValueOnce({
      scene_id: "s1",
      input_sha256: "a".repeat(64),
      provider: "external",
      model: "external-ai",
      rate_limits: {},
      suggestions: [
        {
          cue_id: "c1",
          order: 1,
          approved_en: "“I can't… go?”",
          approved_pt: "“Eu não consigo… ir?”",
          notes: "Conferido.",
          word_translations: [{ word_id: "w1", pt: "não consigo" }],
          semantic_units: [],
        },
      ],
    });
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const file = new File(
      ['{"schema_version":"nova-generator-editorial-suggestions/1.3"}'],
      "retorno.json",
      {
        type: "application/json",
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Trocar fonte de preparação" }));
    fireEvent.drop(await screen.findByLabelText("Importar retorno editorial"), {
      dataTransfer: { files: [file] },
    });
    await waitFor(() =>
      expect(mocks.importExternalEditorialResult).toHaveBeenCalledWith("s1", file),
    );
    expect(await screen.findByText(/Todos os blocos foram validados/)).toBeInTheDocument();
  });

  it("imports three external editorial chunks with one drop and one request", async () => {
    mocks.importExternalEditorialResults.mockResolvedValueOnce({
      scene_id: "s1",
      input_sha256: "a".repeat(64),
      provider: "external",
      model: "external-ai",
      rate_limits: {},
      suggestions: [],
    });
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const files = [1, 2, 3].map(
      (index) =>
        new File(['{"chunk_id":"chunk-001"}'], `chunk-${index}.json`, {
          type: "application/json",
        }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Trocar fonte de preparação" }));
    fireEvent.drop(await screen.findByLabelText("Importar retorno editorial"), {
      dataTransfer: { files },
    });
    await waitFor(() => {
      expect(mocks.importExternalEditorialResults).toHaveBeenCalledWith("s1", files);
      expect(mocks.importExternalEditorialResult).not.toHaveBeenCalled();
    });
    expect(await screen.findByText(/Todos os blocos foram validados/)).toBeInTheDocument();
  });

  it("joins adjacent cues from the editor without changing their individual word timings", async () => {
    const first = (await mocks.editorialCues())[0];
    const second = {
      ...first,
      id: "c2",
      order: 2,
      original_en: "Lizzie!",
      approved_en: "Lizzie!",
      approved_pt: "Lizzie!",
      speech_timing: { start_ms: 1900, end_ms: 2200 },
      subtitle_timing: { start_ms: 1900, end_ms: 2200 },
      words: [
        { id: "w2", order: 1, surface: "Lizzie!", start_ms: 1900, end_ms: 2200, pt: "Lizzie!" },
      ],
    };
    mocks.editorialCues.mockResolvedValueOnce([first, second]);
    mocks.mergeEditorialCues.mockResolvedValueOnce({ id: "merged" });
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const mergeButton = await screen.findByRole("button", { name: "Unir com próximas" });
    await waitFor(() => expect(mergeButton).toBeEnabled());
    fireEvent.click(mergeButton);
    expect(screen.getByRole("heading", { name: "Unir cues consecutivas" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Português unificado" }), {
      target: { value: "Não até eu falar com você, Lizzie!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar união" }));
    await waitFor(() =>
      expect(mocks.mergeEditorialCues).toHaveBeenCalledWith(["c1", "c2"], {
        author: "local-editor",
        speaker: "",
        confirm_same_speaker: false,
        text: {
          original_en: "“I can't… go?” Lizzie!",
          approved_en: "“I can't… go?” Lizzie!",
          approved_pt: "Não até eu falar com você, Lizzie!",
        },
      }),
    );
  });

  it("can merge a short selected cue directly with the previous one", async () => {
    const first = (await mocks.editorialCues())[0];
    const last = {
      ...first,
      id: "c2",
      order: 2,
      original_en: "Lizzie!",
      approved_en: "Lizzie!",
      approved_pt: "Lizzie!",
      speech_timing: { start_ms: 1900, end_ms: 2200 },
      subtitle_timing: { start_ms: 1900, end_ms: 2200 },
      words: [
        { id: "w2", order: 1, surface: "Lizzie!", start_ms: 1900, end_ms: 2200, pt: "Lizzie!" },
      ],
    };
    mocks.editorialCues.mockResolvedValueOnce([first, last]);
    mocks.mergeEditorialCues.mockResolvedValueOnce({ id: "merged" });
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const cueList = await screen.findByRole("navigation", { name: "Lista de cues" });
    const nextCue = within(cueList).getAllByRole("button")[1];
    await waitFor(() => expect(nextCue).toBeEnabled());
    fireEvent.click(nextCue);
    const mergePrevious = await screen.findByRole("button", { name: "Unir com anterior" });
    await waitFor(() => expect(mergePrevious).toBeEnabled());
    fireEvent.click(mergePrevious);
    expect(await screen.findByRole("heading", { name: "Unir cues consecutivas" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar união" }));
    await waitFor(() =>
      expect(mocks.mergeEditorialCues).toHaveBeenCalledWith(
        ["c1", "c2"],
        expect.objectContaining({ author: "local-editor" }),
      ),
    );
  });

  it("splits a cue after a chosen word and asks for both translations", async () => {
    const original = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([
      {
        ...original,
        words: [
          { id: "w1", order: 1, surface: "I", start_ms: 100, end_ms: 400, pt: "Eu" },
          {
            id: "w2",
            order: 2,
            surface: " can't go?",
            start_ms: 500,
            end_ms: 1600,
            pt: "não posso ir?",
          },
        ],
      },
    ]);
    mocks.splitEditorialCue.mockResolvedValueOnce([{ id: "left" }, { id: "right" }]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const splitButton = await screen.findByRole("button", { name: "Dividir por palavra" });
    await waitFor(() => expect(splitButton).toBeEnabled());
    fireEvent.click(splitButton);
    expect(screen.getByRole("combobox", { name: "Palavra onde dividir" })).toHaveValue("w1");
    fireEvent.change(screen.getByRole("textbox", { name: "Português da primeira parte" }), {
      target: { value: "Eu" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Português da segunda parte" }), {
      target: { value: "não posso ir?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar divisão" }));
    await waitFor(() =>
      expect(mocks.splitEditorialCue).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          author: "local-editor",
          after_word_id: "w1",
          first: expect.objectContaining({ approved_pt: "Eu" }),
          second: expect.objectContaining({ approved_pt: "não posso ir?" }),
        }),
      ),
    );
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
    const player = screen.getByLabelText("Player do corte da cena") as HTMLVideoElement;
    Object.defineProperty(player, "currentTime", { configurable: true, value: 0.125, writable: true });
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: /Marcar início/ }));
    expect(screen.getByRole("button", { name: "Salvar palavra" })).toBeEnabled();
  });

  it("focuses and plays the selected cue when Space is pressed in the cue list", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );

    await screen.findByLabelText("Player do corte da cena");
    const cueButton = within(
      screen.getByRole("navigation", { name: "Lista de cues" }),
    ).getAllByRole("button")[0];
    fireEvent.keyDown(cueButton, { key: " " });

    await waitFor(() => expect(screen.getByLabelText("Timeline de cues e palavras")).toHaveFocus());
    expect(play).toHaveBeenCalledTimes(1);
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

  it("adjusts only the selected word timing inside a semantic unit", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      {
        ...cue,
        original_en: "Can I help?",
        words: [
          {
            id: "w1",
            order: 1,
            surface: "Can",
            start_ms: 100,
            end_ms: 350,
            pt: "Posso ajudar?",
            semantic_group_id: "unit-1",
            semantic_group_role: "lead",
          },
          {
            id: "w2",
            order: 2,
            surface: "I",
            start_ms: 360,
            end_ms: 480,
            semantic_group_id: "unit-1",
            semantic_group_role: "member",
          },
          {
            id: "w3",
            order: 3,
            surface: "help?",
            start_ms: 490,
            end_ms: 800,
            semantic_group_id: "unit-1",
            semantic_group_role: "member",
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
    fireEvent.click(within(wordList).getByRole("button", { name: /I/ }));
    const player = screen.getByLabelText("Player do corte da cena") as HTMLVideoElement;
    Object.defineProperty(player, "currentTime", { configurable: true, value: 0.37, writable: true });
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: /Marcar início/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar palavra" }));

    await waitFor(() =>
      expect(mocks.updateWordTiming).toHaveBeenCalledWith("c1", {
        author: "local-editor",
        timings: [
          { id: "w1", start_ms: 100, end_ms: 350 },
          { id: "w2", start_ms: 370, end_ms: 480 },
          { id: "w3", start_ms: 490, end_ms: 800 },
        ],
      }),
    );
  });

  it("replays a selected word using its unsaved IN and OUT marks", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      {
        ...cue,
        original_en: "Can I help?",
        words: [
          { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 350, pt: "Posso" },
          { id: "w2", order: 2, surface: "I", start_ms: 360, end_ms: 480, pt: "eu" },
          { id: "w3", order: 3, surface: "help?", start_ms: 490, end_ms: 800, pt: "ajudar?" },
        ],
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );

    const player = (await screen.findByLabelText("Player do corte da cena")) as HTMLVideoElement;
    const wordList = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(wordList).getByRole("button", { name: /I/ }));
    Object.defineProperty(player, "currentTime", { configurable: true, value: 0.375, writable: true });
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: /Marcar início/ }));
    player.currentTime = 0.475;
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: /Marcar fim/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reproduzir palavra" }));
    // Native onPlay must NOT replace the word's OUT with the cue's end.
    fireEvent.play(player);

    expect(player.currentTime).toBeCloseTo(0.375, 4);
    expect(play).toHaveBeenCalledTimes(1);

    const initialPauses = pause.mock.calls.length;
    Object.defineProperty(player, "currentTime", {
      configurable: true,
      value: 0.476,
      writable: true,
    });
    fireEvent.timeUpdate(player);
    expect(pause).toHaveBeenCalledTimes(initialPauses + 1);
  });

  it("restarts the word preview even while the full cue is already playing", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      {
        ...cue,
        words: [
          { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 350, pt: "Posso" },
          { id: "w2", order: 2, surface: "I", start_ms: 360, end_ms: 480, pt: "eu" },
          { id: "w3", order: 3, surface: "help?", start_ms: 490, end_ms: 800, pt: "ajudar?" },
        ],
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const player = (await screen.findByLabelText("Player do corte da cena")) as HTMLVideoElement;
    const list = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(list).getByRole("button", { name: /I/ }));
    fireEvent.play(player);
    fireEvent.click(screen.getByRole("button", { name: "Reproduzir palavra" }));
    expect(player.currentTime).toBeCloseTo(0.36, 3);
    expect(play).toHaveBeenCalled();
    Object.defineProperty(player, "currentTime", { configurable: true, value: 0.481, writable: true });
    fireEvent.timeUpdate(player);
    expect(pause).toHaveBeenCalled();
  });

  it("does not play a zero-duration word and displays an explanation", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      {
        ...cue,
        words: [{ id: "w1", order: 1, surface: "It's", start_ms: 1580, end_ms: 1580, pt: "É" }],
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(list).getByRole("button", { name: /It's/ }));
    expect(await screen.findByText(/Palavra sem duração/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reproduzir palavra" }));
    expect(await screen.findByText(/A palavra não tem intervalo válido/)).toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  });

  it("saves the selected word and opens the next word with Enter", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      {
        ...cue,
        original_en: "Can I help?",
        words: [
          { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 350, pt: "Posso" },
          { id: "w2", order: 2, surface: "I", start_ms: 360, end_ms: 480, pt: "eu" },
          { id: "w3", order: 3, surface: "help?", start_ms: 490, end_ms: 800, pt: "ajudar?" },
        ],
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );

    const wordList = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(wordList).getByRole("button", { name: /I/ }));
    const player = screen.getByLabelText("Player do corte da cena") as HTMLVideoElement;
    Object.defineProperty(player, "currentTime", { configurable: true, value: 0.37, writable: true });
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: /Marcar início/ }));
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() =>
      expect(mocks.updateWordTiming).toHaveBeenCalledWith("c1", {
        author: "local-editor",
        timings: [
          { id: "w1", start_ms: 100, end_ms: 350 },
          { id: "w2", start_ms: 370, end_ms: 480 },
          { id: "w3", start_ms: 490, end_ms: 800 },
        ],
      }),
    );
    await waitFor(() =>
      expect(within(wordList).getByRole("button", { name: /help/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
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
    fireEvent.click(await screen.findByRole("button", { name: "Trocar fonte de preparação" }));
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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Prévia no iHub" })).toBeEnabled(),
    );
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    const preview = await screen.findByRole("dialog", { name: "Vídeo e legendas sincronizadas" });
    expect(preview).toBeInTheDocument();
    expect(screen.getByLabelText("Prévia do vídeo no iHub")).toHaveAttribute("src", "/api/cut.wav");
    expect(screen.getByRole("button", { name: "Dual" })).toHaveAttribute("aria-pressed", "true");
  });
});
