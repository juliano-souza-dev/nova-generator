export type Timing = { start_ms: number; end_ms: number };
export type Job = { id: string; status: string; attempt: number };
export type Health = { status: "ok" | "degraded"; database: "ok" | "unavailable" };
export type Cue = { id: string; scene_id: string; order: number; speaker: string; original_en: string; approved_en: string; approved_pt: string; speech_timing: Timing; subtitle_timing: Timing; revision: number };
export type WordTiming = { id: string; order: number; surface: string; start_ms: number; end_ms: number };
