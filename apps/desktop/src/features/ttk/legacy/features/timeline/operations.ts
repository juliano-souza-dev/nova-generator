import type { MediaAsset } from "../../shared/types";
import type { TimelineClip, TimelineGroup } from "./model";
import { clipDuration, clipEnd, defaultDuration } from "./model";

export function memberKeyForClip(id: string): string { return "clip:" + id; }
export function memberKeyForMotion(id: string): string { return "motion:" + id; }

export function groupMembersFor(groups: TimelineGroup[], key: string): string[] {
  return groups.find(group => group.members.includes(key))?.members ?? [key];
}

export function createTimelineClip(
  asset: MediaAsset,
  atMs: number | undefined,
  insertAtMs: number | null,
  visualClips: TimelineClip[],
  createId: () => string = () => crypto.randomUUID(),
): TimelineClip {
  const duration = defaultDuration(asset);
  return {
    id: createId(),
    assetId: asset.id,
    sourceStartMs: 0,
    sourceEndMs: duration,
    timelineStartMs: Math.max(0, atMs ?? insertAtMs ?? (asset.kind === "audio" ? 0 : visualClips.reduce((max, item) => Math.max(max, clipEnd(item)), 0))),
    volume: 100,
    muted: false,
  };
}

export function duplicateTimelineClip(clip: TimelineClip, createId: () => string = () => crypto.randomUUID()): TimelineClip {
  return { ...clip, id: createId(), timelineStartMs: clipEnd(clip) };
}

export function splitTimelineClipAt(
  clip: TimelineClip,
  playheadMs: number,
  createId: () => string = () => crypto.randomUUID(),
): { left: TimelineClip; right: TimelineClip } | null {
  const sourceSplit = clip.sourceStartMs + playheadMs - clip.timelineStartMs;
  if (sourceSplit <= clip.sourceStartMs || sourceSplit >= clip.sourceEndMs) return null;
  return {
    left: { ...clip, sourceEndMs: sourceSplit },
    right: { ...clip, id: createId(), sourceStartMs: sourceSplit, timelineStartMs: playheadMs },
  };
}

export function reorderVisualClips(
  clips: TimelineClip[],
  id: string,
  direction: -1 | 1,
): TimelineClip[] | null {
  const ordered = [...clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const index = ordered.findIndex(clip => clip.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ordered.length) return null;
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  let cursor = ordered[0]?.timelineStartMs ?? 0;
  const repositioned = ordered.map(clip => {
    const next = { ...clip, timelineStartMs: cursor };
    cursor += clipDuration(clip);
    return next;
  });
  const byId = new Map(repositioned.map(clip => [clip.id, clip]));
  return clips.map(clip => byId.get(clip.id) ?? clip);
}
