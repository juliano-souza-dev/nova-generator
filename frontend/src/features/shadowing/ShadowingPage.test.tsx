import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShadowingPlan } from "../../lib/api.types";
import { studioApi } from "../../lib/studio-api";
import { ShadowingPage } from "./ShadowingPage";

vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    projects: vi.fn(),
    shadowing: vi.fn(),
    projectMedia: vi.fn(),
    generateShadowing: vi.fn(),
    editShadowing: vi.fn(),
    approveShadowing: vi.fn(),
    importShadowing: vi.fn(),
    shadowingPackageUrl: vi.fn(),
  },
}));

const cues = [
  {
    id: "cue-1",
    order: 1,
    speaker: "Mike",
    start_ms: 1000,
    end_ms: 1900,
    en: "Hello.",
    pt: "Olá.",
    eligible: true,
  },
  {
    id: "cue-2",
    order: 2,
    speaker: "Donna",
    start_ms: 2000,
    end_ms: 2600,
    en: "What?",
    pt: "O quê?",
    eligible: true,
  },
  {
    id: "cue-3",
    order: 3,
    speaker: "Mike",
    start_ms: 3000,
    end_ms: 4100,
    en: "Come here.",
    pt: "Venha aqui.",
    eligible: true,
  },
  {
    id: "cue-4",
    order: 4,
    speaker: "Mike",
    start_ms: 4300,
    end_ms: 4900,
    en: "Right now!",
    pt: "Agora mesmo!",
    eligible: true,
  },
];

const plan: ShadowingPlan = {
  contract: "nova-generator-shadowing/2.0",
  project_id: "project-1",
  scene_id: "scene-1",
  source_sha256: "a".repeat(64),
  plan_sha256: "b".repeat(64),
  duration_ms: 6000,
  status: "draft",
  origin: "automatic",
  source_cues: cues,
  excluded_cues: [{ ...cues[1], reason: "Não selecionado para esta prática" }],
  blocks: [
    {
      id: "block-1",
      cue_ids: ["cue-1"],
      speaker: "Mike",
      word_count: 1,
      start_ms: 1000,
      end_ms: 1900,
      pause_duration_ms: 2500,
      en: "Hello.",
      pt: "Olá.",
    },
    {
      id: "block-2",
      cue_ids: ["cue-3", "cue-4"],
      speaker: "Mike",
      word_count: 4,
      start_ms: 3000,
      end_ms: 4900,
      pause_duration_ms: 3500,
      en: "Come here. Right now!",
      pt: "Venha aqui. Agora mesmo!",
    },
  ],
};

