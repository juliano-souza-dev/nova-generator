import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TikTokMediaPage } from "./TikTokMediaPage";

const fixture = vi.hoisted(() => ({
  production: {
    contract: "nova-tiktok-media/1" as const,
    id: "independent-1",
    title: "My first video",
    format: "lyrics_video" as const,
    theme: "ihub" as const,
    revision: 3,
    source_project_id: null,
    source_scene_id: null,
    source_youtube_id: "dQw4w9WgXcQ",
    source_cut_job_id: "cut-1",
    video_captions: [
      {
        cue_id: "c1",
        start_ms: 0,
        end_ms: 1500,
        en: "Let's begin.",
        pt: "Vamos começar.",
        highlight: "",
        note: "",
        enabled: true,
      },
      {
        cue_id: "c2",
        start_ms: 2000,
        end_ms: 3500,
        en: "Stay with me.",
        pt: "Fique comigo.",
        highlight: "",
        note: "",
        enabled: true,
      },
    ],
    caption_style: {
      template: "clean" as const,
      position: "bottom" as const,
      animation: "fade" as const,
      text_scale: 1,
      text_color: "#FFFFFF",
    },
    slides: [
      {
        id: "s1",
        kind: "lyric" as const,
        heading: "Lyric",
        en: "",
        pt: "",
        note: "",
        highlight: "",
        speaker: "",
        duration_ms: 4000,
      },
    ],
    audio_filename: null,
  },
}));

vi.mock("./slide-canvas", () => ({ paintSlide: vi.fn(), imageForSlide: vi.fn() }));
vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    projects: vi.fn().mockResolvedValue([]),
    voices: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("./tiktok-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tiktok-api")>();
  return {
    ...actual,
    mediaApi: {
      ...actual.mediaApi,
      list: vi.fn().mockResolvedValue([fixture.production]),
      get: vi.fn().mockResolvedValue(fixture.production),
      sourceStatus: vi.fn().mockResolvedValue({
        source_ready: true,
        duration_ms: 4000,
        download_status: "succeeded",
        download_error: null,
        ingest_status: "succeeded",
        ingest_job_id: "cut-1",
        ingest_error: null,
      }),
    },
  };
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

function renderStudio() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <TikTokMediaPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TikTok Media focused workstation", () => {
  it("offers creation modes and activates progressive music subtitles", async () => {
    renderStudio();
    await screen.findByRole("button", { name: "Editar fala 1 em 00:00.0" });
    expect(screen.getByRole("button", { name: /Música.*Clique para animar/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /Música.*Clique para animar/ }));
    expect(screen.getByLabelText("Estilo das legendas")).toHaveValue("karaoke");
    expect(screen.getByText(/As palavras ganham cor/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Diálogos.*Falas com tradução/ }));
    expect(screen.getByLabelText("Estilo das legendas")).toHaveValue("clean");
    fireEvent.click(screen.getByRole("button", { name: /Mini-aula.*Destaque educativo/ }));
    expect(screen.getByLabelText("Estilo das legendas")).toHaveValue("impact");
  });

  it("applies handwritten, neon and pop effects to the current production", async () => {
    renderStudio();
    await screen.findByRole("button", { name: "Editar fala 1 em 00:00.0" });
    fireEvent.click(screen.getByRole("button", { name: /Visual/ }));
    fireEvent.click(screen.getByRole("button", { name: /Escrita à mão/ }));
    expect(screen.getByLabelText("Estilo das legendas")).toHaveValue("handwriting");
    expect(screen.getByText(/Um lápis acompanha/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Neon Beat/ }));
    expect(screen.getByLabelText("Estilo das legendas")).toHaveValue("neon");
    fireEvent.click(screen.getByRole("button", { name: /Pop Star/ }));
    expect(screen.getByLabelText("Estilo das legendas")).toHaveValue("popstar");
  });

  it("keeps only one source tool and one inspector tool visible at a time", async () => {
    renderStudio();
    await screen.findByRole("button", { name: "Editar fala 1 em 00:00.0" });

    expect(screen.getByLabelText("URL do YouTube para preparar a fonte")).toBeInTheDocument();
    expect(screen.queryByText("Reaproveitar material")).not.toBeInTheDocument();
    expect(screen.queryByText("Configurações da produção")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Inglês/)).toHaveValue("Let's begin.");

    fireEvent.click(screen.getByRole("button", { name: /Visual/ }));
    expect(screen.getByLabelText("Estilo das legendas")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Inglês/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Exportar/ }));
    expect(screen.getByRole("button", { name: "Gerar vídeo com legendas" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Estilo das legendas")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Projeto" }));
    expect(screen.getByLabelText(/Título do projeto/)).toHaveValue("My first video");

    fireEvent.click(screen.getByRole("button", { name: /Importar/ }));
    expect(screen.getByText("Reaproveitar material")).toBeInTheDocument();
    expect(screen.queryByLabelText("URL do YouTube para preparar a fonte")).not.toBeInTheDocument();
  });

  it("opens the selected caption in its contextual inspector", async () => {
    renderStudio();
    const second = await screen.findByRole("button", { name: "Editar fala 2 em 00:02.0" });
    fireEvent.click(screen.getByRole("button", { name: /Visual/ }));
    fireEvent.click(second);
    await waitFor(() => expect(screen.getByLabelText(/Inglês/)).toHaveValue("Stay with me."));
    expect(screen.getByLabelText(/Tradução/)).toHaveValue("Fique comigo.");
  });
});
