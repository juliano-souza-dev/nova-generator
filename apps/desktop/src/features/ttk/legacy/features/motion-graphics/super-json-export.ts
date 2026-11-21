import type { MotionGraphic } from "./model";
export type IHubSuperJson = {
  schema: "immersionhub-super-json"; schema_version: "1.0";
  project: { id: string; source: "ttk-creator"; exported_at: string };
  cues: Array<Record<string, unknown>>;
};
export function buildIHubSuperJson(projectId: string, captions: MotionGraphic[]): IHubSuperJson {
  const cues = captions.filter(item => item.isCaption && item.visible !== false).slice().sort((a,b)=>a.startMs-b.startMs).map((item,index)=>({
    id: item.id || `cue-${index+1}`, start_ms: Math.max(0,Math.round(item.startMs)), end_ms: Math.max(0,Math.round(item.endMs)),
    approved_en: (item.captionEnglish || item.text || "").trim(), pt: (item.captionTranslation || "").trim(),
    words: (item.captionWords || []).map(word => ({
      text: word.text, start_ms: Math.max(0,Math.round(word.startMs)), end_ms: Math.max(0,Math.round(word.endMs)),
      ...(word.originalStartMs != null ? {original_start_ms:Math.round(word.originalStartMs)} : {}),
      ...(word.originalEndMs != null ? {original_end_ms:Math.round(word.originalEndMs)} : {}),
      ...(word.confidenceScore != null ? {confidence_score:word.confidenceScore} : {}),
      ...(word.reviewStatus ? {review_status:word.reviewStatus} : {}),
      ...(word.alignmentSource ? {alignment_source:word.alignmentSource} : {}),
      ...(word.pt?.trim() ? {pt:word.pt.trim()} : {}),
      ...(word.ptGroup ? {pt_group:word.ptGroup} : {}),
      ...(word.ptGroupRole ? {pt_group_role:word.ptGroupRole} : {}),
    })),
  }));
  return {schema:"immersionhub-super-json",schema_version:"1.0",project:{id:projectId,source:"ttk-creator",exported_at:new Date().toISOString()},cues};
}