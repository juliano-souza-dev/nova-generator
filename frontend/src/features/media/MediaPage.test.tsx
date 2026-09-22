import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MediaPage } from "./MediaPage";

const fixtures = vi.hoisted(() => ({
  project: {
    id: "p1",
    title: "Cena café",
    content_type: "dialogue",
    archived: false,
    youtube_url: "https://youtu.be/dQw4w9WgXcQ",
    youtube_video_id: "dQw4w9WgXcQ",
    cache_status: "missing" as const,
    job_status: "idle",
  },
  enqueueJob: vi.fn().mockResolvedValue({ id: "job-1", status: "queued", attempt: 0 }),
}));
vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    projects: vi.fn().mockResolvedValue([fixtures.project]),
    enqueueJob: fixtures.enqueueJob,
  },
}));

describe("MediaPage", () => {
  it("enqueues download and supports keyboard-native cut handles", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <MediaPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("img", { name: "Waveform da fonte e intervalo selecionado" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Baixar fonte" }));
    expect(await screen.findByText(/Job job-1 está queued/)).toBeInTheDocument();
    const start = screen.getByLabelText("Handle de início") as HTMLInputElement;
    fireEvent.change(start, { target: { value: "1000" } });
    expect(screen.getByLabelText("Início do corte em milissegundos")).toHaveValue(1000);
  });
});
