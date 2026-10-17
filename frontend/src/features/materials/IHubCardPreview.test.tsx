import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IHubCardPreview, splitIHubHighlight } from "./IHubCardPreview";

const demo = {
  cue_id: "cue-1",
  approved_en: "I'm gonna have to let you go.",
  approved_pt: "Vou ter que te demitir.",
  speaker: "Michael",
  audio_url: null,
  highlights: [{ en: "let you go", pt: "te demitir", kind: "expression" }],
  pedagogical: {
    cue_id: "cue-1",
    front_en: "I'm gonna have to let you go.",
    back_pt: "Vou ter que te demitir.",
    explanation_pt: "No ambiente de trabalho, 'let you go' pode significar demitir.",
    card_type: "EXPRESSION",
    focus_text: "let you go",
    meaning: "te demitir",
    marked_en: "let you go",
    marked_pt: "te demitir",
    example_en: "They had to let him go.",
    example_pt: "Eles tiveram que demiti-lo.",
    tags: [],
  },
};

describe("iHub card reproduction", () => {
  it("preserves the iHub first-only, case-insensitive highlighted span", () => {
    expect(splitIHubHighlight("Let you go, let you go", "let you go")).toEqual([
      { text: "Let you go", marked: true },
      { text: ", let you go", marked: false },
    ]);
  });

  it("shows only the English front first; unlocks ratings only after the flip", async () => {
    const onClose = vi.fn();
    render(<IHubCardPreview card={demo} onClose={onClose} />);
    expect(screen.getByText("EN → PT")).toBeInTheDocument();
    expect(screen.getByText("I'm gonna have to")).toBeInTheDocument();
    expect(screen.queryByText("MINI LESSON")).not.toBeInTheDocument();
    const rating = screen.getByRole("button", { name: /Good/ });
    expect(rating).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Show answer" }));
    await waitFor(() => expect(screen.getByText("MINI LESSON")).toBeInTheDocument());
    await waitFor(() => expect(rating).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Show answer" })).not.toBeInTheDocument();
    expect(screen.getByText("HOW TO UNDERSTAND / USE")).toBeInTheDocument();
    expect(screen.getByText("ANOTHER EXAMPLE")).toBeInTheDocument();
    expect(screen.getByText("They had to let him go.")).toBeInTheDocument();
    fireEvent.click(rating);
    expect(screen.getByText(/Nenhuma avaliação foi registrada/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("never offers scene audio as a fallback and labels missing pedagogical content", () => {
    render(<IHubCardPreview card={{ ...demo, pedagogical: null }} onClose={() => undefined} />);
    expect(
      screen.queryByRole("button", { name: "Listen to pronunciation" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/explicação provisória/)).toBeInTheDocument();
    expect(screen.getByText(/reel Anki publicado/)).toBeInTheDocument();
  });
});
