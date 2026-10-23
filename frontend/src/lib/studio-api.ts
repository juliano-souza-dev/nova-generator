import type {
  Cue,
  EditorialCue,
  EditorialAssistance,
  EditorialAssistantStatus,
  EditorialSemanticUnit,
  EditorialReviewContext,
  Health,
  Job,
  JobDetail,
  JobPage,
  MaterialCard,
  MaterialAiReview,
  ShadowingPlan,
  MaterialExport,
  MaterialList,
  MaterialPublication,
  Project,
  InspectedYoutubeSource,
  MediaJobReference,
  MediaWaveform,
  ProjectMedia,
  Scene,
  StoryProduction,
  Timing,
  WordTiming,
  VoiceProfile,
  VoiceReference,
  VoiceModelStatus,
} from "./api.types";
import { apiRequest, apiUrl } from "./api";

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
  projectSourceWaveform: (id: string) =>
    apiRequest<MediaWaveform>(`/projects/${id}/media/source-waveform`),
  startProjectMedia: (id: string) =>
    apiRequest<ProjectMedia>(`/projects/${id}/media/start`, { method: "POST" }),
  downloadProjectMedia: (id: string) =>
    apiRequest<MediaJobReference>(`/projects/${id}/media/download`, { method: "POST" }),
  refreshProjectSource: (id: string) =>
    apiRequest<MediaJobReference>(
      `/projects/${id}/media/refresh-source?confirm_reset=true`,
      { method: "POST" },
    ),
  reprocessProjectMedia: (
    id: string,
    input: { start_ms: number; end_ms: number; language: string },
  ) =>
    apiRequest<MediaJobReference>(`/projects/${id}/media/reprocess`, {
      method: "POST",
      body: JSON.stringify({ ...input, confirm_reset: true }),
    }),
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
  createProjectFromIhub: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return apiRequest<Project>("/projects/from-ihub", { method: "POST", body });
  },
  duplicateProject: (id: string) =>
    apiRequest<Project>(`/projects/${id}/duplicate`, { method: "POST" }),
  archiveProject: (id: string) =>
    apiRequest<Project>(`/projects/${id}/archive`, { method: "POST" }),
  restoreProject: (id: string) =>
    apiRequest<Project>(`/projects/${id}/restore`, { method: "POST" }),
  deleteProject: (id: string) => apiRequest<void>(`/projects/${id}`, { method: "DELETE" }),
  editorialScenes: (projectId: string) =>
    apiRequest<Scene[]>(`/editorial/projects/${projectId}/scenes`),
  openEditorialReview: (projectId: string) =>
    apiRequest<EditorialReviewContext>(`/editorial/projects/${projectId}/review`, {
      method: "POST",
    }),
  editorialCues: (sceneId: string) =>
    apiRequest<EditorialCue[]>(`/editorial/scenes/${sceneId}/cues`),
  editorialAssistantStatus: () =>
    apiRequest<EditorialAssistantStatus>("/editorial/assistant/status"),
  startEditorialAssistance: (sceneId: string) =>
    apiRequest<{ job_id: string; status: string }>(`/editorial/scenes/${sceneId}/assistance`, {
      method: "POST",
    }),
  externalEditorialPackageUrl: (sceneId: string) =>
    apiUrl(`/editorial/scenes/${sceneId}/external-package`),
  importExternalEditorialResults: (
    sceneId: string, files: File[], allowResegmentation = false,
  ) => {
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    const confirmation = allowResegmentation ? "?allow_resegmentation=true" : "";
    return apiRequest<EditorialAssistance>(`/editorial/scenes/${sceneId}/external-results${confirmation}`, {
      method: "POST",
      body,
    });
  },
  importExternalEditorialResult: (sceneId: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return apiRequest<EditorialAssistance>(`/editorial/scenes/${sceneId}/external-result`, {
      method: "POST",
      body,
    });
  },
  draftAsrCandidate: (projectId: string, jobId: string, author: string) =>
    apiRequest<Scene>(`/editorial/projects/${projectId}/candidates/${jobId}/draft`, {
      method: "POST",
      body: JSON.stringify({ author }),
    }),
  splitEditorialCue: (
    cueId: string,
    input: {
      author: string;
      after_word_id: string;
      first: { original_en: string; approved_en: string; approved_pt: string };
      second: { original_en: string; approved_en: string; approved_pt: string };
      first_speaker?: string;
      second_speaker?: string;
    },
  ) =>
    apiRequest<Cue[]>(`/editorial/cues/${cueId}/split`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  mergeEditorialCues: (
    cueIds: string[],
    input: {
      author: string;
      text: { original_en: string; approved_en: string; approved_pt: string };
      speaker?: string;
      confirm_same_speaker?: boolean;
    },
  ) =>
    apiRequest<Cue>("/editorial/cues/merge-many", {
      method: "POST",
      body: JSON.stringify({ cue_ids: cueIds, ...input }),
    }),
  updateCueText: (
    id: string,
    input: {
      author: string;
      approved_en: string;
      approved_pt: string;
      approve?: boolean;
      proposed_speech_timing?: Timing;
      proposed_word_timings?: Timing[];
      proposed_word_translations?: Array<string | null>;
      confirm_word_timings?: boolean;
      confirm_word_translations?: boolean;
      group_cue_translation?: boolean;
    },
  ) =>
    apiRequest<Cue>(`/editorial/cues/${id}/text`, { method: "PUT", body: JSON.stringify(input) }),
  updateCueTiming: (
    id: string,
    input: { author: string; speech_timing: Timing; subtitle_timing: Timing },
  ) =>
    apiRequest<Cue>(`/editorial/cues/${id}/timing`, { method: "PUT", body: JSON.stringify(input) }),
  completeWordTimingReview: (cueId: string, wordId: string, author: string) =>
    apiRequest<WordTiming>(`/editorial/cues/${cueId}/words/complete`, {
      method: "POST",
      body: JSON.stringify({ word_id: wordId, author }),
    }),
  updateWordTiming: (
    id: string,
    input: { author: string; timings: Array<Timing & { id: string }> },
  ) =>
    apiRequest<WordTiming[]>(`/editorial/cues/${id}/words/timing`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  realignCue: (id: string, targetStartMs: number, author: string) =>
    apiRequest<Cue>(`/editorial/cues/${id}/realign`, {
      method: "POST",
      body: JSON.stringify({ target_start_ms: targetStartMs, author }),
    }),
  updateWordSurface: (cueId: string, wordId: string, surface: string, author: string) =>
    apiRequest<Cue>(`/editorial/cues/${cueId}/words/surface`, {
      method: "PUT",
      body: JSON.stringify({ word_id: wordId, surface, author }),
    }),
  fitCueToWords: (cueId: string, author: string) =>
    apiRequest<Cue>(`/editorial/cues/${cueId}/fit-words`, {
      method: "POST",
      body: JSON.stringify({ author }),
    }),
  updateWordTranslation: (cueId: string, wordId: string, pt: string, author: string) =>
    apiRequest<WordTiming[]>(`/editorial/cues/${cueId}/words/translation`, {
      method: "PUT",
      body: JSON.stringify({ word_id: wordId, pt, author }),
    }),
  groupWordTranslation: (
    cueId: string,
    wordId: string,
    direction: "previous" | "next",
    pt: string,
    author: string,
  ) =>
    apiRequest<WordTiming[]>(`/editorial/cues/${cueId}/words/group`, {
      method: "POST",
      body: JSON.stringify({ word_id: wordId, direction, pt, author }),
    }),
  ungroupWordTranslation: (cueId: string, wordId: string, author: string) =>
    apiRequest<WordTiming[]>(`/editorial/cues/${cueId}/words/ungroup`, {
      method: "POST",
      body: JSON.stringify({ word_id: wordId, author }),
    }),
  replaceSemanticUnits: (
    cueId: string,
    expectedRevision: number,
    units: EditorialSemanticUnit[],
    author: string,
  ) =>
    apiRequest<WordTiming[]>(`/editorial/cues/${cueId}/words/semantic-units`, {
      method: "PUT",
      body: JSON.stringify({ expected_revision: expectedRevision, units, author }),
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
  shadowing: (projectId: string) => apiRequest<ShadowingPlan[]>(`/projects/${projectId}/shadowing`),
  shadowingPackageUrl: (projectId: string, sceneId: string) =>
    apiUrl(`/projects/${projectId}/shadowing/${sceneId}/package`),
  generateShadowing: (projectId: string, sceneId: string) =>
    apiRequest<ShadowingPlan>(`/projects/${projectId}/shadowing/${sceneId}/generate`, {
      method: "POST",
    }),
  importShadowing: (projectId: string, sceneId: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return apiRequest<ShadowingPlan>(`/projects/${projectId}/shadowing/${sceneId}/import`, {
      method: "POST",
      body,
    });
  },
  editShadowing: (
    projectId: string,
    sceneId: string,
    source_sha256: string,
    plan_sha256: string,
    groups: string[][],
  ) =>
    apiRequest<ShadowingPlan>(`/projects/${projectId}/shadowing/${sceneId}/blocks`, {
      method: "PUT",
      body: JSON.stringify({ source_sha256, plan_sha256, groups }),
    }),
  approveShadowing: (
    projectId: string,
    sceneId: string,
    source_sha256: string,
    plan_sha256: string,
  ) =>
    apiRequest<ShadowingPlan>(`/projects/${projectId}/shadowing/${sceneId}/approval`, {
      method: "POST",
      body: JSON.stringify({ source_sha256, plan_sha256 }),
    }),
  externalMaterialsPackageUrl: (projectId: string) =>
    apiUrl(`/projects/${projectId}/materials-ai/package`),
  externalMaterialsReview: (projectId: string) =>
    apiRequest<MaterialAiReview>(`/projects/${projectId}/materials-ai/review`),
  importExternalMaterials: (projectId: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return apiRequest<MaterialAiReview>(`/projects/${projectId}/materials-ai/import`, {
      method: "POST",
      body,
    });
  },
  approveExternalMaterials: (projectId: string, source_sha256: string) =>
    apiRequest<MaterialAiReview>(`/projects/${projectId}/materials-ai/approval`, {
      method: "POST",
      body: JSON.stringify({ source_sha256 }),
    }),
  didacticAnkiAudioStatus: (projectId: string, voiceId?: string) =>
    apiRequest<{
      cards: Array<{
        card_id: string;
        cue_id: string;
        front_en: string;
        audio_ready: boolean;
        audio_url: string | null;
      }>;
    }>(
      `/projects/${projectId}/materials/anki-audio${voiceId ? `?voice_id=${encodeURIComponent(voiceId)}` : ""}`,
    ),
  prepareDidacticAnkiAudio: (projectId: string, cardId: string, voiceId: string) =>
    apiRequest<Job>(`/projects/${projectId}/materials/anki/${cardId}/audio`, {
      method: "POST",
      body: JSON.stringify({ voice_id: voiceId }),
    }),
  exportDidacticAnki: (projectId: string, voiceId: string) =>
    apiRequest<MaterialExport>(`/projects/${projectId}/materials/anki-exports`, {
      method: "POST",
      body: JSON.stringify({ voice_id: voiceId }),
    }),
  updateAnkiCard: (
    projectId: string,
    sceneId: string,
    cardId: string,
    card: import("./api.types").AnkiDidacticCard,
    expected_sha256: string,
  ) =>
    apiRequest<MaterialAiReview>(
      `/projects/${projectId}/materials-ai/anki/${sceneId}/cards/${cardId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          expected_sha256,
          card: Object.fromEntries(
            Object.entries(card).filter(([field]) => field !== "scene_id"),
          ),
        }),
      },
    ),
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
  rebuildAnkiPackage: (projectId: string, jobId: string) =>
    apiRequest<MaterialExport>(
      `/projects/${projectId}/materials/exports/${jobId}/anki/rebuild`,
      { method: "POST" },
    ),
  regenerateFinalMaterials: (projectId: string, jobId: string) =>
    apiRequest<MaterialPublication>(
      `/projects/${projectId}/materials/exports/${jobId}/publication/regenerate`,
      { method: "POST" },
    ),
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
