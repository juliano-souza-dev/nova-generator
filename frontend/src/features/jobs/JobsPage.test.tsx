import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JobsPage } from "./JobsPage";

const fixture = vi.hoisted(() => ({
  job: {
    id: "job-1",
    kind: "render.story",
    status: "failed",
    attempt: 3,
    max_attempts: 3,
    input: {},
    error_message: "FFmpeg falhou",
    created_at: "2026-09-22T10:00:00Z",
    started_at: "2026-09-22T10:00:01Z",
    finished_at: "2026-09-22T10:00:04Z",
    heartbeat_at: null,
    cancel_requested_at: null,
    can_cancel: false,
    can_retry: true,
  },
}));
vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    jobs: vi.fn().mockResolvedValue({ items: [fixture.job], offset: 0, limit: 25, total: 1 }),
    job: vi.fn().mockResolvedValue({
      ...fixture.job,
      events: [
        {
          type: "failed",
          occurred_at: "2026-09-22T10:00:04Z",
          message: "Job finalizado: failed",
        },
      ],
    }),
    cancelJob: vi.fn(),
    retryJob: vi.fn().mockResolvedValue(fixture.job),
  },
}));

describe("JobsPage", () => {
  it("shows a job error and its retry action", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <JobsPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("render.story")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Repetir render.story" }));
    expect(await screen.findByRole("button", { name: "Repetir render.story" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("render.story"));
    expect(await screen.findByText("FFmpeg falhou")).toBeInTheDocument();
  });
});
