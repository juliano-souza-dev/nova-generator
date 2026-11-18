import type { MediaAsset } from "../../shared/types";
import type { SceneSpec } from "../../shared/scene-spec";
import type { MotionGraphic } from "../motion-graphics/model";
import type { TimelineClip } from "../timeline/model";

export function getSceneSpecMediaSources(spec: SceneSpec): string[] {
  return [...new Set(spec.scenes.flatMap(scene => [
    scene.audio?.source?.trim(),
    scene.character?.asset?.trim(),
  ]).filter((source): source is string => !!source))];
}

export function buildSceneSpecProjectData(
  spec: SceneSpec,
  importedAssets: MediaAsset[],
  createId: () => string = () => crypto.randomUUID(),
): { motion: MotionGraphic[]; clips: TimelineClip[]; captionCount: number; characterRefs: number } {
  const sceneOffsetById = new Map<string, number>();
  let sceneCursor = 0;
  for (const scene of spec.scenes) {
    sceneOffsetById.set(scene.id, sceneCursor);
    sceneCursor += scene.durationMs;
  }

  const motion = spec.scenes.flatMap(scene => {
    const sceneStart = sceneOffsetById.get(scene.id) ?? 0;
    const blocks = scene.blocks.map(block => {
      const startMs = sceneStart + (block.startOffsetMs ?? 0);
      const blockDuration = block.durationMs ?? Math.max(300, scene.durationMs - (block.startOffsetMs ?? 0));
      const endMs = Math.min(sceneStart + scene.durationMs, startMs + blockDuration);
      return {
        id: createId(),
        text: block.text,
        icon: block.icon ?? "",
        lucideIconName: block.iconName ?? "",
        lucideIconAnchor: block.iconAnchor ?? "left",
        lucideIconSize: block.iconSize,
        lucideIconColor: block.iconColor,
        fontFamily: "Arial",
        fontWeight: 900,
        textAlign: block.align ?? "center",
        startMs,
        endMs: Math.max(startMs + 300, endMs),
        durationMs: Math.max(300, endMs - startMs),
        preset: "pop" as const,
        color: block.color,
        accent: block.accent ?? "#65d6c0",
        fontSize: block.fontSize,
        x: block.x,
        y: block.y,
        sound: "none" as const,
        soundId: "",
        soundVolume: 80,
      };
    });
    const captionConfig = scene.captions;
    const captions = !captionConfig || !captionConfig.enabled || captionConfig.mode === "off" ? [] :
      (captionConfig.lines ?? []).flatMap(line => {
        const startMs = sceneStart + line.startMs;
        const endMs = sceneStart + line.endMs;
        const words = (line.words ?? []).map(word => ({
          text: word.text,
          startMs: sceneStart + word.startMs,
          endMs: sceneStart + word.endMs,
        }));
        const translation = line.translation ?? "";
        return [{
          id: createId(),
          isCaption: true,
          captionMode: (captionConfig.mode === "karaoke" && words.length ? "karaoke" : captionConfig.mode === "bilingual" && translation ? "bilingual" : "source") as "source" | "bilingual" | "karaoke",
          captionEnglish: line.text,
          captionTranslation: translation,
          captionWords: words,
          text: translation ? line.text + "\\n" + translation : line.text,
          icon: "",
          fontFamily: "Arial",
          fontWeight: 900,
          textAlign: "center" as const,
          startMs,
          endMs,
          durationMs: endMs - startMs,
          preset: "pop" as const,
          color: "#ffffff",
          accent: "#65d6c0",
          fontSize: 48,
          x: 50,
          y: 82,
          sound: "none" as const,
          soundId: "",
          soundVolume: 80,
        }];
      });
    return [...blocks, ...captions];
  });

  const clips = spec.scenes.flatMap(scene => {
    const source = scene.audio?.source?.trim();
    if (!source) return [];
    const fileName = source.split(/[\\/]/).pop();
    const asset = importedAssets.find(item => item.originalName === fileName || item.name === fileName);
    if (!asset || asset.kind !== "audio") return [];
    const duration = Math.max(1000, asset.durationMs ?? scene.durationMs);
    const start = (sceneOffsetById.get(scene.id) ?? 0) + (scene.audio?.startMs ?? 0);
    return [{
      id: createId(),
      assetId: asset.id,
      sourceStartMs: 0,
      sourceEndMs: duration,
      sourceDurationMs: asset.durationMs ?? duration,
      timelineStartMs: start,
      volume: Math.max(0, Math.min(100, scene.audio?.volume ?? 100)),
      muted: false,
    }];
  });

  const captionCount = spec.scenes.reduce((total, scene) =>
    total + (scene.captions?.enabled && scene.captions.mode !== "off" ? (scene.captions.lines?.length ?? 0) : 0), 0);
  const characterRefs = spec.scenes.filter(scene => scene.character?.asset).length;
  return { motion, clips, captionCount, characterRefs };
}
