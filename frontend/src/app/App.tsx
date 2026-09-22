import { Navigate, Route, Routes } from "react-router-dom";

import { StudioShell } from "../components/StudioShell";
import { EditorialPage } from "../features/editorial/EditorialPage";
import { MediaPage } from "../features/media/MediaPage";
import { ProjectsPage } from "../features/projects/ProjectsPage";
import { StoryPage } from "../features/story/StoryPage";

export function App() {
  return (
    <StudioShell>
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/editorial" element={<EditorialPage />} />
        <Route path="/media" element={<MediaPage />} />
        <Route path="/story" element={<StoryPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </StudioShell>
  );
}
