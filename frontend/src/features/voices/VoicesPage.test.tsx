import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { studioApi } from "../../lib/studio-api";
import { VoicesPage } from "./VoicesPage";

const profile = {
  id: "voice-1",
  name: "Ana",
  version: 2,
  model_id: "chatterbox-nano",
  model_sha256: "a".repeat(64),
  reference_audio_sha256: null,
  parameters: {},
  snapshot_sha256: "b".repeat(64),
  preview_url: "/api/voices/voice-1/versions/2/preview",
  preview_ready: true,
};

vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    voices: vi.fn(),
    createVoice: vi.fn(),
    createVoiceVersion: vi.fn(),
  },
}));

describe("VoicesPage", () => {
  it("shows the selected version and its canonical preview", async () => {
    vi.mocked(studioApi.voices).mockResolvedValue([profile]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <VoicesPage />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Ana v2/ }));
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByLabelText("Prévia da voz Ana")).toHaveAttribute("src", profile.preview_url);
  });
});
