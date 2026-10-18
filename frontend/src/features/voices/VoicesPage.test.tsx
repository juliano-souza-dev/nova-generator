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
      duration_ms: 7000,
      sample_rate: 16000,
      channels: 1,
      size_bytes: 224044,
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
    await screen.findByText("Modelo Chatterbox Turbo disponível.");
    fireEvent.change(screen.getByLabelText("Enviar áudio de referência (6 a 30 segundos)"), {
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

  it("accepts a WAV dropped on the area and automatically selects the uploaded reference", async () => {
    const digest = "d".repeat(64);
    vi.mocked(studioApi.uploadVoiceReference).mockClear();
    vi.mocked(studioApi.voices).mockResolvedValue([]);
    vi.mocked(studioApi.voiceModel).mockResolvedValue({
      available: true,
      model_sha256: "a".repeat(64),
    });
    const reference = {
      sha256: digest,
      duration_ms: 7000,
      sample_rate: 16000,
      channels: 1,
      size_bytes: 224044,
      audio_url: `/api/voices/references/${digest}`,
    };
    let uploaded = false;
    vi.mocked(studioApi.voiceReferences).mockImplementation(async () =>
      uploaded ? [reference] : [],
    );
    vi.mocked(studioApi.uploadVoiceReference).mockImplementation(async () => {
      uploaded = true;
      return reference;
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <VoicesPage />
      </QueryClientProvider>,
    );

    const zone = screen.getByTestId("voice-reference-dropzone");
    const wav = new File(["wav"], "minha-voz.WAV", { type: "audio/wav" });
    fireEvent.dragEnter(zone, { dataTransfer: { files: [wav] } });
    expect(zone).toHaveClass("is-dragging");
    expect(screen.getByText("Solte o áudio aqui")).toBeInTheDocument();
    fireEvent.drop(zone, { dataTransfer: { files: [wav] } });

    await waitFor(() => {
      expect(studioApi.uploadVoiceReference).toHaveBeenCalledWith(wav, expect.anything());
      expect(screen.getByLabelText("Áudio de referência")).toHaveValue(digest);
    });
    expect(zone).not.toHaveClass("is-dragging");
    expect(screen.getByText(/Arquivo selecionado: minha-voz.WAV/)).toBeInTheDocument();
  });

  it.each([
    ["sample.mp3", "audio/mpeg"],
    ["sample.ogg", "audio/ogg"],
  ])("accepts %s dropped into the upload area", async (filename, type) => {
    const digest = "f".repeat(64);
    const reference = {
      sha256: digest,
      duration_ms: 7000,
      sample_rate: 24000,
      channels: 1,
      size_bytes: 336044,
      audio_url: `/api/voices/references/${digest}`,
    };
    vi.mocked(studioApi.voices).mockResolvedValue([]);
    vi.mocked(studioApi.voiceModel).mockResolvedValue({
      available: true,
      model_sha256: "a".repeat(64),
    });
    vi.mocked(studioApi.voiceReferences).mockResolvedValue([reference]);
    vi.mocked(studioApi.uploadVoiceReference).mockClear();
    vi.mocked(studioApi.uploadVoiceReference).mockResolvedValue(reference);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <VoicesPage />
      </QueryClientProvider>,
    );
    const file = new File(["encoded audio"], filename, { type });
    fireEvent.drop(screen.getByTestId("voice-reference-dropzone"), {
      dataTransfer: { files: [file] },
    });
    await waitFor(() =>
      expect(studioApi.uploadVoiceReference).toHaveBeenCalledWith(file, expect.anything()),
    );
    await waitFor(() => expect(screen.getByLabelText("Áudio de referência")).toHaveValue(digest));
  });

  it("blocks previously stored references shorter than six seconds", async () => {
    const digest = "e".repeat(64);
    vi.mocked(studioApi.voices).mockResolvedValue([]);
    vi.mocked(studioApi.voiceModel).mockResolvedValue({
      available: true,
      model_sha256: "a".repeat(64),
    });
    vi.mocked(studioApi.voiceReferences).mockResolvedValue([
      {
        sha256: digest,
        duration_ms: 5000,
        sample_rate: 16000,
        channels: 1,
        size_bytes: 160044,
        audio_url: `/api/voices/references/${digest}`,
      },
    ]);
    vi.mocked(studioApi.createVoice).mockClear();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <VoicesPage />
      </QueryClientProvider>,
    );
    const legacyOption = await screen.findByRole("option", { name: /5\.0 s/ });
    expect(legacyOption).toBeDisabled();
    expect(screen.getByRole("button", { name: /Criar e sintetizar prévia/ })).toBeDisabled();
    expect(studioApi.createVoice).not.toHaveBeenCalled();
  });

  it("rejects unsupported file types without uploading them", () => {
    vi.mocked(studioApi.uploadVoiceReference).mockClear();
    vi.mocked(studioApi.voices).mockResolvedValue([]);
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

    const zone = screen.getByTestId("voice-reference-dropzone");
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(["flac"], "sample.flac", { type: "audio/flac" })] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Selecione um áudio WAV, MP3 ou OGG.");
    expect(studioApi.uploadVoiceReference).not.toHaveBeenCalled();
  });
});
