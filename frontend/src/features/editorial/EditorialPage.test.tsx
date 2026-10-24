import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { EditorialPage, cueWordTranslation } from "./EditorialPage";

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
  transferWordToAdjacentCue: vi.fn().mockResolvedValue([]),
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
    transferWordToAdjacentCue: mocks.transferWordToAdjacentCue,
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

  it("synchronizes the inspector and the saved word list from any approved-text deletion", async () => {
    const original = (await mocks.editorialCues())[0];
    const surfaces = ["Not", " until", " I", " speak", " to", " you!", " Lizzie!"];
    const words = surfaces.map((surface, index) => ({
      id: "w" + index,
      order: index + 1,
      surface,
      start_ms: 100 + index * 200,
      end_ms: 250 + index * 200,
      pt: surface.trim(),
    }));
    const before = {
      ...original,
      original_en: "Not until I speak to you! Lizzie!",
      approved_en: "Not until I speak to you! Lizzie!",
      approved_pt: "Só depois que eu falar com você, Lizzie!",
      words,
    };
    const after = {
      ...before,
      approved_en: "Not until I speak to Lizzie!",
      words: words.filter((word) => word.id !== "w5").map((word, index) => ({
        ...word,
        order: index + 1,
      })),
    };
    mocks.editorialCues.mockResolvedValueOnce([before]).mockResolvedValue([after]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Inglês aprovado" }))
        .toHaveValue(before.approved_en),
    );
    expect(within(list).getByRole("button", { name: /you!/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /Lizzie!/ })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Inglês aprovado" }), {
      target: { value: "Not until I speak to Lizzie!" },
    });
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Inglês aprovado" }))
        .toHaveValue("Not until I speak to Lizzie!");
      expect(within(list).queryByRole("button", { name: /you!/ })).not.toBeInTheDocument();
    });
    expect(within(list).getByRole("button", { name: /Lizzie!/ })).toBeInTheDocument();
    expect(within(list).getAllByRole("button")).toHaveLength(6);

    fireEvent.click(screen.getByRole("button", { name: "Salvar texto" }));
    await waitFor(() =>
      expect(mocks.updateCueText).toHaveBeenCalledWith("c1", {
        author: "local-editor",
        approved_en: "Not until I speak to Lizzie!",
        approved_pt: "Só depois que eu falar com você, Lizzie!",
        approve: false,
      }),
    );
    expect(within(list).queryByRole("button", { name: /you!/ })).not.toBeInTheDocument();
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

  it("offers re-export and AI response import even after editorial approval", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      { ...cue, provenance: { ...cue.provenance, approval: "approved" } },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Regerar JSON / importar IA" }));
    const regenerate = await screen.findByRole("link", {
      name: "Gerar novamente JSON para IA externa",
    });
    expect(regenerate).toHaveAttribute("href", "/api/external.zip");
    expect(screen.getByLabelText("Importar retorno editorial")).toBeInTheDocument();
    expect(screen.getByText(/não refaz o corte nem a transcrição/i)).toBeInTheDocument();
    expect(mocks.startProjectMedia).not.toHaveBeenCalled();
  });

  it("asks for confirmation before importing over an approved editorial", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      { ...cue, provenance: { ...cue.provenance, approval: "approved" } },
    ]);
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(
        <MemoryRouter initialEntries={["/editorial?project=p1"]}>
          <EditorialPage />
        </MemoryRouter>,
      );
      const file = new File(['{"chunk_id":"chunk-001"}'], "resultado.json", {
        type: "application/json",
      });
      fireEvent.click(
        await screen.findByRole("button", { name: "Regerar JSON / importar IA" }),
      );
      fireEvent.drop(await screen.findByLabelText("Importar retorno editorial"), {
        dataTransfer: { files: [file] },
      });
      await waitFor(() => expect(confirmation).toHaveBeenCalled());
      expect(mocks.importExternalEditorialResult).not.toHaveBeenCalled();
      expect(mocks.startProjectMedia).not.toHaveBeenCalled();
    } finally {
      confirmation.mockRestore();
    }
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

  it("keeps the workstation open for manual review when a prepared cue lacks a word translation", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([
      {
        ...cue,
        words: cue.words.map((word) => ({
          ...word,
          pt: undefined,
          provenance: { translation_review_required: true },
        })),
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("Player do corte da cena")).toBeInTheDocument();
    expect(screen.getByText("Revisão manual pendente em 1 cue(s)")).toBeInTheDocument();
    expect(screen.getByText(/A edição permanece liberada/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "A cena ainda possui lacunas" }))
      .not.toBeInTheDocument();
    const wordList = screen.getByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(wordList).getByRole("button", { name: /can't…/ }));
    expect(screen.getByRole("textbox", { name: "Tradução natural da unidade" })).toBeEnabled();
  });

  it("never sends a previously prepared cue back to mandatory AI after inserting words", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([
      {
        ...cue,
        approved_en: "What's the point?",
        approved_pt: "Pra quê?",
        provenance: {
          ...cue.provenance,
          editorial_text_manually_corrected: true,
        },
        words: [
          { id: "what", order: 1, surface: "What's", start_ms: 100, end_ms: 400,
            pt: "o que" },
          { id: "the", order: 2, surface: " the", start_ms: 415, end_ms: 620,
            pt: "", provenance: {
              editorial_word_inserted: true,
              editorial_timing_estimated: true,
              translation_review_required: true,
            } },
          { id: "point", order: 3, surface: " point?", start_ms: 635, end_ms: 900,
            pt: "", provenance: {
              editorial_word_inserted: true,
              editorial_timing_estimated: true,
              translation_review_required: true,
            } },
        ],
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("Player do corte da cena")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aprovar cue" })).toBeEnabled();
    expect(screen.getByText("Revisão manual pendente em 1 cue(s)")).toBeInTheDocument();
    expect(screen.queryByText("A cena ainda possui lacunas")).not.toBeInTheDocument();
  });

  it("allows a prepared cue with an empty PT field to be saved without re-running AI", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([{
      ...cue,
      approved_pt: "",
      provenance: { ...cue.provenance, editorial_preparation: "complete" },
    }]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("Player do corte da cena")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Português aprovado"), {
      target: { value: "Pra quê?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar texto" }));
    await waitFor(() =>
      expect(mocks.updateCueText).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          approved_pt: "Pra quê?",
          approve: false,
        }),
      ),
    );
    expect(screen.queryByText("A cena ainda possui lacunas")).not.toBeInTheDocument();
  });

  it("does not manufacture an unsaved draft or resegment English when only PT changes", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([{
      ...cue,
      approved_en: "What's the point?",
      approved_pt: "o que",
      provenance: {
        ...cue.provenance,
        editorial_text_manually_corrected: true,
      },
      words: [{
        id: "w1", order: 1, surface: "What's", start_ms: 100, end_ms: 400,
        pt: "o que",
      }],
    }]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("Player do corte da cena")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Português aprovado"), {
      target: { value: "Pra quê?" },
    });
    expect(screen.queryByLabelText("OUT provisório da cue")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Salvar texto" }));
    await waitFor(() =>
      expect(mocks.updateCueText).toHaveBeenCalledWith("c1", {
        author: "local-editor",
        approved_en: "What's the point?",
        approved_pt: "Pra quê?",
        approve: false,
      }),
    );
    expect(mocks.updateWordTiming).not.toHaveBeenCalled();
  });

  it("keeps translation drafts savable even if old word timing needs correction", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([{
      ...cue,
      words: cue.words.map((word) => ({ ...word, end_ms: 2000 })),
    }]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("Player do corte da cena")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Português aprovado"), {
      target: { value: "Texto para revisar." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar texto" }));
    await waitFor(() =>
      expect(mocks.updateCueText).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ approved_pt: "Texto para revisar.", approve: false }),
      ),
    );
  });

  it("guides approval of a saved expanded cue without treating Save as a pending action", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([{
      ...cue,
      approved_en: "What's the point?",
      approved_pt: "Pra quê?",
      words: [
        { id: "w1", order: 1, surface: "What's", start_ms: 100, end_ms: 500,
          pt: "o que" },
        { id: "w2", order: 2, surface: " the", start_ms: 510, end_ms: 700,
          pt: "", provenance: {
            editorial_timing_estimated: true, translation_review_required: true,
          } },
        { id: "w3", order: 3, surface: " point?", start_ms: 710, end_ms: 900,
          pt: "", provenance: {
            editorial_timing_estimated: true, translation_review_required: true,
          } },
      ],
    }]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("Player do corte da cena")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Aprovar cue" }));
    const review = screen.getByRole("region", { name: "Confirmar revisão antes de aprovar" });
    expect(review).toHaveTextContent("O texto já está salvo.");
    expect(mocks.updateCueText).not.toHaveBeenCalled();
    const confirm = within(review).getByRole("button", { name: "Confirmar revisão e aprovar" });
    expect(confirm).toBeDisabled();
    fireEvent.click(within(review).getByRole("checkbox", { name: /Conferi no áudio/ }));
    fireEvent.click(within(review).getByRole("checkbox", { name: /Usar “Pra quê\?” como tradução contextual/ }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.updateCueText).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        approve: true,
        approved_pt: "Pra quê?",
        confirm_word_timings: true,
        confirm_word_translations: false,
        group_cue_translation: true,
      }),
    ));
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
    fireEvent.click(await screen.findByRole("button", { name: "Regerar JSON / importar IA" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Regerar JSON / importar IA" }));
    fireEvent.drop(await screen.findByLabelText("Importar retorno editorial"), {
      dataTransfer: { files },
    });
    await waitFor(() => {
      expect(mocks.importExternalEditorialResults).toHaveBeenCalledWith("s1", files);
      expect(mocks.importExternalEditorialResult).not.toHaveBeenCalled();
    });
    expect(await screen.findByText(/Todos os blocos foram validados/)).toBeInTheDocument();
  });

  it("shows stale ZIP errors directly under the dropzone", async () => {
    mocks.importExternalEditorialResults.mockRejectedValueOnce(
      new ApiError("chunks/001: result is for another or stale scene", 422),
    );
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Regerar JSON / importar IA" }));
    fireEvent.drop(screen.getByLabelText("Importar retorno editorial"), {
      dataTransfer: { files: [new File(["zip"], "outdated.zip")] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/outra versão da cena/);
    expect(screen.getByRole("alert")).toHaveTextContent(/stale scene/);
  });

  it("asks the owner before applying a ZIP that changes cue boundaries", async () => {
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.importExternalEditorialResults
      .mockRejectedValueOnce(new ApiError("Este ZIP reorganiza 30 cues em 32 cues.", 409))
      .mockResolvedValueOnce({
        scene_id: "s1", input_sha256: "a".repeat(64),
        provider: "external", model: "external-ai", rate_limits: {}, suggestions: [],
      });
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const file = new File(["zip"], "reorganized.zip", { type: "application/zip" });
    fireEvent.click(await screen.findByRole("button", { name: "Regerar JSON / importar IA" }));
    fireEvent.drop(screen.getByLabelText("Importar retorno editorial"), {
      dataTransfer: { files: [file] },
    });
    await waitFor(() => {
      expect(confirmation).toHaveBeenCalledWith("Este ZIP reorganiza 30 cues em 32 cues.");
      expect(mocks.importExternalEditorialResults).toHaveBeenNthCalledWith(1, "s1", [file]);
      expect(mocks.importExternalEditorialResults).toHaveBeenNthCalledWith(2, "s1", [file], true);
    });
    expect(await screen.findByText(/cues importadas/)).toBeInTheDocument();
    confirmation.mockRestore();
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

  it("automatically reuses existing word translations when splitting a cue", async () => {
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
    expect(screen.getByRole("textbox", { name: "Português da primeira parte" })).toHaveValue("Eu");
    expect(screen.getByRole("textbox", { name: "Português da segunda parte" }))
      .toHaveValue("não posso ir?");
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

  it("uses one translation per semantic group and updates suggestions when the boundary changes", async () => {
    const original = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([{
      ...original,
      approved_en: "Can you help now?",
      approved_pt: "Você pode ajudar agora?",
      words: [
        { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 300,
          pt: "Pode ajudar", semantic_group_id: "g1", semantic_group_role: "lead" },
        { id: "w2", order: 2, surface: " you help", start_ms: 310, end_ms: 700,
          pt: null, semantic_group_id: "g1", semantic_group_role: "member" },
        { id: "w3", order: 3, surface: " now?", start_ms: 710, end_ms: 1000,
          pt: "agora?" },
      ],
    }]);
    mocks.splitEditorialCue.mockResolvedValueOnce([{ id: "left" }, { id: "right" }]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const splitButton = await screen.findByRole("button", { name: "Dividir por palavra" });
    await waitFor(() => expect(splitButton).toBeEnabled());
    fireEvent.click(splitButton);
    fireEvent.change(screen.getByRole("combobox", { name: "Palavra onde dividir" }), {
      target: { value: "w2" },
    });
    expect(screen.getByRole("textbox", { name: "Português da primeira parte" }))
      .toHaveValue("Pode ajudar");
    expect(screen.getByRole("textbox", { name: "Português da segunda parte" }))
      .toHaveValue("agora?");
    expect(screen.queryByText(/Algumas palavras ainda não possuem tradução/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar divisão" }));
    await waitFor(() =>
      expect(mocks.splitEditorialCue).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          after_word_id: "w2",
          first: expect.objectContaining({ approved_pt: "Pode ajudar" }),
          second: expect.objectContaining({ approved_pt: "agora?" }),
        }),
      ),
    );
  });

  it("reports incomplete translations without inventing missing words", () => {
    expect(cueWordTranslation([
      { id: "w1", order: 1, surface: "Come", start_ms: 100, end_ms: 400, pt: null },
      { id: "w2", order: 2, surface: " now!", start_ms: 500, end_ms: 700, pt: "agora!" },
    ])).toEqual({ text: "agora!", complete: false });
  });

  it("expands a cue for inserted words and lets the operator adjust OUT before saving", async () => {
    const original = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([{
      ...original,
      original_en: "What's...",
      approved_en: "What's...",
      approved_pt: "o que",
      speech_timing: { start_ms: 100, end_ms: 300 },
      subtitle_timing: { start_ms: 100, end_ms: 300 },
      words: [
        { id: "w1", order: 1, surface: "What's...", start_ms: 100, end_ms: 300, pt: "o que" },
      ],
    }]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const english = await screen.findByLabelText("Inglês aprovado");
    fireEvent.change(english, { target: { value: "What's the point?" } });
    const out = screen.getByLabelText("OUT provisório da cue");
    expect(Number((out as HTMLInputElement).value)).toBeGreaterThan(300);
    expect(screen.getByText(/palavra\(s\) nova\(s\)/)).toBeInTheDocument();
    fireEvent.change(out, { target: { value: "800" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar texto" }));
    await waitFor(() =>
      expect(mocks.updateCueText).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          approved_en: "What's the point?",
          approve: false,
          proposed_speech_timing: { start_ms: 100, end_ms: 800 },
          proposed_word_timings: expect.arrayContaining([
            expect.objectContaining({ start_ms: 100 }),
          ]),
        }),
      ),
    );
    const payload = mocks.updateCueText.mock.calls.at(-1)?.[1];
    expect(payload.proposed_word_timings).toHaveLength(3);
    expect(mocks.updateWordTiming).not.toHaveBeenCalled();
  });

  it("does not claim approval when an inserted-word cue is first saved as a draft", async () => {
    const original = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValueOnce([{
      ...original,
      approved_en: "What's",
      approved_pt: "Pra quê?",
      words: [{ id: "w1", order: 1, surface: "What's", start_ms: 100, end_ms: 300, pt: "o que" }],
      speech_timing: { start_ms: 100, end_ms: 300 },
      subtitle_timing: { start_ms: 100, end_ms: 300 },
    }]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const english = await screen.findByLabelText("Inglês aprovado");
    fireEvent.change(english, { target: { value: "What's the point?" } });
    fireEvent.click(screen.getByRole("button", { name: "Aprovar cue" }));
    await waitFor(() => expect(mocks.updateCueText).toHaveBeenCalledWith(
      "c1", expect.objectContaining({ approve: false, approved_en: "What's the point?" }),
    ));
    expect(screen.getByText(/A frase corrigida foi salva como rascunho/)).toBeInTheDocument();
    expect(screen.queryByText("Cue 1 aprovado.")).not.toBeInTheDocument();
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
    expect(screen.queryByText("Ajuste fino da fala do cue")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Antecipar início do cue em 25 milissegundos"))
      .not.toBeInTheDocument();
    expect(screen.getByLabelText("Timeline de cues e palavras")).toBeInTheDocument();
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

  it("reviews every word inside a semantic group with independent IN/OUT", async () => {
    const cue = (await mocks.editorialCues())[0];
    const grouped = {
      ...cue,
      original_en: "Can I help?",
      approved_en: "Can I help?",
      approved_pt: "Posso ajudar?",
      words: [
        { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 350,
          pt: "Posso ajudar?", semantic_group_id: "unit-1", semantic_group_role: "lead" },
        { id: "w2", order: 2, surface: " I", start_ms: 360, end_ms: 480,
          pt: null, semantic_group_id: "unit-1", semantic_group_role: "member" },
        { id: "w3", order: 3, surface: " help?", start_ms: 490, end_ms: 800,
          pt: null, semantic_group_id: "unit-1", semantic_group_role: "member" },
      ],
    };
    mocks.editorialCues.mockResolvedValue([grouped]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );

    const list = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(list).getByRole("button", { name: /Can/ }));
    const guide = screen.getByLabelText("Sincronização da palavra selecionada");
    expect(within(guide).getByText("Can")).toBeInTheDocument();
    expect(within(guide).getByText("0.10 s")).toBeInTheDocument();
    expect(within(guide).getByText("0.35 s")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Palavra “Can”" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Tradução natural da unidade" }))
      .toHaveValue("Posso ajudar?");
    expect(screen.getByText(/Unidade semântica \(somente sentido\/tradução\)/))
      .toBeInTheDocument();

    fireEvent.click(within(guide).getByRole("button", { name: /Salvar e próxima/ }));
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: /^I / })).toHaveAttribute(
        "aria-pressed", "true",
      ),
    );
    expect(mocks.completeWordTimingReview).toHaveBeenCalledWith("c1", "w1", "local-editor");
    expect(within(guide).getByText("0.36 s")).toBeInTheDocument();
    expect(within(guide).getByText("0.48 s")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Palavra “I”" })).toBeInTheDocument();

    fireEvent.click(within(guide).getByRole("button", { name: /Salvar e próxima/ }));
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: /help\?/ })).toHaveAttribute(
        "aria-pressed", "true",
      ),
    );
    expect(mocks.completeWordTimingReview).toHaveBeenCalledWith("c1", "w2", "local-editor");
    expect(within(guide).getByText("0.49 s")).toBeInTheDocument();
    expect(within(guide).getByText("0.80 s")).toBeInTheDocument();
    expect(mocks.updateWordTiming).not.toHaveBeenCalled();
    expect(mocks.groupWordTranslation).not.toHaveBeenCalled();
  });

  it("can go backward or return to Cue even if a grouped word cannot be completed", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([{
      ...cue, approved_en: "do you love me?", original_en: "do you love me?",
      words: [
        { id: "w1", order: 1, surface: "do", start_ms: 100, end_ms: 300,
          pt: "você me ama?", semantic_group_id: "group", semantic_group_role: "lead" },
        { id: "w2", order: 2, surface: " you", start_ms: 300, end_ms: 500,
          pt: null, semantic_group_id: "group", semantic_group_role: "member" },
        { id: "w3", order: 3, surface: " love", start_ms: 500, end_ms: 700,
          pt: null, semantic_group_id: "group", semantic_group_role: "member" },
        { id: "w4", order: 4, surface: " me?", start_ms: 700, end_ms: 700,
          pt: null, semantic_group_id: "group", semantic_group_role: "member" },
      ],
    }]);
    mocks.completeWordTimingReview.mockRejectedValueOnce(new Error("invalid word timing"));
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(list).getByRole("button", { name: /me\?/ }));
    const guided = await screen.findByLabelText("Sincronização da palavra selecionada");
    fireEvent.click(within(guided).getByRole("button", { name: "Palavra anterior" }));
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: /love/ }))
        .toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByRole("heading", { name: "Palavra “love”" })).toBeInTheDocument();
    expect(screen.getByText(/permanece pendente/, { selector: ".review-message" })).toBeInTheDocument();
    const dock = screen.getByRole("navigation", { name: "Controles da estação editorial" });
    fireEvent.click(within(dock).getByRole("button", { name: "Cue" }));
    await waitFor(() =>
      expect(within(dock).getByRole("button", { name: "Cue" }))
        .toHaveAttribute("aria-pressed", "true"),
    );
    expect(mocks.updateWordTiming).not.toHaveBeenCalled();
  });

  it("keeps conflicting grouped-word drafts navigable and saves both timing fixes together", async () => {
    const cue = (await mocks.editorialCues())[0];
    const source = { ...cue, original_en: "Can I help?", approved_en: "Can I help?",
      words: [
        { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 400,
          pt: "Posso ajudar?", semantic_group_id: "group", semantic_group_role: "lead" },
        { id: "w2", order: 2, surface: " I", start_ms: 360, end_ms: 480,
          pt: null, semantic_group_id: "group", semantic_group_role: "member" },
        { id: "w3", order: 3, surface: " help?", start_ms: 490, end_ms: 800,
          pt: null, semantic_group_id: "group", semantic_group_role: "member" },
      ] };
    mocks.editorialCues.mockResolvedValue([source]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(list).getByRole("button", { name: /^I / }));
    const player = screen.getByLabelText("Player do corte da cena") as HTMLVideoElement;
    Object.defineProperty(player, "currentTime", { configurable: true, writable: true, value: 0.385 });
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: /Marcar início/ }));
    expect(screen.getByLabelText("Sincronização da palavra selecionada"))
      .toHaveTextContent("0.39 s");
    fireEvent.click(screen.getByRole("button", { name: "Salvar palavra" }));
    expect(await screen.findByText(/sobrepõe a anterior/, { selector: ".review-message" })).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: /Can/ }));
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: /Can/ }))
        .toHaveAttribute("aria-pressed", "true"),
    );
    expect(within(list).getByLabelText("Rascunho não salvo")).toBeInTheDocument();
    player.currentTime = 0.38;
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: /Marcar fim/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar palavra" }));
    await waitFor(() =>
      expect(mocks.updateWordTiming).toHaveBeenCalledWith("c1", {
        author: "local-editor",
        timings: [
          { id: "w1", start_ms: 100, end_ms: 380 },
          { id: "w2", start_ms: 385, end_ms: 480 },
          { id: "w3", start_ms: 490, end_ms: 800 },
        ],
      }),
    );
    expect(mocks.groupWordTranslation).not.toHaveBeenCalled();
    expect(mocks.ungroupWordTranslation).not.toHaveBeenCalled();
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


  it("clicking another word automatically saves, completes and focuses the clicked word", async () => {
    const cue = (await mocks.editorialCues())[0];
    const words = [
      { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 350, pt: "Posso" },
      { id: "w2", order: 2, surface: "I", start_ms: 360, end_ms: 480, pt: "eu" },
      { id: "w3", order: 3, surface: "help?", start_ms: 490, end_ms: 800, pt: "ajudar?" },
    ];
    const original = { ...cue, words };
    const saved = {
      ...cue,
      words: [
        { ...words[0], start_ms: 140, provenance: { word_timing_reviewed: true } },
        ...words.slice(1),
      ],
    };
    mocks.editorialCues.mockResolvedValueOnce([original]).mockResolvedValue([saved]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(list).getByRole("button", { name: /Can/ }));
    const player = screen.getByLabelText("Player do corte da cena") as HTMLVideoElement;
    Object.defineProperty(player, "currentTime", { configurable: true, value: 0.14, writable: true });
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: /Marcar início/ }));
    fireEvent.click(within(list).getByRole("button", { name: /^I/ }));
    await waitFor(() => {
      expect(mocks.updateWordTiming).toHaveBeenCalledWith("c1", {
        author: "local-editor",
        timings: [
          { id: "w1", start_ms: 140, end_ms: 350 },
          { id: "w2", start_ms: 360, end_ms: 480 },
          { id: "w3", start_ms: 490, end_ms: 800 },
        ],
      });
      expect(mocks.completeWordTimingReview).toHaveBeenCalledWith("c1", "w1", "local-editor");
      expect(within(list).getByRole("button", { name: /^I/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(within(list).getByLabelText("Palavra concluída")).toBeInTheDocument();
  });

  it("keeps an unsaved word draft accessible when autosave fails", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      {
        ...cue,
        words: [
          { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 350, pt: "Posso" },
          { id: "w2", order: 2, surface: "I", start_ms: 360, end_ms: 480, pt: "eu" },
        ],
      },
    ]);
    mocks.updateWordTiming.mockRejectedValueOnce(new Error("Falha ao salvar"));
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    const first = within(list).getByRole("button", { name: /Can/ });
    fireEvent.click(first);
    const player = screen.getByLabelText("Player do corte da cena") as HTMLVideoElement;
    Object.defineProperty(player, "currentTime", { configurable: true, value: 0.14, writable: true });
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: /Marcar início/ }));
    fireEvent.click(within(list).getByRole("button", { name: /^I/ }));
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: /^I/ }))
        .toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByText(/Rascunho preservado nesta sessão/, {
      selector: ".review-message",
    })).toBeInTheDocument();
    expect(within(list).getByLabelText("Rascunho não salvo")).toBeInTheDocument();
    fireEvent.click(first);
    await waitFor(() =>
      expect(first).toHaveAttribute("aria-pressed", "true"),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Sincronização da palavra selecionada"))
        .toHaveTextContent("0.14 s"),
    );
  });

  it("clicking the next word completes the previous even without edits", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      {
        ...cue,
        words: [
          { id: "w1", order: 1, surface: "Can", start_ms: 100, end_ms: 350, pt: "Posso" },
          { id: "w2", order: 2, surface: "I", start_ms: 360, end_ms: 480, pt: "eu" },
        ],
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "Palavras do cue selecionado" });
    fireEvent.click(within(list).getByRole("button", { name: /Can/ }));
    fireEvent.click(within(list).getByRole("button", { name: /^I/ }));
    await waitFor(() => {
      expect(mocks.completeWordTimingReview).toHaveBeenCalledWith("c1", "w1", "local-editor");
      expect(within(list).getByRole("button", { name: /^I/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(mocks.updateWordTiming).not.toHaveBeenCalled();
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

  it("immediately remaps child-word times in the cue timeline and persists the new parent interval", async () => {
    const cue = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      {
        ...cue,
        speech_timing: { start_ms: 100, end_ms: 1800 },
        subtitle_timing: { start_ms: 100, end_ms: 1800 },
        words: [
          { id: "w1", order: 1, surface: "First", start_ms: 100, end_ms: 600, pt: "Primeira" },
          { id: "w2", order: 2, surface: "Last", start_ms: 1100, end_ms: 1800, pt: "Última" },
        ],
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    await screen.findByLabelText("Player do corte da cena");
    const player = screen.getByLabelText("Player do corte da cena") as HTMLVideoElement;
    Object.defineProperty(player, "currentTime", {
      configurable: true,
      writable: true,
      value: 0.9,
    });
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: /Marcar IN/ }));
    const first = within(screen.getByRole("list", { name: "Palavras do cue selecionado" }))
      .getByRole("button", { name: /First/ });
    expect(first).toHaveTextContent("0.90");
    expect(screen.queryByText(/Palavra.*fora do cue/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() =>
      expect(mocks.updateCueTiming).toHaveBeenCalledWith("c1", {
        author: "local-editor",
        speech_timing: { start_ms: 900, end_ms: 1800 },
        subtitle_timing: { start_ms: 100, end_ms: 1800 },
      }),
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

  it("keeps navigation, approval and Cue/Word editing beside the waveform", async () => {
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const dock = await screen.findByRole("navigation", {
      name: "Controles da estação editorial",
    });
    expect(screen.getByRole("region", { name: "Área principal da waveform" }))
      .toBeInTheDocument();
    expect(within(dock).getByRole("button", { name: "Cue anterior" })).toBeDisabled();
    expect(within(dock).getByRole("button", { name: "Próximo cue" })).toBeDisabled();
    expect(within(dock).getByRole("button", { name: "Aprovar cue" })).toBeEnabled();
    const mode = within(dock).getByRole("group", { name: "Modo de edição" });
    expect(within(mode).getByRole("button", { name: "Cue" })).toHaveAttribute(
      "aria-pressed", "true",
    );
    fireEvent.click(within(mode).getByRole("button", { name: "Word" }));
    await waitFor(() =>
      expect(within(mode).getByRole("button", { name: "Word" }))
        .toHaveAttribute("aria-pressed", "true"),
    );
    fireEvent.click(within(mode).getByRole("button", { name: "Cue" }));
    await waitFor(() =>
      expect(within(mode).getByRole("button", { name: "Cue" }))
        .toHaveAttribute("aria-pressed", "true"),
    );
    const support = screen.getByRole("button", { name: "Ocultar painéis" });
    fireEvent.click(support);
    expect(screen.getByRole("button", { name: "Texto e ferramentas" }))
      .toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("editorial-support-panels")).toHaveAttribute("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Texto e ferramentas" }));
    expect(document.getElementById("editorial-support-panels")).not.toHaveAttribute("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Vídeo" }));
    expect(screen.getByRole("region", { name: "Área principal da waveform" }))
      .toHaveClass("is-video-hidden");
  });

  it("edits English and Portuguese next to the waveform with no panel navigation", async () => {
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const stage = await screen.findByRole("region", { name: "Área principal da waveform" });
    await waitFor(() =>
      expect(within(stage).getByText("“I can't… go?”")).toBeInTheDocument(),
    );
    fireEvent.click(within(stage).getByRole("button", { name: "Editar texto" }));
    fireEvent.change(within(stage).getByRole("textbox", { name: "Português rápido" }), {
      target: { value: "Eu não posso ir?" },
    });
    expect(within(stage).getByRole("textbox", { name: "Português rápido" }))
      .toHaveValue("Eu não posso ir?");
    const dock = screen.getByRole("navigation", { name: "Controles da estação editorial" });
    fireEvent.click(within(dock).getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() =>
      expect(mocks.updateCueText).toHaveBeenCalledWith("c1", {
        author: "local-editor",
        approved_en: "“I can't… go?”",
        approved_pt: "Eu não posso ir?",
        approve: false,
      }),
    );
    fireEvent.click(within(stage).getByRole("button", { name: "Recolher edição" }));
    expect(within(stage).getByText("Eu não posso ir?")).toBeInTheDocument();
  });

  it("opens the iHub preview at the focused cue with Ctrl+Enter without approving it", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const first = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      first,
      {
        ...first,
        id: "c2",
        order: 2,
        speech_timing: { start_ms: 1900, end_ms: 2000 },
        subtitle_timing: { start_ms: 1900, end_ms: 2000 },
        words: [{ id: "w2", order: 1, surface: "Later", start_ms: 1900, end_ms: 2000, pt: "Depois" }],
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    await screen.findByRole("navigation", { name: "Controles da estação editorial" });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Inglês aprovado" }))
        .toHaveValue("“I can't… go?”"),
    );
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(screen.getByText("Cue 2 de 2")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    const preview = await screen.findByRole("dialog", { name: "Vídeo e legendas sincronizadas" });
    const video = within(preview).getByLabelText("Prévia do vídeo no iHub") as HTMLVideoElement;
    expect(video.currentTime).toBeCloseTo(1.9);
    expect(mocks.updateCueText).not.toHaveBeenCalled();
  });

  it("opens the synchronized iHub preview from zero with Ctrl+Shift+Enter", async () => {
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
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, shiftKey: true });
    const preview = await screen.findByRole("dialog", { name: "Vídeo e legendas sincronizadas" });
    expect(preview).toBeInTheDocument();
    const video = screen.getByLabelText("Prévia do vídeo no iHub") as HTMLVideoElement;
    expect(video).toHaveAttribute("src", "/api/cut.wav");
    expect(video.currentTime).toBe(0);
    expect(screen.getByRole("button", { name: "Dual" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens Ctrl+Enter preview at zero when there is no focused cue", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    mocks.editorialCues.mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mocks.editorialCues).toHaveBeenCalledWith("s1"));
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    const preview = await screen.findByRole("dialog", { name: "Vídeo e legendas sincronizadas" });
    expect((within(preview).getByLabelText("Prévia do vídeo no iHub") as HTMLVideoElement).currentTime)
      .toBe(0);
  });

  it("transfers a word when both dragged edges enter the previous cue", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const first = (await mocks.editorialCues())[0];
    const previous = {
      ...first,
      approved_en: "Hello",
      original_en: "Hello",
      speech_timing: { start_ms: 100, end_ms: 1000 },
      subtitle_timing: { start_ms: 100, end_ms: 1000 },
      words: [{ id: "w1", order: 1, surface: "Hello", start_ms: 100, end_ms: 250, pt: "Olá" }],
    };
    const current = {
      ...first,
      id: "c2",
      order: 2,
      original_en: "look now",
      approved_en: "look now",
      approved_pt: "Olha agora",
      speech_timing: { start_ms: 1100, end_ms: 2000 },
      subtitle_timing: { start_ms: 1100, end_ms: 2000 },
      words: [
        { id: "w2", order: 1, surface: "look", start_ms: 1200, end_ms: 1400, pt: "olha" },
        { id: "w3", order: 2, surface: " now", start_ms: 1500, end_ms: 1900, pt: "agora" },
      ],
    };
    mocks.editorialCues.mockResolvedValueOnce([previous, current]).mockResolvedValue([
      { ...previous, approved_en: "Hello look", words: [...previous.words, { ...current.words[0], start_ms: 400, end_ms: 650 }] },
      { ...current, approved_en: "now", words: [{ ...current.words[1], surface: "now", order: 1 }] },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    await screen.findByText("Cue 1 de 2");
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    await screen.findByText("Cue 2 de 2");
    fireEvent.click(screen.getByRole("button", { name: /Palavra 1: look,/ }));
    fireEvent.click(screen.getByText("Zoom, ajuste em milissegundos e outros controles"));
    fireEvent.click(screen.getByRole("button", { name: "Ver cena toda" }));
    const svg = screen.getByRole("img", { name: "Waveform, cues e tempos das palavras" });
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0, width: 1000, top: 0, height: 210, right: 1000, bottom: 210, x: 0, y: 0,
      toJSON: () => ({}),
    });
    function dragEdge(index: number, clientX: number) {
      const handle = document.querySelectorAll(".timeline-edge-hit")[index] as SVGElement;
      handle.setPointerCapture = vi.fn();
      fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX }));
      fireEvent(svg, new MouseEvent("pointermove", { bubbles: true, clientX }));
      fireEvent(svg, new MouseEvent("pointerup", { bubbles: true, clientX }));
    }
    dragEdge(0, 200);
    expect(mocks.transferWordToAdjacentCue).not.toHaveBeenCalled();
    dragEdge(1, 325);
    await waitFor(() => expect(mocks.transferWordToAdjacentCue).toHaveBeenCalledWith(
      "c2", "w2", 400, 650, 1, "local-editor",
    ));
    await waitFor(() => expect(screen.getByText("Cue 1 de 2")).toBeInTheDocument());
  });

  it("returns from the iHub preview to the exact cue in editable Cue mode", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const first = (await mocks.editorialCues())[0];
    mocks.editorialCues.mockResolvedValue([
      first,
      {
        ...first,
        id: "c2",
        order: 2,
        original_en: "Next cue!",
        approved_en: "Next cue!",
        approved_pt: "Próxima fala!",
        speech_timing: { start_ms: 1900, end_ms: 2000 },
        subtitle_timing: { start_ms: 1900, end_ms: 2000 },
        words: [{ id: "w2", order: 1, surface: "Next cue!", start_ms: 1900, end_ms: 2000, pt: "Próxima fala!" }],
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/editorial?project=p1"]}>
        <EditorialPage />
      </MemoryRouter>,
    );
    const openPreview = await screen.findByRole("button", { name: "Prévia no iHub" });
    await waitFor(() => expect(openPreview).toBeEnabled());
    fireEvent.click(openPreview);
    const preview = await screen.findByRole("dialog", { name: "Vídeo e legendas sincronizadas" });
    const video = within(preview).getByLabelText("Prévia do vídeo no iHub") as HTMLVideoElement;
    video.currentTime = 1.95;
    fireEvent.timeUpdate(video);
    fireEvent.click(within(preview).getByRole("button", { name: "Editar cue" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const quickEditor = await screen.findByRole("textbox", { name: "Inglês rápido" });
    await waitFor(() => expect(quickEditor).toHaveFocus());
    expect(quickEditor).toHaveValue("Next cue!");
    expect(screen.getByText("Cue 2 de 2")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Modo de edição" }))
      .getByRole("button", { name: "Cue" })).toHaveAttribute("aria-pressed", "true");
  });
});
