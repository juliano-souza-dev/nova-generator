import LegacyTtkApp from "./legacy/App";
import "./legacy/styles.css";

export default function TtkMediaModule({ projectId }: { projectId: string }) {
  return <div className="ttk-module">
    <LegacyTtkApp embeddedProjectId={projectId} />
  </div>;
}
