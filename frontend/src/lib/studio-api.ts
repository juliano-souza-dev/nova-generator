import type { Cue, Health, Job, Timing, WordTiming } from "./api.types";
import { apiRequest } from "./api";

export const studioApi = {
  health: () => apiRequest<Health>("/health"),
  enqueueJob: (input: { kind: string; input: Record<string, unknown>; idempotency_key?: string }) => apiRequest<Job>("/jobs", { method: "POST", body: JSON.stringify(input) }),
  cancelJob: (id: string) => apiRequest<Job>(`/jobs/${id}/cancel`, { method: "POST" }),
  updateCueText: (id: string, input: { author: string; approved_en: string; approved_pt: string }) => apiRequest<Cue>(`/editorial/cues/${id}/text`, { method: "PUT", body: JSON.stringify(input) }),
  updateCueTiming: (id: string, input: { author: string; speech_timing: Timing; subtitle_timing: Timing }) => apiRequest<Cue>(`/editorial/cues/${id}/timing`, { method: "PUT", body: JSON.stringify(input) }),
  updateWordTiming: (id: string, input: { author: string; timings: Array<Timing & { id: string }> }) => apiRequest<WordTiming[]>(`/editorial/cues/${id}/words/timing`, { method: "PUT", body: JSON.stringify(input) }),
};
