import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    cache_status: "reused",
    job_status: "idle",
  },
  media: {
    state: "ready_for_review",
    current_step: "review",
    can_start: false,
    can_cut: true,
    can_review: true,
    review_url: "/editorial?project=p1",
    source_ready: true,
    source_url: "/api/projects/p1/media/source",
    duration_ms: 90_000,
    download_job_id: null,
    download_status: null,
    download_error: null,
    ingest_job_id: "job-2",
    ingest_status: "succeeded",
    ingest_error: null,
    cut_url: "/api/projects/p1/media/cuts/job-2",
    cut_start_ms: 0,
    cut_end_ms: 60_000,
    waveform: { sample_rate_hz: 8000, bucket_ms: 40, peaks: [0.1, 0.4, 0.8] },
    transcript_candidate: {
      engine: "faster-whisper",
      model: "small",
      language: "en",
      cues: [{ start_ms: 100, end_ms: 700, text: "Café?", words: [] }],
    },
  },
  download: vi.fn().mockResolvedValue({ id: "job-1", status: "queued" }),
  start: vi.fn().mockResolvedValue({}),
  ingest: vi.fn().mockResolvedValue({ id: "job-3", status: "queued" }),
}));
vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    projects: vi.fn().mockResolvedValue([fixtures.project]),
    projectMedia: vi.fn().mockResolvedValue(fixtures.media),
    projectSourceWaveform: vi.fn().mockResolvedValue({
      sample_rate_hz: 8000,
      bucket_ms: 20,
      peaks: [0.1, 0.5, 0.9, 0.3],
    }),
    downloadProjectMedia: fixtures.download,
    startProjectMedia: fixtures.start,
    ingestProjectMedia: fixtures.ingest,
  },
}));

describe("MediaPage", () => {
  it("plays project media and shows real waveform and ASR candidate", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <MediaPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("img", { name: "Waveform extraída do corte", hidden: true }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("img", { name: "Waveform da fonte com intervalo de corte" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Player da fonte de vídeo")).toHaveAttribute(
      "src",
      fixtures.media.source_url,
    );
    expect(screen.getByText("Café?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Revisar legenda" })).toHaveAttribute(
      "href",
      "/editorial?project=p1",
    );
    fireEvent.change(screen.getByLabelText("Início do corte em segundos"), {
      target: { value: "1" },
    });
    expect(screen.getByLabelText("Início do corte em segundos")).toHaveValue(1);
    fireEvent.click(screen.getByRole("button", { name: "Extrair corte e transcrever" }));
    await waitFor(() =>
      expect(fixtures.ingest).toHaveBeenCalledWith("p1", {
        start_ms: 1000,
        end_ms: 60_000,
        language: "en",
      }),
    );
  });
});
