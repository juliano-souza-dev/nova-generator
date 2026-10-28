import type { EditorialCue } from "../../lib/api.types";
import type { MediaCaption } from "./tiktok-api";

const MAX_CAPTIONS = 200;

/**
 * The editorial timeline is already relative to the downloaded cut.
 * Applying the source video's IN offset here would desynchronize every lyric.
 */
export function captionsFromApprovedCues(cues: EditorialCue[]): MediaCaption[] {
  const approved = cues
    .filter(
      (cue) =>
        cue.approved_en.trim().length > 0 &&
        cue.approved_pt.trim().length > 0 &&
        cue.provenance?.approval !== "draft" &&
        Number.isFinite(cue.speech_timing.start_ms) &&
        Number.isFinite(cue.speech_timing.end_ms) &&
        cue.speech_timing.end_ms > cue.speech_timing.start_ms,
    )
    .sort((a, b) => a.speech_timing.start_ms - b.speech_timing.start_ms);
  if (approved.length > MAX_CAPTIONS) {
    throw new Error(
      `Este trecho tem ${approved.length} falas aprovadas. O vídeo aceita até ${MAX_CAPTIONS} por produção. Divida o trecho em partes menores para não perder nenhuma fala.`,
    );
  }
  return approved.map((cue) => ({
    cue_id: cue.id,
    start_ms: cue.speech_timing.start_ms,
    end_ms: cue.speech_timing.end_ms,
    en: cue.approved_en,
    pt: cue.approved_pt,
    highlight: "",
    note: "",
    enabled: true,
  }));
}

export function activeCaptionAt(captions: MediaCaption[], playheadMs: number): MediaCaption | null {
  // A real gap must display no subtitles, even if the last cue stays selected.
  return (
    captions.find(
      (caption) => caption.enabled && caption.start_ms <= playheadMs && playheadMs < caption.end_ms,
    ) ?? null
  );
}

export function adjustCaptionTiming(
  captions: MediaCaption[],
  cueId: string,
  window: { start_ms: number; end_ms: number },
  durationMs: number,
): MediaCaption[] {
  const index = captions.findIndex((cue) => cue.cue_id === cueId);
  if (index < 0) return captions;
  const start = Math.max(0, Math.round(window.start_ms));
  const end = Math.min(Math.max(0, durationMs), Math.round(window.end_ms));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return captions;
  if (
    captions.some(
      (other, i) =>
        i !== index &&
        other.enabled &&
        captions[index].enabled &&
        start < other.end_ms &&
        end > other.start_ms,
    )
  ) {
    return captions;
  }
  return captions.map((caption, i) =>
    i === index ? { ...caption, start_ms: start, end_ms: end } : caption,
  );
}

export function durationLabel(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const tenths = Math.floor((safe % 1000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}
