import type { Cue, Health, Job, Project, Timing, WordTiming } from "./api.types";
import { apiRequest } from "./api";

export const studioApi = {
  health: () => apiRequest<Health>("/health"),
  enqueueJob: (input: { kind: string; input: Record<string, unknown>; idempotency_key?: string }) =>
    apiRequest<Job>("/jobs", { method: "POST", body: JSON.stringify(input) }),
  cancelJob: (id: string) => apiRequest<Job>(`/jobs/${id}/cancel`, { method: "POST" }),
  projects: (search = "", includeArchived = false) =>
    apiRequest<Project[]>(
      `/projects?search=${encodeURIComponent(search)}&include_archived=${includeArchived}`,
    ),
  createProject: (input: { title: string; content_type: string; youtube_url?: string }) =>
    apiRequest<Project>("/projects", { method: "POST", body: JSON.stringify(input) }),
  duplicateProject: (id: string) =>
    apiRequest<Project>(`/projects/${id}/duplicate`, { method: "POST" }),
  archiveProject: (id: string) =>
    apiRequest<Project>(`/projects/${id}/archive`, { method: "POST" }),
  restoreProject: (id: string) =>
    apiRequest<Project>(`/projects/${id}/restore`, { method: "POST" }),
  deleteProject: (id: string) => apiRequest<void>(`/projects/${id}`, { method: "DELETE" }),
  updateCueText: (
    id: string,
    input: { author: string; approved_en: string; approved_pt: string },
  ) =>
    apiRequest<Cue>(`/editorial/cues/${id}/text`, { method: "PUT", body: JSON.stringify(input) }),
  updateCueTiming: (
    id: string,
    input: { author: string; speech_timing: Timing; subtitle_timing: Timing },
  ) =>
    apiRequest<Cue>(`/editorial/cues/${id}/timing`, { method: "PUT", body: JSON.stringify(input) }),
  updateWordTiming: (
    id: string,
    input: { author: string; timings: Array<Timing & { id: string }> },
  ) =>
    apiRequest<WordTiming[]>(`/editorial/cues/${id}/words/timing`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
};
