import type { MediaAsset } from "../../shared/types";
import type { TimelineClip } from "../timeline/model";
import type { ImageOverlay } from "../image-overlays/model";
import { motionAnimationTiming } from "../motion-graphics/model";
import type { MotionGraphic } from "../motion-graphics/model";
import { getLucideIconExportOffset } from "../motion-graphics/icon-layout";
import { lucideIconLibrary, renderLucideIconPng } from "../motion-graphics/icon-library";
import type { LucideIconName } from "../motion-graphics/icon-library";

export type ExportTimelineInput = {
  projectId: string;
  destination: string;
  clips: TimelineClip[];
  assets: MediaAsset[];
  motion: MotionGraphic[];
  textLayers: MotionGraphic[];
  imageOverlays: ImageOverlay[];
};

export async function buildExportTimelinePayload(input: ExportTimelineInput) {
  const exportClips = input.clips.flatMap(clip => {
    const asset = input.assets.find(item => item.id === clip.assetId);
    return asset ? [{
      id: clip.id,
      assetId: clip.assetId,
      kind: asset.kind,
      sourceStartMs: clip.sourceStartMs,
      sourceEndMs: clip.sourceEndMs,
      timelineStartMs: clip.timelineStartMs,
      volume: clip.volume,
      muted: clip.muted,
      transitionType: clip.transitionType ?? "fade-black",
      transitionMs: clip.transitionMs ?? 500,
    }] : [];
  });

  const motion = await Promise.all(input.motion
    .filter(item => item.visible !== false)
    .map(async item => {
      const iconSize = Math.max(24, Math.min(512, Math.round(item.lucideIconSize ?? item.fontSize)));
      const iconName = item.lucideIconName as LucideIconName | undefined;
      const animationTiming = motionAnimationTiming(item);
      return {
        startMs: item.startMs,
        endMs: item.endMs,
        entranceDurationMs: animationTiming.entranceDurationMs,
        typewriterDurationMs: animationTiming.typewriterDurationMs,
        preset: item.preset,
        x: item.x,
        y: item.y,
        text: item.isCaption
          ? (item.captionMode === "source" ? (item.captionEnglish || item.text) : [item.captionEnglish || item.text, item.captionTranslation].filter(Boolean).join("\n"))
          : (item.icon ? item.icon + " " : "") + item.text,
        color: item.color,
        fontSize: item.fontSize,
        fontFamily: item.fontFamily || "Arial",
        fontWeight: item.fontWeight || 900,
        textAlign: item.textAlign || "center",
        isCaption: !!item.isCaption,
        captionWords: item.isCaption && item.captionMode === "karaoke" ? (item.captionWords || []) : [],
        captionAccent: item.accent,
        captionBackgroundColor: item.captionBackgroundColor || "#000000",
        captionBackgroundOpacity: item.captionBackgroundOpacity ?? 0.76,
        captionWidth: item.captionWidth ?? 90,
        captionPaddingEm: item.captionPaddingEm ?? 0.32,
        lucideIconPng: iconName && lucideIconLibrary[iconName]
          ? await renderLucideIconPng(iconName, item.lucideIconColor || item.accent, iconSize)
          : undefined,
        lucideIconAnchor: item.lucideIconAnchor || "left",
        lucideIconSize: iconSize,
        ...getLucideIconExportOffset(item, iconSize),
      };
    }));

  return {
    projectId: input.projectId,
    destination: input.destination,
    clips: exportClips,
    motion,
    imageOverlays: input.imageOverlays.filter(item => item.visible !== false).map(item => ({
      assetId: item.assetId,
      startMs: item.startMs,
      endMs: item.endMs,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      soundId: item.soundId || "",
      soundVolume: item.soundVolume,
      entranceAnimation: item.entranceAnimation || "none",
      entranceDurationMs: Math.min(Math.max(100, Math.min(3000, item.entranceDurationMs ?? 600)), Math.max(1, item.endMs - item.startMs)),
    })),
    soundEffects: [
      ...input.textLayers.filter(item => !!item.soundId).map(item => ({
        soundId: item.soundId!, timelineStartMs: item.startMs, volume: item.soundVolume ?? 80,
      })),
      ...input.imageOverlays.filter(item => !!item.soundId).map(item => ({
        soundId: item.soundId!, timelineStartMs: item.startMs, volume: item.soundVolume,
      })),
    ],
  };
}
