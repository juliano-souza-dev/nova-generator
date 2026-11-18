import LegacyTtkApp from "./legacy/App";
import "./legacy/styles.css";

export default function TtkMediaModule({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  return <div className="ttk-module">
    <LegacyTtkApp embeddedProjectId={projectId} onBack={onBack} />
  </div>;
}
