import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";

function renderApp(path = "/projects") { return render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>); }

describe("Studio shell", () => {
  it("renders navigation and projects route", () => { renderApp(); expect(screen.getByRole("navigation", { name: "Navegação principal" })).toBeInTheDocument(); expect(screen.getByRole("heading", { name: "Projetos" })).toBeInTheDocument(); });
  it("renders the independent story route", () => { renderApp("/story"); expect(screen.getByRole("heading", { name: "Modo História" })).toBeInTheDocument(); });
});
