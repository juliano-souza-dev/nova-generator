import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "./ProjectsPage";

vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    projects: vi.fn().mockResolvedValue([]),
    inspectYoutubeSource: vi.fn().mockResolvedValue({
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      youtube_video_id: "dQw4w9WgXcQ",
      title: "Título real — café?",
      channel: "Canal",
    }),
    createProject: vi.fn(),
    duplicateProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    deleteProject: vi.fn(),
  },
}));

describe("ProjectsPage", () => {
  it("requires and verifies the URL while leaving the production title optional", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Novo projeto" }));
    expect(screen.getByLabelText(/Título/)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Criar projeto" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("URL do YouTube"), {
      target: { value: "https://youtu.be/dQw4w9WgXcQ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verificar vídeo" }));
    expect(await screen.findByText("Título real — café?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar projeto" })).toBeEnabled();
  });
});
