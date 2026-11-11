import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

import { App } from "./app/App";
import { DesktopBootstrap } from "./app/DesktopBootstrap";
import "./styles/tokens.css";
import "./styles/global.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <DesktopBootstrap>
          <App />
        </DesktopBootstrap>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
