export type ShadowingBlock = {
  id: string;
  start_ms: number;
  end_ms: number;
  pause_duration_ms: number;
  cue_ids: string[];
  en: string;
  pt: string;
};

export type ShadowingPlan = {
  contract: string;
  project_id: string;
  scene_id: string;
  source_sha256: string;
  duration_ms: number;
  status: "draft" | "approved";
  blocks: ShadowingBlock[];
};
