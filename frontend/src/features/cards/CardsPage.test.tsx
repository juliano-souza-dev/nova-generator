import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CardsPage } from "./CardsPage";

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("../../lib/api", () => ({
  apiRequest: api.request,
  apiUrl: (path: string) => `/api${path}`,
}));
vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    voices: vi.fn().mockResolvedValue([
      { id: "a28c0e73-0cc7-4441-b3c1-4e20d6171815", name: "Narradora", version: 1 },
    ]),
    job: vi.fn().mockResolvedValue({ status: "queued" }),
  },
}));

function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <CardsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Cards-only studio", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not require any editorial project and offers JSON upload and two sources", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Cards" })).toBeInTheDocument();
    expect(screen.getByLabelText("Arquivo JSON de cards")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "YouTube" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "MP3 ou WAV" }));
    expect(screen.getByLabelText("MP3 ou WAV de origem")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Gerar cards/ })).toBeDisabled();
  });

  it("shows validated card content before enabling the export", async () => {
    api.request.mockResolvedValue({
      title: "My lesson",
      count: 1,
      cards: [{
        card_id: "5c1b19aa-bd03-43e6-9edf-d54821329687",
        cue_id: "0c998303-9854-43d7-b238-f42bfe7aac4b",
        front_en: "Could you help me?",
        back_pt: "Você poderia me ajudar?",
        focus_text: "Could you",
        card_type: "STRUCTURE",
        marked_en: "Could you",
        marked_pt: "Você poderia",
        source_context_en: "Could you help me?",
        source_context_pt: "Você poderia me ajudar?",
        explanation_pt: "Pedido educado.",
        example_en: "Could you wait?",
        example_pt: "Você poderia esperar?",
        tags: [],
      }],
    });
    mount();
    const file = new File(['{"anki_cards":[]}'], "cards.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByLabelText("Arquivo JSON de cards"), {
      target: { files: [file] },
    });
    expect(await screen.findByText("My lesson")).toBeInTheDocument();
    expect(screen.getByText("Could you help me?")).toBeInTheDocument();
  });
});