function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={["/shadowing?project=project-1"]}>
        <ShadowingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ShadowingPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.mocked(studioApi.projects).mockResolvedValue([
      { id: "project-1", title: "Dialogue" } as never,
    ]);
    vi.mocked(studioApi.shadowing).mockResolvedValue([plan]);
    vi.mocked(studioApi.projectMedia).mockResolvedValue({ cut_url: "/video.mp4" } as never);
    vi.mocked(studioApi.shadowingPackageUrl).mockReturnValue("/shadowing-package.json");
    vi.mocked(studioApi.editShadowing).mockResolvedValue({ ...plan, origin: "manual" });
    vi.mocked(studioApi.generateShadowing).mockResolvedValue({
      ...plan,
      origin: "groq",
    });
    vi.mocked(studioApi.importShadowing).mockResolvedValue({
      ...plan,
      origin: "external",
    });
  });

  it("shows short speaker-specific practices and the separate AI preparation step", async () => {
    mount();
    expect(
      await screen.findByRole("heading", { name: "Montar prática com IA" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerar proposta com IA" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Outras opções" }));
    expect(screen.getByRole("link", { name: "Baixar pacote para IA externa" })).toHaveAttribute(
      "href",
      "/shadowing-package.json",
    );
    expect(screen.getByText("Prática 1 · Mike")).toBeInTheDocument();
    expect(screen.getByText("Prática 2 · Mike")).toBeInTheDocument();
    expect(screen.getByText("Cue 2 · Donna")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aprovar Shadowing" })).toBeDisabled();
  });

  it("exposes bulk approval but keeps it disabled until every scene is reviewed", async () => {
    mount();
    const approveAll = await screen.findByRole("button", {
      name: "Aprovar todas as cenas",
    });
    expect(approveAll).toBeDisabled();
    await screen.findByText("0 de 1 cenas aprovadas");
    expect(approveAll.parentElement).toHaveAttribute(
      "title",
      "Revise a prévia e os personagens de todas as cenas antes de aprovar",
    );
    expect(studioApi.approveShadowing).not.toHaveBeenCalled();
  });

  it("shows project approval progress and keyboard shortcuts", async () => {
    mount();
    expect(await screen.findByText("0 de 1 cenas aprovadas")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Etapas do Shadowing" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver atalhos de teclado" }));
    expect(screen.getByRole("dialog", { name: "Atalhos de teclado" })).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Z / Cmd+Z")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Atalhos de teclado" })).not.toBeInTheDocument();
  });

  it("filters cues by accents without editing source cues", async () => {
    mount();
    await screen.findByText("Cue 2 · Donna");
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar cues" }), {
      target: { value: "QUE" },
    });
    expect(screen.getByText("1 de 1 cues disponíveis")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar cues" }), {
      target: { value: "inexistente" },
    });
    expect(screen.getByText("Nenhum cue encontrado com esses filtros.")).toBeInTheDocument();
    expect(studioApi.editShadowing).not.toHaveBeenCalled();
  });

  it("uses J and Delete shortcuts to edit the currently selected practice", async () => {
    mount();
    await screen.findByText("Prática 2 · Mike");
    fireEvent.keyDown(document, { key: "j" });
    expect(document.getElementById("shadowing-block-1")).toHaveAttribute("aria-current", "true");
    fireEvent.keyDown(document, { key: "Delete" });
    await waitFor(() =>
      expect(studioApi.editShadowing).toHaveBeenCalledWith(
        "project-1",
        "scene-1",
        plan.source_sha256,
        plan.plan_sha256,
        [["cue-1"]],
      ),
    );
  });

  it("ignores destructive shortcuts while typing in a search field", async () => {
    mount();
    await screen.findByText("Prática 1 · Mike");
    const search = screen.getByRole("searchbox", { name: "Buscar cues" });
    fireEvent.keyDown(search, { key: "Delete" });
    expect(studioApi.editShadowing).not.toHaveBeenCalled();
  });

  it("synchronizes deletion and undo with the existing edit endpoint", async () => {
    let latest = plan;
    vi.mocked(studioApi.shadowing).mockImplementation(async () => [latest]);
    vi.mocked(studioApi.editShadowing).mockImplementation(
      async (_project, _scene, _source, _hash, groups) => {
        latest = {
          ...plan,
          plan_sha256: latest.plan_sha256 === plan.plan_sha256 ? "c".repeat(64) : "d".repeat(64),
          blocks: groups.map((group, index) => ({
            ...plan.blocks.find((item) => item.cue_ids.includes(group[0]))!,
            id: `block-${index + 1}`,
            cue_ids: group,
          })),
          excluded_cues: groups.flat().includes("cue-1")
            ? plan.excluded_cues
            : [...plan.excluded_cues, { ...cues[0], reason: "Omitido" }],
        };
        return latest;
      },
    );
    mount();
    await screen.findByText("Prática 1 · Mike");
    fireEvent.click(screen.getAllByRole("button", { name: "Excluir grupo" })[0]);
    await waitFor(() => expect(studioApi.editShadowing).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Grupo excluído/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Desfazer" }).at(-1)!);
    await waitFor(() => expect(studioApi.editShadowing).toHaveBeenCalledTimes(2));
    expect(studioApi.editShadowing).toHaveBeenLastCalledWith(
      "project-1",
      "scene-1",
      plan.source_sha256,
      "c".repeat(64),
      [["cue-1"], ["cue-3", "cue-4"]],
    );
  });

  it("lets the user remove an in-use cue from its practice", async () => {
    mount();
    await screen.findByText("Prática 1 · Mike");
    fireEvent.click(screen.getByText("Usados em outras práticas (3)"));
    expect(screen.getByText("Em prática 1")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Remover da prática" })[0]);
    await waitFor(() =>
      expect(studioApi.editShadowing).toHaveBeenCalledWith(
        "project-1",
        "scene-1",
        plan.source_sha256,
        plan.plan_sha256,
        [["cue-3", "cue-4"]],
      ),
    );
  });

  it("deletes a group without touching the editorial cues", async () => {
    mount();
    await screen.findByText("Prática 1 · Mike");
    fireEvent.click(screen.getAllByRole("button", { name: "Excluir grupo" })[0]);
    await waitFor(() =>
      expect(studioApi.editShadowing).toHaveBeenCalledWith(
        "project-1",
        "scene-1",
        plan.source_sha256,
        plan.plan_sha256,
        [["cue-3", "cue-4"]],
      ),
    );
  });

  it("allows separating a grouped practice at a cue boundary", async () => {
    mount();
    await screen.findByText("Prática 2 · Mike");
    fireEvent.click(screen.getByRole("button", { name: "Separar após cue 3" }));
    await waitFor(() =>
      expect(studioApi.editShadowing).toHaveBeenCalledWith(
        "project-1",
        "scene-1",
        plan.source_sha256,
        plan.plan_sha256,
        [["cue-1"], ["cue-3"], ["cue-4"]],
      ),
    );
  });

  it("restores a selected short cue at its original editorial order", async () => {
    mount();
    await screen.findByText("Cue 2 · Donna");
    fireEvent.click(screen.getByRole("button", { name: "Adicionar" }));
    await waitFor(() =>
      expect(studioApi.editShadowing).toHaveBeenCalledWith(
        "project-1",
        "scene-1",
        plan.source_sha256,
        plan.plan_sha256,
        [["cue-1"], ["cue-2"], ["cue-3", "cue-4"]],
      ),
    );
  });

  it("joins adjacent short cues from the same speaker", async () => {
    vi.mocked(studioApi.shadowing).mockResolvedValue([
      {
        ...plan,
        blocks: [
          {
            ...plan.blocks[1],
            id: "block-1",
            cue_ids: ["cue-3"],
            end_ms: 4100,
            en: "Come here.",
            pt: "Venha aqui.",
            word_count: 2,
          },
          {
            ...plan.blocks[1],
            id: "block-2",
            cue_ids: ["cue-4"],
            start_ms: 4300,
            en: "Right now!",
            pt: "Agora mesmo!",
            word_count: 2,
          },
        ],
        excluded_cues: [cues[0], cues[1]].map((cue) => ({
          ...cue,
          reason: "Não selecionado",
        })),
      },
    ]);
    mount();
    const merge = await screen.findAllByRole("button", { name: "Juntar com próxima" });
    expect(merge[0]).toBeEnabled();
    fireEvent.click(merge[0]);
    await waitFor(() =>
      expect(studioApi.editShadowing).toHaveBeenCalledWith(
        "project-1",
        "scene-1",
        plan.source_sha256,
        plan.plan_sha256,
        [["cue-3", "cue-4"]],
      ),
    );
  });

  it("disables merging noncontiguous cues even when both speakers are the same", async () => {
    mount();
    await screen.findByText("Prática 1 · Mike");
    expect(screen.getAllByRole("button", { name: "Juntar com próxima" })[0]).toBeDisabled();
    expect(studioApi.editShadowing).not.toHaveBeenCalled();
  });

  it("generates with Groq and can import a separate external AI proposal", async () => {
    mount();
    const generate = await screen.findByRole("button", { name: "Gerar proposta com IA" });
    fireEvent.click(generate);
    await waitFor(() =>
      expect(studioApi.generateShadowing).toHaveBeenCalledWith("project-1", "scene-1"),
    );
    const file = new File(['{"groups":[]}'], "proposal.json", { type: "application/json" });
    fireEvent.click(screen.getByRole("button", { name: "Outras opções" }));
    fireEvent.change(screen.getByLabelText("Importar proposta (.json)"), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(studioApi.importShadowing).toHaveBeenCalledWith("project-1", "scene-1", file),
    );
  });
});
