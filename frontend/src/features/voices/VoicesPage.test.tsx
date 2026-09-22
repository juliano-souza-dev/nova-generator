import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    voiceModel: vi.fn(),
    voiceReferences: vi.fn(),
    uploadVoiceReference: vi.fn(),
    createVoice: vi.fn(),
    createVoiceVersion: vi.fn(),
  },
}));

describe("VoicesPage", () => {
  it("shows the selected version and its canonical preview", async () => {
    vi.mocked(studioApi.voices).mockResolvedValue([profile]);
    vi.mocked(studioApi.voiceModel).mockResolvedValue({
      available: true,
      model_sha256: "a".repeat(64),
    });
    vi.mocked(studioApi.voiceReferences).mockResolvedValue([]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <VoicesPage />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Ana v2/ }));
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByLabelText("Prévia da voz Ana")).toHaveAttribute("src", profile.preview_url);
  });

  it("uploads a WAV and creates a profile without asking for hashes", async () => {
    const digest = "c".repeat(64);
    vi.mocked(studioApi.voices).mockResolvedValue([]);
    vi.mocked(studioApi.voiceModel).mockResolvedValue({
      available: true,
      model_sha256: "a".repeat(64),
    });
    vi.mocked(studioApi.voiceReferences).mockResolvedValue([]);
    vi.mocked(studioApi.uploadVoiceReference).mockResolvedValue({
      sha256: digest,
      duration_ms: 2000,
      sample_rate: 16000,
      channels: 1,
      size_bytes: 64044,
      audio_url: `/api/voices/references/${digest}`,
    });
    vi.mocked(studioApi.createVoice).mockResolvedValue({
      ...profile,
      reference_audio_sha256: digest,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <VoicesPage />
      </QueryClientProvider>,
    );
    await screen.findByText("Modelo Chatterbox Nano disponível.");
    fireEvent.change(screen.getByLabelText("Enviar WAV de referência (1 a 30 segundos)"), {
      target: { files: [new File(["wav"], "speaker.wav", { type: "audio/wav" })] },
    });
    await waitFor(() => expect(studioApi.uploadVoiceReference).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText("Narradora Ana"), {
      target: { value: "Nova voz" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Criar e sintetizar prévia/ }));
    await waitFor(() =>
      expect(studioApi.createVoice).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Nova voz",
          reference_audio_sha256: digest,
          model_sha256: undefined,
        }),
      ),
    );
  });
});
