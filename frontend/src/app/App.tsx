import { Navigate, Route, Routes } from "react-router-dom";

import { StudioShell } from "../components/StudioShell";
import { EditorialPage } from "../features/editorial/EditorialPage";
import { MediaPage } from "../features/media/MediaPage";
import { MaterialsPage } from "../features/materials/MaterialsPage";
import { JobsPage } from "../features/jobs/JobsPage";
import { ProjectsPage } from "../features/projects/ProjectsPage";
import { StoryPage } from "../features/story/StoryPage";
import { VoicesPage } from "../features/voices/VoicesPage";

export function App() {
  return (
    <StudioShell>
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/editorial" element={<EditorialPage />} />
        <Route path="/media" element={<MediaPage />} />
        <Route path="/materials" element={<MaterialsPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/story" element={<StoryPage />} />
        <Route path="/voices" element={<VoicesPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </StudioShell>
  );
}
