import { Navigate, Route, Routes } from "react-router-dom";

import { StudioShell } from "../components/StudioShell";
import { ShadowingPage } from "../features/shadowing/ShadowingPage";
import { EditorialPage } from "../features/editorial/EditorialPage";
import { MediaPage } from "../features/media/MediaPage";
import { MaterialsPage } from "../features/materials/MaterialsPage";
import { JobsPage } from "../features/jobs/JobsPage";
import { LibraryPage } from "../features/library/LibraryPage";
import { ProjectsPage } from "../features/projects/ProjectsPage";
import { StoryPage } from "../features/story/StoryPage";
import { VoicesPage } from "../features/voices/VoicesPage";
import { TikTokMediaPage } from "../features/tiktok-media/TikTokMediaPage";\nimport { SoundEffectsLibraryPage } from "../features/tiktok-media/SoundEffectsLibraryPage";
import { CardsPage } from "../features/cards/CardsPage";

export function App() {
  return (
    <StudioShell>
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/editorial" element={<EditorialPage />} />
        <Route path="/media" element={<MediaPage />} />
        <Route path="/shadowing" element={<ShadowingPage />} />
        <Route path="/materials" element={<MaterialsPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/story" element={<StoryPage />} />
        <Route path="/voices" element={<VoicesPage />} />
        <Route path="/tiktok-media" element={<TikTokMediaPage />} />\n        <Route path="/tiktok-media/sounds" element={<SoundEffectsLibraryPage />} />
        <Route path="/cards" element={<CardsPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </StudioShell>
  );
}
