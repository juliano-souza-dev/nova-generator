export type Timing = { start_ms: number; end_ms: number };
export type Job = {
  id: string;
  kind: string | null;
  status: string;
  attempt: number;
  max_attempts: number | null;
  input: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  cancel_requested_at: string | null;
  can_cancel: boolean;
  can_retry: boolean;
};
export type JobEvent = { type: string; occurred_at: string; message: string };
export type JobDetail = Job & { events: JobEvent[] };
export type JobPage = { items: Job[]; offset: number; limit: number; total: number };
export type Health = { status: "ok" | "degraded"; database: "ok" | "unavailable" };
export type Cue = {
  id: string;
  scene_id: string;
  order: number;
  speaker: string;
  original_en: string;
  approved_en: string;
  approved_pt: string;
  speech_timing: Timing;
  subtitle_timing: Timing;
  revision: number;
};
export type WordTiming = {
  id: string;
  order: number;
  surface: string;
  start_ms: number;
  end_ms: number;
};
export type Project = {
  id: string;
  title: string;
  content_type: string;
  archived: boolean;
  youtube_url: string | null;
  youtube_video_id: string | null;
  cache_status: "missing" | "reused" | "not_configured";
  job_status: string;
};
export type ProjectMedia = {
  source_ready: boolean;
  source_url: string | null;
  duration_ms: number | null;
  download_job_id: string | null;
  download_status: string | null;
  download_error: string | null;
  ingest_job_id: string | null;
  ingest_status: string | null;
  ingest_error: string | null;
  cut_url: string | null;
  cut_start_ms: number | null;
  cut_end_ms: number | null;
  waveform: { sample_rate_hz: number; bucket_ms: number; peaks: number[] } | null;
  transcript_candidate: {
    engine: string;
    model: string;
    language: string | null;
    cues: Array<{
      start_ms: number;
      end_ms: number;
      text: string;
      words: Array<{
        surface: string;
        start_ms: number;
        end_ms: number;
        probability: number | null;
      }>;
    }>;
  } | null;
};
export type MediaJobReference = { id: string; status: string };
export type StoryHighlight = { text: string; type: string; pt: string; occurrence: number };
export type StoryCue = {
  order: number;
  image: string;
  en: string;
  pt: string;
  highlights: StoryHighlight[];
};
export type StoryProduction = {
  id: string;
  title: string;
  language: string;
  aspect_ratio: string;
  cues: StoryCue[];
  images: Array<{ path: string; sha256: string; size_bytes: number }>;
  image_urls: Record<string, string>;
  preview_url: string | null;
};
export type MaterialCard = {
  cue_id: string;
  scene_order: number;
  cue_order: number;
  approved_en: string;
  approved_pt: string;
  tags: string[];
  included: boolean;
  speaker: string;
  speech_start_ms: number;
  speech_end_ms: number;
  reel_start_ms: number | null;
  reel_end_ms: number | null;
  audio_ready: boolean;
  audio_url: string | null;
  audio_error: string | null;
};
export type MaterialList = {
  cards: MaterialCard[];
  voice_id: string | null;
  voice_version: number | null;
};
export type MaterialExport = {
  job_id: string;
  status: string;
  error_message?: string | null;
  apkg_url: string | null;
  manifest_url: string | null;
  reel_url: string | null;
};
export type VoiceProfile = {
  id: string;
  name: string;
  version: number;
  model_id: string;
  model_sha256: string;
  reference_audio_sha256: string | null;
  parameters: Record<string, unknown>;
  snapshot_sha256: string;
  preview_url: string | null;
  preview_ready: boolean;
};
