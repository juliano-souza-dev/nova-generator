import type {
  Cue,
  EditorialCue,
  Health,
  Job,
  JobDetail,
  JobPage,
  MaterialCard,
  MaterialExport,
  MaterialList,
  MaterialPublication,
  Project,
  InspectedYoutubeSource,
  MediaJobReference,
  ProjectMedia,
  Scene,
  StoryProduction,
  Timing,
  WordTiming,
  VoiceProfile,
  VoiceReference,
  VoiceModelStatus,
} from "./api.types";
import { apiRequest } from "./api";

export const studioApi = {
  health: () => apiRequest<Health>("/health"),
  enqueueJob: (input: { kind: string; input: Record<string, unknown>; idempotency_key?: string }) =>
    apiRequest<Job>("/jobs", { method: "POST", body: JSON.stringify(input) }),
  cancelJob: (id: string) => apiRequest<Job>(`/jobs/${id}/cancel`, { method: "POST" }),
  jobs: (offset = 0, limit = 25, status?: string) =>
    apiRequest<JobPage>(
      `/jobs?offset=${offset}&limit=${limit}${status ? `&status=${status}` : ""}`,
    ),
  job: (id: string) => apiRequest<JobDetail>(`/jobs/${id}`),
  retryJob: (id: string) => apiRequest<Job>(`/jobs/${id}/retry`, { method: "POST" }),
  projects: (search = "", includeArchived = false) =>
    apiRequest<Project[]>(
      `/projects?search=${encodeURIComponent(search)}&include_archived=${includeArchived}`,
    ),
  projectMedia: (id: string) => apiRequest<ProjectMedia>(`/projects/${id}/media`),
  downloadProjectMedia: (id: string) =>
    apiRequest<MediaJobReference>(`/projects/${id}/media/download`, { method: "POST" }),
  ingestProjectMedia: (id: string, input: { start_ms: number; end_ms: number; language: string }) =>
    apiRequest<MediaJobReference>(`/projects/${id}/media/ingest`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  inspectYoutubeSource: (youtube_url: string) =>
    apiRequest<InspectedYoutubeSource>("/projects/source-inspections", {
      method: "POST",
      body: JSON.stringify({ youtube_url }),
    }),
  createProject: (input: { title?: string; content_type: string; youtube_url?: string }) =>
    apiRequest<Project>("/projects", { method: "POST", body: JSON.stringify(input) }),
  duplicateProject: (id: string) =>
    apiRequest<Project>(`/projects/${id}/duplicate`, { method: "POST" }),
  archiveProject: (id: string) =>
    apiRequest<Project>(`/projects/${id}/archive`, { method: "POST" }),
  restoreProject: (id: string) =>
    apiRequest<Project>(`/projects/${id}/restore`, { method: "POST" }),
  deleteProject: (id: string) => apiRequest<void>(`/projects/${id}`, { method: "DELETE" }),
  editorialScenes: (projectId: string) =>
    apiRequest<Scene[]>(`/editorial/projects/${projectId}/scenes`),
  editorialCues: (sceneId: string) =>
    apiRequest<EditorialCue[]>(`/editorial/scenes/${sceneId}/cues`),
  draftAsrCandidate: (projectId: string, jobId: string, author: string) =>
    apiRequest<Scene>(`/editorial/projects/${projectId}/candidates/${jobId}/draft`, {
      method: "POST",
      body: JSON.stringify({ author }),
    }),
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
  uploadStory: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return apiRequest<StoryProduction>("/stories", { method: "POST", body });
  },
  story: (id: string) => apiRequest<StoryProduction>(`/stories/${id}`),
  renderStory: (id: string, voice_profile_id: string) =>
    apiRequest<{ job_id: string; status: string }>(`/stories/${id}/render`, {
      method: "POST",
      body: JSON.stringify({ voice_profile_id }),
    }),
  publishStory: (id: string, youtube: string) =>
    apiRequest<Record<string, unknown>>(`/stories/${id}/publication`, {
      method: "POST",
      body: JSON.stringify({ youtube }),
    }),
  materials: (projectId: string, voiceId?: string) =>
    apiRequest<MaterialList>(
      `/projects/${projectId}/materials${voiceId ? `?voice_id=${encodeURIComponent(voiceId)}` : ""}`,
    ),
  updateMaterial: (projectId: string, cueId: string, included: boolean) =>
    apiRequest<MaterialCard>(`/projects/${projectId}/materials/${cueId}`, {
      method: "PATCH",
      body: JSON.stringify({ included }),
    }),
  prepareMaterialAudio: (projectId: string, cueId: string, voiceId: string) =>
    apiRequest<Job>(`/projects/${projectId}/materials/${cueId}/audio`, {
      method: "POST",
      body: JSON.stringify({ voice_id: voiceId }),
    }),
  exportMaterials: (projectId: string, voiceId: string) =>
    apiRequest<MaterialExport>(`/projects/${projectId}/materials/exports`, {
      method: "POST",
      body: JSON.stringify({ voice_id: voiceId }),
    }),
  materialExport: (projectId: string, jobId: string) =>
    apiRequest<MaterialExport>(`/projects/${projectId}/materials/exports/${jobId}`),
  latestMaterialExport: (projectId: string) =>
    apiRequest<MaterialExport>(`/projects/${projectId}/materials/latest-export`),
  publishMaterialExport: (projectId: string, jobId: string, youtube: string) =>
    apiRequest<MaterialPublication>(
      `/projects/${projectId}/materials/exports/${jobId}/publication`,
      {
        method: "POST",
        body: JSON.stringify({ youtube, confirmed: true }),
      },
    ),
  voices: () => apiRequest<VoiceProfile[]>("/voices"),
  voiceModel: () => apiRequest<VoiceModelStatus>("/voices/model"),
  voiceReferences: () => apiRequest<VoiceReference[]>("/voices/references"),
  uploadVoiceReference: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return apiRequest<VoiceReference>("/voices/references", { method: "POST", body });
  },
  createVoice: (input: {
    name: string;
    model_id: string;
    model_sha256?: string;
    reference_audio_sha256?: string;
    parameters: Record<string, unknown>;
  }) => apiRequest<VoiceProfile>("/voices", { method: "POST", body: JSON.stringify(input) }),
  createVoiceVersion: (
    id: string,
    input: {
      name: string;
      model_id: string;
      model_sha256?: string;
      reference_audio_sha256?: string;
      parameters: Record<string, unknown>;
    },
  ) =>
    apiRequest<VoiceProfile>(`/voices/${id}/versions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
