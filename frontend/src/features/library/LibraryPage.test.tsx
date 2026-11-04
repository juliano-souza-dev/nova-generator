import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { LibraryPage } from "./LibraryPage";

const fixture = vi.hoisted(() => ({
  library: vi.fn().mockResolvedValue([
    {
      project_id: "5d91af52-bb66-40b0-81f9-09147e14e338",
      render_id: "52d59a0e-99c2-49b9-b0e9-e4911dc6c713",
      title: "SEE, LOOK e WATCH 🎬",
      format: "lesson_video",
      visual_mode: "slides",
      duration_ms: 69500,
      size_bytes: 10485760,
      completed_at: "2026-11-03T20:00:00Z",
    },
  ]),
}));
vi.mock("../tiktok-media/tiktok-api", () => ({
  mediaApi: {
    library: fixture.library,
    videoUrl: (project: string, render: string) =>
      "/api/tiktok-media/projects/" + project + "/renders/" + render + "/video",
    videoDownloadUrl: (project: string, render: string) =>
      "/api/tiktok-media/projects/" + project + "/renders/" + render + "/video?download=true",
  },
}));

describe("LibraryPage", () => {
  it("shows a previously finished video with replay, download and project access", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <LibraryPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: "SEE, LOOK e WATCH 🎬" })).toBeInTheDocument();
    expect(screen.getByLabelText("Assistir SEE, LOOK e WATCH 🎬")).toHaveAttribute(
      "src",
      expect.stringContaining("/renders/52d59a0e-99c2-49b9-b0e9-e4911dc6c713/video"),
    );
    expect(screen.getByRole("link", { name: "Baixar MP4" })).toHaveAttribute(
      "href",
      expect.stringContaining("download=true"),
    );
    expect(screen.getByRole("link", { name: "Abrir produção" })).toHaveAttribute(
      "href",
      "/tiktok-media?project=5d91af52-bb66-40b0-81f9-09147e14e338",
    );
    expect(screen.getByText(/1 vídeos finalizados/)).toBeInTheDocument();
  });
});
