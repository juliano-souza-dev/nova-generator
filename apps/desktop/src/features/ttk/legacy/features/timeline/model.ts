import type { MediaAsset } from "../../shared/types";

export type TimelineClip = {
  id: string;
  assetId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  sourceDurationMs?: number;
  timelineStartMs: number;
  volume: number;
  muted?: boolean;
  cameraMotion?: "none" | "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "pan-up" | "pan-down";
  transitionMs?: number;
  transitionType?: "fade-black" | "fade-white" | "flash";
};

export type TimelineGroup = { id: string; name: string; members: string[] };

export type TrimDrag = { clipId: string; edge: "start" | "end"; startX: number; sourceStartMs: number; sourceEndMs: number; timelineStartMs: number; scaleMs: number; didMove?: boolean };

export type ClipMoveDrag = { clipId: string; startX: number; lastX: number; timelineStartMs: number; memberKeys: string[]; didMove?: boolean };

export type MotionTrimDrag = { id: string; edge: "start" | "end" | "move"; startX: number; lastX: number; startMs: number; endMs: number; memberKeys: string[]; didMove?: boolean };

export const defaultDuration = (asset: MediaAsset) => asset.durationMs && asset.durationMs > 0 ? asset.durationMs : asset.kind === "image" ? 5000 : 30000;

export const clipDuration = (clip: TimelineClip) => Math.max(0, clip.sourceEndMs - clip.sourceStartMs);

export const clipEnd = (clip: TimelineClip) => clip.timelineStartMs + clipDuration(clip);

export const timeLabel = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
};




