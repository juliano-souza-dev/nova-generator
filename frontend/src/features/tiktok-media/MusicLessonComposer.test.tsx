import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MusicLessonComposer } from "./MusicLessonComposer";

describe("MusicLessonComposer", () => {
  it("makes a review proposal without directly changing the project", () => {
    const onDraft = vi.fn();
    const onAiPrompt = vi.fn();
    render(<MusicLessonComposer disabled={false} onDraft={onDraft} onAiPrompt={onAiPrompt} />);
    expect(screen.getByText(/55 segundos/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Montar mini-aula" }));
    expect(onDraft).toHaveBeenCalledOnce();
    expect(onDraft.mock.calls[0][0]).toHaveLength(7);
    expect(onAiPrompt).not.toHaveBeenCalled();
  });

  it("blocks an invalid cut and leaves the last proposal untouched", () => {
    const onDraft = vi.fn();
    render(<MusicLessonComposer disabled={false} onDraft={onDraft} onAiPrompt={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Fim do trecho musical"), {
      target: { value: "00:20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Montar mini-aula" }));
    expect(onDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/30 e 60 segundos/);
  });

  it("respects the video-source mode without silently unlinking its source", () => {
    const onDraft = vi.fn();
    render(<MusicLessonComposer disabled onDraft={onDraft} onAiPrompt={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Montar mini-aula" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText(/Crie uma produção/)).toBeTruthy();
  });

  it("prepares an AI request for the existing idea workflow", () => {
    const onAiPrompt = vi.fn();
    render(<MusicLessonComposer disabled={false} onDraft={vi.fn()} onAiPrompt={onAiPrompt} />);
    fireEvent.click(screen.getByRole("button", { name: "Preparar versão com IA" }));
    expect(onAiPrompt).toHaveBeenCalledOnce();
    expect(onAiPrompt.mock.calls[0][0]).toContain("7 quadros");
  });
});
