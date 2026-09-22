import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "./ProjectsPage";

vi.mock("../../lib/studio-api", () => ({
  studioApi: {
    projects: vi.fn().mockResolvedValue([]),
    createProject: vi.fn(),
    duplicateProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    deleteProject: vi.fn(),
  },
}));

describe("ProjectsPage", () => {
  it("opens the project form and validates its required title", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Novo projeto" }));
    fireEvent.click(screen.getByRole("button", { name: "Criar projeto" }));
    expect(await screen.findByText("Informe um nome para o projeto.")).toBeInTheDocument();
  });
});
