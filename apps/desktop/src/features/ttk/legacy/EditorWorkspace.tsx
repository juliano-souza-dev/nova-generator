import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, DragEvent, PointerEvent as ReactPointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { desktopApi, isDesktopRuntime } from "./services/desktop-api";
import type { TranscriptResult } from "./services/desktop-api";
import type { MediaAsset } from "./shared/types";
import { defaultDuration, clipDuration, clipEnd, timeLabel } from "./features/timeline/model";
import type { TimelineClip, TimelineGroup, TrimDrag, ClipMoveDrag, MotionTrimDrag } from "./features/timeline/model";
import { imageOverlayEntranceState } from "./features/image-overlays/model";
import type { ImageOverlay } from "./features/image-overlays/model";
import { createTimelineClip, duplicateTimelineClip, groupMembersFor, memberKeyForClip, memberKeyForMotion, reorderVisualClips, splitTimelineClipAt } from "./features/timeline/operations";
import TimelineClipItem from "./features/timeline/TimelineClipItem";
import { motionPreviewState, captionSemanticGroups, captionWordsForTimeline } from "./features/motion-graphics/model";
import type { MotionGraphic } from "./features/motion-graphics/model";
import { mergeMotionLayers, splitMotionLayers } from "./features/motion-graphics/collection";
import { parseSuperJsonCues, sceneSpecToMotionGraphics, sceneTemplateToMotionGraphics } from "./features/motion-graphics/super-json-import";
import { buildIHubSuperJson } from "./features/motion-graphics/super-json-export";
import { lucideIconLibrary, lucideIconNames, lucideIconPickerNames } from "./features/motion-graphics/icon-library";
import type { LucideIconName } from "./features/motion-graphics/icon-library";
import { captionStyleFrom, duplicateCaption, mergeCaptions, splitCaption } from "./features/motion-graphics/caption-editing";
import { captionBackgroundRgba } from "./features/motion-graphics/caption-style";
import { buildExportTimelinePayload } from "./features/export/payload";
import { transcriptToCaptions } from "./features/motion-graphics/transcript-import";
import { useCaptionTranslation } from "./features/motion-graphics/useCaptionTranslation";
import { useGlobalSounds } from "./features/sounds/useGlobalSounds";
export { supportedLucideIconNames } from "./features/motion-graphics/icon-library";

import { AudioLines, Film, Plus, Play, Pause, Trash2, Scissors, Copy, SkipBack, SkipForward, Volume2, VolumeX, Music2, Type, WandSparkles, MousePointer2, ChevronLeft, ChevronRight, Download, LoaderCircle, PanelsTopLeft, FileJson, Upload, Eye, Search, Image, ShieldCheck, Languages, Captions, Layers } from "lucide-react";
import { SCENE_TEMPLATES, buildTemplateScene, createSceneSpecFromMotion, validateSceneSpec } from "./shared/scene-spec";

type Props = { projectId: string; assets: MediaAsset[]; onAddMedia: () => void; onOpenTranscription?: (assetId?: string, context?: { clipId: string; timelineStartMs: number; sourceStartMs: number; sourceEndMs: number }) => void };
const motionPresets = [{id:"pop",label:"Pop Impact",sound:"pop"},{id:"slide",label:"Slide + Whoosh",sound:"whoosh"},{id:"zoom",label:"Zoom + Impact",sound:"impact"},{id:"typewriter",label:"Typewriter",sound:"click"},{id:"impact",label:"Big Impact",sound:"impact"}] as const;







export default function EditorWorkspace({ projectId, assets, onAddMedia, onOpenTranscription }: Props) {
  const storageKey = `ttk-creator:timeline:${projectId}`;
  const sessionKey = `ttk-creator:session:${projectId}`;
  const [clips, setClips] = useState<TimelineClip[]>([]);
  const groupKey = "ttk-creator:groups:" + projectId;
  const [groups, setGroups] = useState<TimelineGroup[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  // Text layers and captions are persisted independently. The merged list is only
  // a timeline/rendering view, never the source of truth for either domain.
  const motionKey = "ttk-creator:motion:" + projectId;
  const textLayersKey = "ttk-creator:text-layers:" + projectId;
  const captionsKey = "ttk-creator:captions:" + projectId;
  const motionOrderKey = "ttk-creator:motion-order:" + projectId;
  const [textLayers, setTextLayers] = useState<MotionGraphic[]>([]);
  const [captions, setCaptions] = useState<MotionGraphic[]>([]);
  const [motionOrder, setMotionOrder] = useState<string[]>([]);
  const [loadedMotionKey, setLoadedMotionKey] = useState<string | null>(null);
  const motion = useMemo(
    () => mergeMotionLayers(textLayers, captions, motionOrder),
    [textLayers, captions, motionOrder],
  );
  // Pointer-driven edits can fire several times before React commits a render.
  // Keep the latest merged snapshot synchronously so consecutive moves never
  // rebuild the collections from a stale render and drop a caption.
  const motionRef = useRef<MotionGraphic[]>(motion);
  motionRef.current = motion;
  const setMotion = useCallback((updater: MotionGraphic[] | ((current: MotionGraphic[]) => MotionGraphic[])) => {
    const next = typeof updater === "function" ? updater(motionRef.current) : updater;
    motionRef.current = next;
    const separated = splitMotionLayers(next);
    setTextLayers(separated.textLayers);
    setCaptions(separated.captions);
    setMotionOrder(next.map(item => item.id));
  }, []);
  function appendTextLayers(items: MotionGraphic[]) {
    if (!items.length) return;
    setMotion(current => [...current, ...items]);
  }
  function appendCaptions(items: MotionGraphic[]) {
    if (!items.length) return;
    setMotion(current => [...current, ...items]);
  }
  const overlayKey = `ttk-creator:image-overlays:${projectId}`;
  const [imageOverlays,setImageOverlays]=useState<ImageOverlay[]>([]);
  const [selectedOverlayId,setSelectedOverlayId]=useState<string|null>(null);
  const overlayDrag=useRef<{id:string;mode:"move"|"resize";startX:number;startY:number;x:number;y:number;width:number;height:number;ratio:number}|null>(null);
  const overlayTimelineDragRef=useRef<MotionTrimDrag|null>(null);
  const overlayTimelineDidMoveRef=useRef(false);

  useEffect(() => {
    const onTranscript = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; result: TranscriptResult; context?: { clipId: string; timelineStartMs: number; sourceStartMs: number; sourceEndMs: number } }>).detail;
      if (!detail || detail.projectId !== projectId) return;
      const created = transcriptToCaptions(detail.result, detail.context); 
      appendCaptions(created);
      setSelectedMotionId(created[0]?.id ?? null);
      if (created.length) setPlayheadMs(created[0].startMs);
      setActiveTool("captions");
      setSceneSpecMessage("Transcrição adicionada à faixa exclusiva: " + created.length + " legendas. Revise o texto e os tempos antes de exportar.");
    };
    window.addEventListener("framelab:transcription-ready", onTranscript);
    return () => window.removeEventListener("framelab:transcription-ready", onTranscript);
  }, [projectId]);

  const [selectedMotionId, setSelectedMotionId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<"media" | "audio" | "text" | "captions" | "effects" | "templates">("media");
  const [sceneSpecMessage, setSceneSpecMessage] = useState("");
  const [iconSearch, setIconSearch] = useState("");
  const [selectedTransition, setSelectedTransition] = useState<TimelineClip["transitionType"] | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(100);
  const lastMotionSounds = useRef<Record<string, number>>({});
  const [loadedStorageKey, setLoadedStorageKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  // Keep the real media duration independently from the editable clip end.
  // Local imports do not have duration metadata until the browser loads them.
  const [mediaDurations, setMediaDurations] = useState<Record<string, number>>({});
  const [loadError, setLoadError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportMessage, setExportMessage] = useState("");
  const [playing, setPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [timelineInsertAtMs, setTimelineInsertAtMs] = useState<number | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const [previewScale, setPreviewScale] = useState(420 / 1920);
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const motionSoundPlayers = useRef<Record<string, HTMLAudioElement>>({});
  const lastTickRef = useRef(0);
  const trimDragRef = useRef<TrimDrag | null>(null);
  const clipMoveDragRef = useRef<ClipMoveDrag | null>(null);
  const motionTrimDragRef = useRef<MotionTrimDrag | null>(null);
  const motionTimelineDidMoveRef = useRef(false);

  // The editor preview is a scaled 1080x1920 render canvas. Font sizes therefore
  // use the exact same pixel values as FFmpeg, scaled only for the editor viewport.
  useEffect(() => {
    const node = previewFrameRef.current;
    if (!node) return;
    const updateScale = () => setPreviewScale(node.clientHeight / 1920);
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      setSelectedId(null);
      const saved = window.localStorage.getItem(storageKey);
      const parsed = saved ? JSON.parse(saved) as Array<Record<string, unknown>> : [];
      let legacyCursor = 0;
      const restored: TimelineClip[] = [];
      for (const raw of Array.isArray(parsed) ? parsed : []) {
        if (!raw || typeof raw.id !== "string" || typeof raw.assetId !== "string") continue;
        const oldStart = Number(raw.startMs ?? raw.sourceStartMs ?? 0);
        const oldEnd = Number(raw.endMs ?? raw.sourceEndMs ?? 0);
        if (!Number.isFinite(oldStart) || !Number.isFinite(oldEnd) || oldEnd <= oldStart) continue;
        const isNew = Number.isFinite(raw.timelineStartMs) && Number.isFinite(raw.sourceStartMs) && Number.isFinite(raw.sourceEndMs);
        const clip: TimelineClip = {
          id: raw.id,
          assetId: raw.assetId,
          sourceStartMs: isNew ? Number(raw.sourceStartMs) : oldStart,
          sourceEndMs: isNew ? Number(raw.sourceEndMs) : oldEnd,
          sourceDurationMs: Number.isFinite(raw.sourceDurationMs) ? Math.max(0, Number(raw.sourceDurationMs)) : undefined,
          timelineStartMs: isNew ? Math.max(0, Number(raw.timelineStartMs)) : legacyCursor,
          volume: Number.isFinite(raw.volume) ? Math.max(0, Math.min(100, Number(raw.volume))) : 100,
          muted: raw.muted === true,
          cameraMotion: ["none", "zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down"].includes(String(raw.cameraMotion)) ? raw.cameraMotion as TimelineClip["cameraMotion"] : "none",
          transitionMs: Number.isFinite(raw.transitionMs) ? Math.max(0, Math.min(2000, Number(raw.transitionMs))) : 500,
          transitionType: ["fade-black", "fade-white", "flash"].includes(String(raw.transitionType)) ? raw.transitionType as TimelineClip["transitionType"] : "fade-black"
        };
        restored.push(clip);
        if (!isNew) legacyCursor += clipDuration(clip);
      }
      setClips(restored);
      const savedGroups = window.localStorage.getItem(groupKey);
      if (savedGroups) {
        const parsed = JSON.parse(savedGroups);
        if (Array.isArray(parsed)) setGroups(parsed.filter((group: TimelineGroup) => group && typeof group.id === "string" && Array.isArray(group.members) && group.members.length >= 2));
      }
      const sessionRaw = window.localStorage.getItem(sessionKey);
      if (sessionRaw) {
        const session = JSON.parse(sessionRaw) as Record<string, unknown>;
        if (Number.isFinite(session.playheadMs)) setPlayheadMs(Math.max(0, Number(session.playheadMs)));
        if (Number.isFinite(session.timelineZoom)) setTimelineZoom(Math.max(50, Math.min(200, Number(session.timelineZoom))));
        if (typeof session.activeTool === "string" && ["media", "audio", "text", "captions", "effects", "templates"].includes(session.activeTool)) setActiveTool(session.activeTool as "media" | "audio" | "text" | "captions" | "effects" | "templates");
        if (typeof session.selectedId === "string") setSelectedId(session.selectedId);
        if (typeof session.selectedMotionId === "string") setSelectedMotionId(session.selectedMotionId);
      }
    } catch { setClips([]); }
    finally { setLoadedStorageKey(storageKey); }
  }, [storageKey, groupKey]);

  useEffect(() => {
    if (loadedStorageKey === storageKey) {
      window.localStorage.setItem(storageKey, JSON.stringify(clips));
      window.localStorage.setItem(groupKey, JSON.stringify(groups));
    }
  }, [storageKey, groupKey, clips, groups, loadedStorageKey]);
  useEffect(() => {
    try {
      const textRaw = window.localStorage.getItem(textLayersKey);
      const captionsRaw = window.localStorage.getItem(captionsKey);
      const orderRaw = window.localStorage.getItem(motionOrderKey);
      const legacyRaw = window.localStorage.getItem(motionKey);
      const hasSeparatedData = textRaw !== null || captionsRaw !== null;
      const storedText = textRaw ? JSON.parse(textRaw) : [];
      const storedCaptions = captionsRaw ? JSON.parse(captionsRaw) : [];
      const legacy = legacyRaw ? JSON.parse(legacyRaw) : [];
      const separated = [...(Array.isArray(storedText) ? storedText : []), ...(Array.isArray(storedCaptions) ? storedCaptions : [])];
      // The first split release could create empty separated stores while the old
      // combined store still contained the user's layers. Recover that data once,
      // then remove the legacy key so deleted layers are never resurrected.
      const migrateLegacy = orderRaw === null && Array.isArray(legacy) && legacy.length > 0;
      const source = hasSeparatedData
        ? (migrateLegacy ? [...legacy, ...separated] : separated)
        : (Array.isArray(legacy) ? legacy : []);
      const uniqueSource = [...new Map(source.filter((item: MotionGraphic) => !!item?.id).map((item: MotionGraphic) => [item.id, item] as const)).values()];
      const normalized = uniqueSource.map((item: MotionGraphic) => {
        const startMs = Math.max(0, Number(item.startMs) || 0);
        const legacyDuration = Math.max(300, Number(item.durationMs) || 1800);
        const endMs = Number.isFinite(item.endMs) ? Math.max(startMs + 300, Number(item.endMs)) : startMs + legacyDuration;
        const legacyComposition = item.preset === "composition";
        const legacyIcon = item.icon || (legacyComposition ? item.elements?.find(element => element.type === "icon")?.content : "");
        return { ...item, preset: legacyComposition ? "pop" : item.preset, entranceDurationMs: Math.max(100, Math.min(10000, Number(item.entranceDurationMs) || 700)), typewriterDurationMs: Math.max(100, Math.min(10000, Number(item.typewriterDurationMs) || 1500)), icon: legacyIcon || "", fontFamily: item.fontFamily || "Arial", fontWeight: item.fontWeight || 900, textAlign: item.textAlign || "center", startMs, endMs, durationMs: endMs - startMs, x: Number.isFinite(item.x) ? item.x : 50, y: Number.isFinite(item.y) ? item.y : 50 };
      });
      setTextLayers(normalized.filter(item => !item.isCaption));
      setCaptions(normalized.filter(item => !!item.isCaption));
      const savedOrder = orderRaw ? JSON.parse(orderRaw) : null;
      setMotionOrder(Array.isArray(savedOrder) ? savedOrder.filter((id: unknown) => typeof id === "string") : normalized.map(item => item.id));
      if (migrateLegacy) window.localStorage.removeItem(motionKey);
    } catch {
      setTextLayers([]);
      setCaptions([]);
      setMotionOrder([]);
    } finally {
      setLoadedMotionKey(motionKey);
    }
  }, [motionKey, textLayersKey, captionsKey, motionOrderKey]);
  useEffect(() => {
    if (loadedMotionKey !== motionKey || loadedStorageKey !== storageKey) return;
    window.localStorage.setItem(textLayersKey, JSON.stringify(textLayers));
    window.localStorage.setItem(captionsKey, JSON.stringify(captions));
    window.localStorage.setItem(motionOrderKey, JSON.stringify(motionOrder));
  }, [motionKey, textLayersKey, captionsKey, motionOrderKey, textLayers, captions, motionOrder, loadedMotionKey, loadedStorageKey, storageKey]);
  useEffect(()=>{try{const raw=localStorage.getItem(overlayKey);const parsed=raw?JSON.parse(raw):[];setImageOverlays(Array.isArray(parsed)?parsed:[]);}catch{setImageOverlays([]);}},[overlayKey]);
  useEffect(()=>{if(loadedStorageKey===storageKey)localStorage.setItem(overlayKey,JSON.stringify(imageOverlays));},[overlayKey,imageOverlays,loadedStorageKey,storageKey]);
  const lastSessionSaveAt = useRef(0);
  useEffect(() => {
    if (loadedStorageKey !== storageKey) return;
    const now = Date.now();
    if (playing && now - lastSessionSaveAt.current < 1000) return;
    const session = { playheadMs, timelineZoom, activeTool, selectedId, selectedMotionId, savedAt: now };
    window.localStorage.setItem(sessionKey, JSON.stringify(session));
    lastSessionSaveAt.current = now;
  }, [sessionKey, storageKey, loadedStorageKey, playheadMs, timelineZoom, activeTool, selectedId, selectedMotionId, playing]);

  const {
    globalSounds, soundUrls, newSoundName, setNewSoundName,
    soundBusy, soundMessage, setSoundMessage, importGlobalSound, removeGlobalSound,
  } = useGlobalSounds({ setMotion });

  useEffect(() => {
    let cancelled = false;
    async function loadUrls() {
      const missing = assets.filter(asset => !mediaUrls[asset.id]);
      if (!missing.length) return;
      const entries = await Promise.all(missing.map(async asset => {
        try { return [asset.id, convertFileSrc(await desktopApi.getAssetPath(projectId, asset.id))] as const; }
        catch { return [asset.id, ""] as const; }
      }));
      if (!cancelled) setMediaUrls(current => ({ ...current, ...Object.fromEntries(entries) }));
    }
    void loadUrls();
    return () => { cancelled = true; };
  }, [assets, projectId, mediaUrls]);

  const timelineContentEndMs = Math.max(clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0), motion.reduce((max, item) => Math.max(max, item.endMs), 0), imageOverlays.filter(item=>item.id!==selectedOverlayId).reduce((max,item)=>Math.max(max,item.endMs),0));
  const totalDuration = Math.max(timelineContentEndMs, imageOverlays.reduce((max,item)=>Math.max(max,item.endMs),0));
  const selectedOverlay=!selectedId&&!selectedMotionId?(imageOverlays.find(item=>item.id===selectedOverlayId)??null):null;
  const activeOverlays=imageOverlays.filter(item=>item.visible!==false&&playheadMs>=item.startMs&&playheadMs<item.endMs);
  const selectedMotion = motion.find(item => item.id === selectedMotionId) ?? null;
  const {
    translationBusy, singleCaptionTranslationBusy, translationProgress,
    translationMessage, setTranslationMessage, translationPhase, setTranslationPhase, translateCaptions,
    translateSelectedCaption, requestStopAfterCurrentBatch
  } = useCaptionTranslation({ captions, setCaptions, selectedCaption: selectedMotion, updateMotion });
  const activeMotion = motion.filter(item => !item.isCaption && item.visible!==false && playheadMs >= item.startMs && playheadMs < item.endMs);
  const activeCaptions = captions.filter(item => item.visible!==false && playheadMs >= item.startMs && playheadMs < item.endMs);
  // Keep the selected layer visible while editing, even when its timing is adjusted.
  if (!playing && selectedMotion && selectedMotion.visible !== false) {
    if (selectedMotion.isCaption && !activeCaptions.some(item => item.id === selectedMotion.id)) activeCaptions.push(selectedMotion);
    if (!selectedMotion.isCaption && !activeMotion.some(item => item.id === selectedMotion.id)) activeMotion.push(selectedMotion);
  }
  // Captions are rendered from their own source collection, not from the merged
  // text/caption view. This keeps preview rendering independent from layer ordering.
  const previewMotion = [...activeMotion, ...activeCaptions];
  // Do not silently fall back to the first clip: that leaves stale video controls
  // visible after the user clears the selection or selects a different layer type.
  const selectedClip = selectedId ? clips.find(clip => clip.id === selectedId) ?? null : null;
  const selectedAsset = selectedClip ? assets.find(asset => asset.id === selectedClip.assetId) ?? null : null;
  const visualClips = useMemo(() => clips.filter(clip => assets.find(asset => asset.id === clip.assetId)?.kind !== "audio"), [clips, assets]);
  const audioClips = useMemo(() => clips.filter(clip => assets.find(asset => asset.id === clip.assetId)?.kind === "audio"), [clips, assets]);
  const activeVisualClip = visualClips.find(clip => playheadMs >= clip.timelineStartMs && playheadMs < clipEnd(clip)) ?? null;
  const activeVisualAsset = activeVisualClip ? assets.find(asset => asset.id === activeVisualClip.assetId) ?? null : null;
  const visualProgress = activeVisualClip ? Math.max(0, Math.min(1, (playheadMs - activeVisualClip.timelineStartMs) / Math.max(1, clipDuration(activeVisualClip)))) : 0;
  const transitionDuration = activeVisualClip?.transitionMs ?? 500;
  const transitionType = activeVisualClip?.transitionType ?? "fade-black";
  const transitionProgress = activeVisualClip && transitionDuration > 0
    ? Math.max(0, Math.min(1, (playheadMs - activeVisualClip.timelineStartMs) / transitionDuration))
    : 1;
  const previewOpacity = activeVisualClip && transitionType === "fade-black" ? transitionProgress : 1;
  const transitionWhiteOpacity = activeVisualClip && (transitionType === "fade-white" || transitionType === "flash") ? 1 - transitionProgress : 0;
  const cameraMotion = activeVisualClip?.cameraMotion ?? "none";
  const cameraTransform = cameraMotion === "zoom-in" ? `scale(${1 + visualProgress * 0.16})` : cameraMotion === "zoom-out" ? `scale(${1.16 - visualProgress * 0.16})` : cameraMotion === "pan-left" ? `scale(1.12) translateX(${-visualProgress * 7}%)` : cameraMotion === "pan-right" ? `scale(1.12) translateX(${visualProgress * 7}%)` : cameraMotion === "pan-up" ? `scale(1.12) translateY(${-visualProgress * 7}%)` : cameraMotion === "pan-down" ? `scale(1.12) translateY(${visualProgress * 7}%)` : "none";
  const previewClip = activeVisualClip ?? selectedClip;
  const previewAsset = activeVisualClip ? activeVisualAsset : selectedAsset;
  const previewUrl = previewAsset ? mediaUrls[previewAsset.id] : "";
  const selectedDuration = selectedClip ? clipDuration(selectedClip) : 0;
  const selectedSourceDuration = selectedAsset ? (selectedAsset.kind === "image" ? Math.max(10 * 60 * 1000, selectedClip?.sourceEndMs ?? 0) : Math.max(selectedClip?.sourceDurationMs ?? mediaDurations[selectedAsset.id] ?? defaultDuration(selectedAsset), selectedClip?.sourceEndMs ?? 0)) : 0;
  // Keep the timeline's time-to-pixel scale anchored to the full source duration.
  // If scale followed the trimmed clip end, a 60s clip would visually expand to fill
  // the canvas as soon as it was shortened, making the trim handle impossible to
  // drag back out past the new end.
  const sourceTimelineDuration = clips.reduce((max, clip) => {
    const asset = assets.find(item => item.id === clip.assetId);
    return Math.max(max, asset ? (clip.sourceDurationMs ?? mediaDurations[asset.id] ?? defaultDuration(asset)) : clip.sourceEndMs);
  }, 0);
  const scale = Math.max(totalDuration, sourceTimelineDuration, 10000);

  const stopPlayback = useCallback(() => {
    setPlaying(false);
    videoRef.current?.pause();
    Object.values(audioRefs.current).forEach(node => node?.pause());
    Object.values(motionSoundPlayers.current).forEach(node => { node.pause(); node.currentTime = 0; });
  }, []);

  useEffect(() => () => {
    videoRef.current?.pause();
    Object.values(audioRefs.current).forEach(node => node?.pause());
  }, []);

  // A single timeline clock drives the preview and every audio lane, keeping them aligned.
  useEffect(() => {
    if (playing && totalDuration > 0 && playheadMs >= totalDuration) stopPlayback();
  }, [playing, playheadMs, totalDuration, stopPlayback]);

  useEffect(() => {
    if (!playing) return;
    lastTickRef.current = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - lastTickRef.current;
      lastTickRef.current = now;
      setPlayheadMs(current => {
        const next = Math.min(totalDuration, current + elapsed);
        const visual = visualClips.find(clip => next >= clip.timelineStartMs && next < clipEnd(clip));
        if (visual) {
          const asset = assets.find(item => item.id === visual.assetId);
          if (asset?.kind === "video" && videoRef.current) {
            const expected = (visual.sourceStartMs + next - visual.timelineStartMs) / 1000;
            if (Math.abs(videoRef.current.currentTime - expected) > 0.22) videoRef.current.currentTime = expected;
            if (videoRef.current.paused) void videoRef.current.play().catch(() => setLoadError("Não foi possível reproduzir o vídeo."));
          }
        } else {
          videoRef.current?.pause();
        }
        for (const clip of audioClips) {
          const node = audioRefs.current[clip.id];
          if (!node) continue;
          if (next >= clip.timelineStartMs && next < clipEnd(clip)) {
            const expected = (clip.sourceStartMs + next - clip.timelineStartMs) / 1000;
            if (Math.abs(node.currentTime - expected) > 0.22) node.currentTime = expected;
            node.volume = Math.max(0, Math.min(1, clip.volume / 100));
            if (node.paused) void node.play().catch(() => setLoadError("Não foi possível reproduzir o áudio externo."));
          } else if (!node.paused) node.pause();
        }
        return next;
      });
    }, 40);
    return () => window.clearInterval(timer);
  }, [playing, totalDuration, visualClips, audioClips, assets, stopPlayback]);

  useEffect(() => {
    if (!videoRef.current || !previewClip || previewAsset?.kind !== "video") return;
    videoRef.current.volume = Math.max(0, Math.min(1, previewClip.volume / 100));
  }, [previewClip?.id, previewClip?.volume, previewAsset?.id]);

  useEffect(() => {
    if (playing) return;
    const visual = visualClips.find(clip => playheadMs >= clip.timelineStartMs && playheadMs < clipEnd(clip));
    const asset = visual ? assets.find(item => item.id === visual.assetId) : null;
    if (asset?.kind === "video" && videoRef.current) {
      const expected = (visual!.sourceStartMs + playheadMs - visual!.timelineStartMs) / 1000;
      if (Math.abs(videoRef.current.currentTime - expected) > 0.15) videoRef.current.currentTime = expected;
    }
    for (const clip of audioClips) {
      const node = audioRefs.current[clip.id];
      if (!node) continue;
      node.pause();
      if (playheadMs >= clip.timelineStartMs && playheadMs < clipEnd(clip)) {
        node.currentTime = (clip.sourceStartMs + playheadMs - clip.timelineStartMs) / 1000;
      }
    }
  }, [playheadMs, previewTick, playing, visualClips, audioClips, assets]);

  function exportIHubSuperJson() {
    const payload = buildIHubSuperJson(projectId, captions);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ttk-creator-${projectId}-ihub-super.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setSceneSpecMessage(`Super JSON compatível com iHubEnglish exportado com ${payload.cues.length} legendas.`);
  }

  async function exportVideo() {
    if (!isDesktopRuntime || exporting) return;
    stopPlayback();
    setExporting(true);
    setExportProgress(0);
    setExportMessage("");
    let unlistenProgress: (() => void) | undefined;
    try {
      unlistenProgress = await listen<{ percent: number }>("export-progress", event => {
        setExportProgress(Math.max(0, Math.min(100, event.payload.percent)));
      });
      await desktopApi.checkFfmpeg();
      const destination = await save({
        title: "Exportar vídeo",
        defaultPath: "video.mp4",
        filters: [{ name: "Vídeo MP4", extensions: ["mp4"] }],
      });
      if (!destination) {
        setExportMessage("");
        return;
      }
      const payload = await buildExportTimelinePayload({
        projectId,
        destination,
        clips,
        assets,
        motion,
        textLayers,
        imageOverlays,
      });
      await desktopApi.exportTimeline(payload);
      setExportProgress(100);
    } catch (error) {
      setExportMessage("Não foi possível exportar: " + String(error));
    } finally {
      unlistenProgress?.();
      setExporting(false);
    }
  }

  async function addImageOverlay(){try{const selected=await open({multiple:false,filters:[{name:"Imagens",extensions:["png","jpg","jpeg","webp","gif"]}]});if(!selected||Array.isArray(selected))return;const imported=await desktopApi.importMediaFiles(projectId,[selected]);const asset=imported.find(item=>item.kind==="image");if(!asset)throw new Error("A mídia selecionada não é uma imagem.");const url=convertFileSrc(await desktopApi.getAssetPath(projectId,asset.id));setMediaUrls(current=>({...current,[asset.id]:url}));const overlay:ImageOverlay={id:crypto.randomUUID(),assetId:asset.id,startMs:playheadMs,endMs:playheadMs+3000,x:50,y:50,width:420,height:420,soundId:"",soundVolume:80,entranceAnimation:"fade",entranceDurationMs:600};setImageOverlays(current=>[...current,overlay]);setSelectedOverlayId(overlay.id);setSelectedMotionId(null);setSelectedId(null);stopPlayback();}catch(error){setExportMessage("Não foi possível adicionar a imagem: "+String(error));}}
  function updateOverlay(id:string,patch:Partial<ImageOverlay>){setImageOverlays(current=>current.map(item=>item.id===id?{...item,...patch}:item));}
  function moveOverlayLayer(id:string,direction:-1|1){setImageOverlays(current=>{const index=current.findIndex(item=>item.id===id);const next=index+direction;if(index<0||next<0||next>=current.length)return current;const copy=[...current];[copy[index],copy[next]]=[copy[next],copy[index]];return copy;});}
  function moveMotionLayer(id:string,direction:-1|1){setMotion(current=>{const index=current.findIndex(item=>item.id===id);const next=index+direction;if(index<0||next<0||next>=current.length)return current;const copy=[...current];[copy[index],copy[next]]=[copy[next],copy[index]];return copy;});}
  function beginOverlayTimelineTrim(event:ReactPointerEvent<HTMLSpanElement>,item:ImageOverlay,edge:"start"|"end"){
    if(item.locked)return;
    event.preventDefault();event.stopPropagation();event.currentTarget.closest("button")?.setPointerCapture(event.pointerId);overlayTimelineDidMoveRef.current=false;
    overlayTimelineDragRef.current={id:item.id,edge,startX:event.clientX,lastX:event.clientX,startMs:item.startMs,endMs:item.endMs,memberKeys:[item.id],didMove:false};
    setSelectedOverlayId(item.id);setSelectedMotionId(null);setSelectedId(null);
  }
  function beginOverlayTimelineMove(event:ReactPointerEvent<HTMLButtonElement>,item:ImageOverlay){
    if(item.locked||(event.target as HTMLElement).closest(".image-overlay-trim-edge"))return;
    event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);overlayTimelineDidMoveRef.current=false;
    overlayTimelineDragRef.current={id:item.id,edge:"move",startX:event.clientX,lastX:event.clientX,startMs:item.startMs,endMs:item.endMs,memberKeys:[item.id],didMove:false};
    setSelectedOverlayId(item.id);setSelectedMotionId(null);setSelectedId(null);
  }
  function moveOverlayOnTimeline(event:ReactPointerEvent<HTMLElement>){
    const drag=overlayTimelineDragRef.current;if(!drag||!event.currentTarget.hasPointerCapture(event.pointerId))return;
    if (!drag.didMove) {
      if (Math.abs(event.clientX - drag.startX) < 4) return;
      drag.didMove = true;
      overlayTimelineDidMoveRef.current = true;
      drag.lastX = event.clientX;
      return;
    }
    const rect=event.currentTarget.closest(".timeline-canvas")?.getBoundingClientRect();if(!rect?.width)return;
    if(drag.edge==="move"){
      const delta=(event.clientX-drag.lastX)/rect.width*scale;drag.lastX=event.clientX;
      setImageOverlays(current=>current.map(item=>{if(item.id!==drag.id)return item;const safeDelta=Math.max(-item.startMs,delta);return {...item,startMs:item.startMs+safeDelta,endMs:item.endMs+safeDelta};}));
    }else{
      const delta=(event.clientX-drag.startX)/rect.width*scale;
      if(drag.edge==="start")updateOverlay(drag.id,{startMs:Math.max(0,Math.min(drag.endMs-100,drag.startMs+delta))});
      else updateOverlay(drag.id,{endMs:Math.max(drag.startMs+100,drag.endMs+delta)});
    }
  }
  function endOverlayTimelineDrag(event:ReactPointerEvent<HTMLElement>){
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    overlayTimelineDragRef.current=null;
  }
  function removeOverlay(id:string){setImageOverlays(current=>current.filter(item=>item.id!==id));setSelectedOverlayId(null);}
  function overlayPointerDown(event:ReactPointerEvent<HTMLDivElement>,item:ImageOverlay,mode:"move"|"resize"){if(item.locked)return;event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);overlayDrag.current={id:item.id,mode,startX:event.clientX,startY:event.clientY,x:item.x,y:item.y,width:item.width,height:item.height,ratio:item.width/Math.max(1,item.height)};setSelectedOverlayId(item.id);setSelectedMotionId(null);setSelectedId(null);}
  function overlayPointerMove(event:ReactPointerEvent<HTMLDivElement>){const drag=overlayDrag.current;if(!drag||!event.currentTarget.hasPointerCapture(event.pointerId))return;const rect=previewFrameRef.current?.getBoundingClientRect();if(!rect)return;if(drag.mode==="move"){updateOverlay(drag.id,{x:Math.max(0,Math.min(100,drag.x+(event.clientX-drag.startX)/rect.width*100)),y:Math.max(0,Math.min(100,drag.y+(event.clientY-drag.startY)/rect.height*100))});}else{const dx=(event.clientX-drag.startX)/rect.width*1080;const dy=(event.clientY-drag.startY)/rect.height*1920;const delta=Math.abs(dx)>Math.abs(dy*drag.ratio)?dx:dy*drag.ratio;const width=Math.max(60,Math.min(1080,drag.width+delta));updateOverlay(drag.id,{width,height:width/drag.ratio});}}
  function overlayPointerUp(event:ReactPointerEvent<HTMLDivElement>){overlayDrag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}
  function addMotion(preset: MotionGraphic["preset"]) {
    const item: MotionGraphic = { id: crypto.randomUUID(), text: preset === "typewriter" ? "YOUR WORD" : "WATCH", icon: "", fontFamily: "Arial", fontWeight: 900, textAlign: "center", startMs: playheadMs, endMs: playheadMs + 3000, durationMs: 3000, entranceDurationMs: 700, preset, typewriterDurationMs: 1500, color: "#ffffff", accent: "#65d6c0", fontSize: 64, x: 50, y: 50, sound: "none", soundId: "", soundVolume: 80 };
    appendTextLayers([item]); setSelectedMotionId(item.id); stopPlayback();
  }
  function updateMotion(id: string, patch: Partial<MotionGraphic>) {
    setMotion(current => current.map(item => {
      if (item.id !== id) return item;
      const nextStart = patch.startMs !== undefined ? Math.max(0, patch.startMs) : item.startMs;
      let nextEnd = patch.endMs !== undefined ? patch.endMs : item.endMs;
      nextEnd = Math.max(nextStart + 300, nextEnd);
      return { ...item, ...patch, startMs: nextStart, endMs: nextEnd, durationMs: nextEnd - nextStart };
    }));
  }
  function removeMotion(id: string) {
    setMotion(current => current.filter(item => item.id !== id));
    if (selectedMotionId === id) setSelectedMotionId(null);
  }

  function splitSelectedCaption() {
    if (!selectedMotion?.isCaption) return;
    const result = splitCaption(selectedMotion);
    if (!result.ok) {
      setTranslationMessage(result.reason === "too-few-words"
        ? "Adicione pelo menos duas palavras para dividir a legenda."
        : "O trecho é curto demais para ser dividido com segurança.");
      setTranslationPhase("Falha identificada");
      return;
    }
    setCaptions(current => [...current.map(item => item.id === selectedMotion.id ? result.first : item), result.second]);
    setMotionOrder(current => [...current.filter(id => id !== result.second.id), result.second.id]);
    setSelectedMotionId(result.second.id);
    setPlayheadMs(result.splitAtMs);
    setTranslationMessage("Legenda dividida em dois blocos.");
    setTranslationPhase("Concluído");
  }

  function mergeSelectedCaption(direction: "previous" | "next") {
    if (!selectedMotion?.isCaption) return;
    const ordered = [...captions].sort((a, b) => a.startMs - b.startMs);
    const index = ordered.findIndex(item => item.id === selectedMotion.id);
    const neighbor = ordered[index + (direction === "previous" ? -1 : 1)];
    if (!neighbor) return;
    const first = direction === "previous" ? neighbor : selectedMotion;
    const second = direction === "previous" ? selectedMotion : neighbor;
    const merged = mergeCaptions(first, second);
    setCaptions(current => current
      .filter(item => item.id !== neighbor.id)
      .map(item => item.id === selectedMotion.id ? merged : item));
    setSelectedMotionId(selectedMotion.id);
    setPlayheadMs(merged.startMs);
    setTranslationMessage("Legendas mescladas em um único bloco.");
    setTranslationPhase("Concluído");
  }

  function duplicateSelectedCaption() {
    if (!selectedMotion?.isCaption) return;
    const duplicate = duplicateCaption(selectedMotion);
    appendCaptions([duplicate]);
    setSelectedMotionId(duplicate.id);
    setPlayheadMs(duplicate.startMs);
  }

  function applySelectedCaptionStyleToSelection() {
    if (!selectedMotion?.isCaption) return;
    const selectedIds = new Set(captions
      .filter(item => selectedMembers.includes("motion:" + item.id))
      .map(item => item.id));
    if (!selectedIds.size) return;
    const style = captionStyleFrom(selectedMotion);
    setCaptions(current => current.map(item => selectedIds.has(item.id) ? { ...item, ...style } : item));
    setTranslationMessage("Estilo aplicado às " + selectedIds.size + " legendas selecionadas.");
    setTranslationPhase("Concluído");
  }

  function applySelectedCaptionStyleToAll() {
    if (!selectedMotion?.isCaption) return;
    const style = captionStyleFrom(selectedMotion);
    setCaptions(current => current.map(item => ({ ...item, ...style })));
    setTranslationMessage("Estilo aplicado a todas as legendas.");
    setTranslationPhase("Concluído");
  }

  function applySceneTemplate(templateId: string) {
    try {
      const scene = buildTemplateScene(templateId, playheadMs);
      const created = sceneTemplateToMotionGraphics(scene, playheadMs);
      appendTextLayers(created);
      setSelectedMotionId(created[0]?.id ?? null);
      setActiveTool("text");
      setSceneSpecMessage(`Template "${scene.name}" aplicado: ${created.length} elementos adicionados.`);
      stopPlayback();
    } catch (error) {
      setSceneSpecMessage("Não foi possível aplicar o template: " + String(error));
    }
  }

  function exportSceneSpec() {
    if (!textLayers.length) {
      setSceneSpecMessage("Adicione pelo menos um elemento de texto antes de exportar o Scene Spec.");
      return;
    }
    const spec = createSceneSpecFromMotion(textLayers);
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "framelab-scene-spec.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setSceneSpecMessage("Scene Spec exportado com os elementos atuais da timeline.");
  }

  async function importSceneSpec(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const payload = parsed as Record<string, unknown>;
        const rawCues = Array.isArray(payload.cues) ? payload.cues : Array.isArray(payload.lyrics) ? payload.lyrics : null;
        const isSuperJson = !!rawCues && (
          payload.schema === "immersionhub-super-json"
          || payload.schema_version !== undefined
          || payload.project !== undefined
          || payload.kit !== undefined
        );
        if (isSuperJson && rawCues) {
          const created = parseSuperJsonCues(rawCues, playheadMs);
          if (!created.length) throw new Error("O Super JSON foi reconhecido, mas não contém falas válidas para importar.");
          setCaptions(current => [...current, ...created]);
          setSelectedMotionId(created[0]?.id ?? null);
          setActiveTool("captions");
          const withWords = created.filter(item => item.captionWords?.length).length;
          const withTranslation = created.filter(item => item.captionTranslation).length;
          setSceneSpecMessage(`Super JSON importado: ${created.length} legendas, ${withWords} com sincronização por palavra e ${withTranslation} bilíngues.`);
          stopPlayback();
          return;
        }
      }
      if (!validateSceneSpec(parsed)) {
        throw new Error("JSON incompatível. Confira a versão 1.0 do Scene Spec ou importe um Super JSON do iHubEnglish.");
      }
      const unsupportedIcons = parsed.scenes.flatMap(scene => scene.blocks.map(block => block.iconName).filter((name): name is string => !!name && !lucideIconNames.includes(name as LucideIconName)));
      if (unsupportedIcons.length) {
        throw new Error("O Scene Spec contém ícones Lucide não disponíveis nesta biblioteca: " + [...new Set(unsupportedIcons)].join(", "));
      }
      const created = sceneSpecToMotionGraphics(parsed, playheadMs);
      appendTextLayers(created);
      setSelectedMotionId(created[0]?.id ?? null);
      setActiveTool("text");
      const hasPendingMetadata = parsed.scenes.some(scene => !!scene.audio || !!scene.character || !!scene.captions?.enabled);
      setSceneSpecMessage(`Importação concluída: ${created.length} elementos adicionados.${hasPendingMetadata ? " Observação: áudio, personagem e legendas do JSON serão integrados em etapas posteriores." : ""}`);
      stopPlayback();
    } catch (error) {
      setSceneSpecMessage("Falha ao importar Scene Spec: " + String(error));
    }
  }
  useEffect(() => {
    if (!playing) return;
    for (const item of imageOverlays) {
      if (item.soundId && soundUrls[item.soundId] && playheadMs >= item.startMs && playheadMs < item.startMs + 100 && lastMotionSounds.current[item.id] !== item.startMs) {
        lastMotionSounds.current[item.id] = item.startMs;
        const player = new Audio(soundUrls[item.soundId]);
        player.volume = Math.max(0, Math.min(1, item.soundVolume / 100));
        motionSoundPlayers.current[item.id] = player;
        void player.play().catch(() => setLoadError("Não foi possível reproduzir o efeito sonoro da imagem."));
      }
    }
    for (const item of textLayers) {
      if (item.soundId && soundUrls[item.soundId] && playheadMs >= item.startMs && playheadMs < item.startMs + 100 && lastMotionSounds.current[item.id] !== item.startMs) {
        lastMotionSounds.current[item.id] = item.startMs;
        const player = new Audio(soundUrls[item.soundId]);
        player.volume = Math.max(0, Math.min(1, (item.soundVolume ?? 80) / 100));
        motionSoundPlayers.current[item.id] = player;
        void player.play().catch(() => setLoadError("Não foi possível reproduzir o efeito sonoro."));
      }
    }
  }, [playheadMs, playing, motion, imageOverlays, soundUrls]);
  function updateClip(id: string, patch: Partial<TimelineClip>) {
    setClips(current => current.map(clip => clip.id === id ? { ...clip, ...patch } : clip));
  }
  function beginClipTrim(event: ReactPointerEvent<HTMLSpanElement>, clip: TimelineClip, edge: "start" | "end") {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    trimDragRef.current = { clipId: clip.id, edge, startX: event.clientX, sourceStartMs: clip.sourceStartMs, sourceEndMs: clip.sourceEndMs, timelineStartMs: clip.timelineStartMs, scaleMs: scale, didMove: false };
  }
  function moveClipTrim(event: ReactPointerEvent<HTMLSpanElement>) {
    const drag = trimDragRef.current;
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (!drag.didMove) {
      if (Math.abs(event.clientX - drag.startX) < 4) return;
      drag.didMove = true;
    }
    const canvas = event.currentTarget.closest(".timeline-canvas");
    const rect = canvas?.getBoundingClientRect();
    if (!rect || !rect.width) return;
    const deltaMs = (event.clientX - drag.startX) / rect.width * drag.scaleMs;
    const clip = clips.find(item => item.id === drag.clipId);
    const asset = clip ? assets.find(item => item.id === clip.assetId) : null;
    if (!clip || !asset) return;
    if (drag.edge === "start") {
      const sourceStartMs = Math.max(0, Math.min(drag.sourceEndMs - 250, drag.sourceStartMs + deltaMs));
      const shift = sourceStartMs - drag.sourceStartMs;
      updateClip(drag.clipId, { sourceStartMs, timelineStartMs: Math.max(0, drag.timelineStartMs + shift) });
    } else {
      const maxSourceEndMs = asset.kind === "image" ? 10 * 60 * 1000 : (clip.sourceDurationMs ?? mediaDurations[asset.id] ?? defaultDuration(asset));
      const sourceEndMs = Math.max(drag.sourceStartMs + 250, Math.min(maxSourceEndMs, drag.sourceEndMs + deltaMs));
      updateClip(drag.clipId, { sourceEndMs });
    }
  }
  function endClipTrim(event: ReactPointerEvent<HTMLSpanElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    trimDragRef.current = null;
  }

  function toggleMemberSelection(key: string) { setSelectedMembers(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key]); }
  function createGroup() {
    const members = [...new Set(selectedMembers)];
    if (members.length < 2) return;
    const group: TimelineGroup = { id: crypto.randomUUID(), name: "Grupo " + (groups.length + 1), members };
    setGroups(current => [...current.filter(item => !item.members.some(member => members.includes(member))), group]);
    setSelectedMembers(members);
  }
  function ungroupSelection() {
    const ids = new Set(groups.filter(group => group.members.some(member => selectedMembers.includes(member))).map(group => group.id));
    setGroups(current => current.filter(group => !ids.has(group.id)));
  }
  function beginClipMove(event: ReactPointerEvent<HTMLDivElement>, clip: TimelineClip) {
    if ((event.target as HTMLElement).closest(".clip-trim-edge,.clip-controls,button")) return;
    event.preventDefault(); event.stopPropagation();
    const key = memberKeyForClip(clip.id);
    if (event.ctrlKey || event.metaKey || event.shiftKey) { toggleMemberSelection(key); setSelectedId(clip.id); setSelectedMotionId(null); return; }
    const memberKeys = groupMembersFor(groups, key);
    event.currentTarget.setPointerCapture(event.pointerId);
    clipMoveDragRef.current = { clipId: clip.id, startX: event.clientX, lastX: event.clientX, timelineStartMs: clip.timelineStartMs, memberKeys, didMove: false };
    setSelectedId(clip.id); setSelectedMotionId(null); setSelectedMembers(memberKeys); stopPlayback();
  }
  function moveClipOnTimeline(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = clipMoveDragRef.current;
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (!drag.didMove) {
      if (Math.abs(event.clientX - drag.startX) < 4) return;
      drag.didMove = true;
      drag.lastX = event.clientX;
      return;
    }
    const rect = event.currentTarget.closest(".timeline-canvas")?.getBoundingClientRect();
    if (!rect?.width) return;
    const deltaMs = (event.clientX - drag.lastX) / rect.width * scale;
    drag.lastX = event.clientX;
    const keys = new Set(drag.memberKeys);
    const memberStarts = [...clips.filter(item => keys.has(memberKeyForClip(item.id))).map(item => item.timelineStartMs), ...motion.filter(item => keys.has(memberKeyForMotion(item.id))).map(item => item.startMs)];
    const safeDeltaMs = Math.max(-(memberStarts.length ? Math.min(...memberStarts) : 0), deltaMs);
    setClips(current => current.map(item => keys.has(memberKeyForClip(item.id)) ? { ...item, timelineStartMs: item.timelineStartMs + safeDeltaMs } : item));
    setMotion(current => current.map(item => keys.has(memberKeyForMotion(item.id)) ? (() => { const startMs = item.startMs + safeDeltaMs; return { ...item, startMs, endMs: startMs + (item.endMs - item.startMs), durationMs: item.endMs - item.startMs }; })() : item));
  }
  function endClipMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    clipMoveDragRef.current = null;
  }
  function selectMotionItem(item: MotionGraphic) {
    setSelectedMotionId(item.id);
    setSelectedId(null);
    setSelectedOverlayId(null);
    setActiveTool(item.isCaption ? "captions" : "text");
    setPlayheadMs(item.startMs);
    setPreviewTick(value => value + 1);
    stopPlayback();
  }

  function beginMotionTrim(event: ReactPointerEvent<HTMLSpanElement>, item: MotionGraphic, edge: "start" | "end") {
    if(item.locked)return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    motionTrimDragRef.current = { id: item.id, edge, startX: event.clientX, lastX: event.clientX, startMs: item.startMs, endMs: item.endMs, memberKeys: [memberKeyForMotion(item.id)], didMove: false };
    selectMotionItem(item);
  }
  function beginMotionMove(event: ReactPointerEvent<HTMLButtonElement>, item: MotionGraphic) {
    if (item.locked || (event.target as HTMLElement).closest(".motion-trim-edge")) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    motionTimelineDidMoveRef.current = false;
    const key = memberKeyForMotion(item.id);
    if (event.ctrlKey || event.metaKey || event.shiftKey) { toggleMemberSelection(key); setSelectedMotionId(item.id); setSelectedId(null); setSelectedOverlayId(null); setActiveTool(item.isCaption ? "captions" : "text"); return; }
    const memberKeys = groupMembersFor(groups, key);
    motionTrimDragRef.current = { id: item.id, edge: "move", startX: event.clientX, lastX: event.clientX, startMs: item.startMs, endMs: item.endMs, memberKeys, didMove: false };
    setSelectedMotionId(item.id);
    setSelectedId(null);
    setSelectedOverlayId(null);
    setActiveTool(item.isCaption ? "captions" : "text");
    setSelectedMembers(memberKeys);
  }
  function moveMotionOnTimeline(event: ReactPointerEvent<HTMLElement>) {
    const drag = motionTrimDragRef.current;
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (!drag.didMove) {
      if (Math.abs(event.clientX - drag.startX) < 4) return;
      drag.didMove = true;
      motionTimelineDidMoveRef.current = true;
      if (drag.edge === "move") { drag.lastX = event.clientX; return; }
    }
    const rect = event.currentTarget.closest(".timeline-canvas")?.getBoundingClientRect();
    if (!rect?.width) return;
    const deltaMs = drag.edge === "move" ? (event.clientX - drag.lastX) / rect.width * scale : (event.clientX - drag.startX) / rect.width * scale;
    if (drag.edge === "move") {
      drag.lastX = event.clientX;
      const keys = new Set(drag.memberKeys);
      const memberStarts = [...clips.filter(item => keys.has(memberKeyForClip(item.id))).map(item => item.timelineStartMs), ...motion.filter(item => keys.has(memberKeyForMotion(item.id))).map(item => item.startMs)];
      const safeDeltaMs = Math.max(-(memberStarts.length ? Math.min(...memberStarts) : 0), deltaMs);
      setClips(current => current.map(item => keys.has(memberKeyForClip(item.id)) ? { ...item, timelineStartMs: item.timelineStartMs + safeDeltaMs } : item));
      setMotion(current => current.map(item => keys.has(memberKeyForMotion(item.id)) ? (() => { const startMs = item.startMs + safeDeltaMs; return { ...item, startMs, endMs: startMs + (item.endMs - item.startMs), durationMs: item.endMs - item.startMs }; })() : item));
    } else if (drag.edge === "start") {
      updateMotion(drag.id, { startMs: Math.max(0, Math.min(drag.endMs - 300, drag.startMs + deltaMs)) });
    } else {
      updateMotion(drag.id, { endMs: Math.max(drag.startMs + 300, drag.endMs + deltaMs) });
    }
  }
  function endMotionTrim(event: ReactPointerEvent<HTMLElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const drag = motionTrimDragRef.current;
    if (drag?.didMove) {
      motionTimelineDidMoveRef.current = true;
      if (drag.edge === "move") {
        const moved = motionRef.current.find(item => item.id === drag.id);
        if (moved) setPlayheadMs(moved.startMs);
      }
    }
    motionTrimDragRef.current = null;
  }

  function addToTimeline(asset: MediaAsset, atMs?: number) {
    const clip = createTimelineClip(asset, atMs, timelineInsertAtMs, visualClips);
    setClips(current => [...current, clip]);
    setSelectedId(clip.id);
    setTimelineInsertAtMs(null);
    stopPlayback();
  }

  function insertSelectedTransition() {
    if (!selectedTransition) return;
    const targetClip = visualClips.find(clip => playheadMs >= clip.timelineStartMs && playheadMs < clipEnd(clip))
      ?? visualClips.filter(clip => clip.timelineStartMs >= playheadMs).sort((a, b) => a.timelineStartMs - b.timelineStartMs)[0];
    if (!targetClip) {
      setExportMessage("Posicione o marcador sobre um clipe ou antes do próximo clipe para inserir a transição.");
      return;
    }
    updateClip(targetClip.id, {
      transitionType: selectedTransition,
      transitionMs: selectedTransition === "flash" ? 250 : 600
    });
    setSelectedId(targetClip.id);
    setSelectedMotionId(null);
    setSelectedTransition(null);
    setExportMessage("");
    stopPlayback();
  }

  function removeClip(id: string) {
    setClips(current => current.filter(clip => clip.id !== id));
    if (selectedId === id) setSelectedId(null);
    stopPlayback();
  }

  function moveVisualClip(id: string, direction: -1 | 1) {
    const reordered = reorderVisualClips(visualClips, id, direction);
    if (!reordered) return;
    const byId = new Map(reordered.map(clip => [clip.id, clip]));
    setClips(current => current.map(clip => byId.get(clip.id) ?? clip));
    setSelectedId(id);
    setSelectedMotionId(null);
    stopPlayback();
  }

  function duplicateClip(clip: TimelineClip) {
    const copy = duplicateTimelineClip(clip);
    setClips(current => [...current, copy]);
    setSelectedId(copy.id);
    stopPlayback();
  }

  function splitAtPlayhead() {
    // Prefer the selected clip when the playhead is inside it. This makes
    // splitting predictable even when video and audio overlap in the timeline.
    const selectedAtPlayhead = selectedClip
      && playheadMs > selectedClip.timelineStartMs + 250
      && playheadMs < clipEnd(selectedClip) - 250
      ? selectedClip
      : null;
    const clip = selectedAtPlayhead
      ?? activeVisualClip
      ?? audioClips.find(item => playheadMs > item.timelineStartMs + 250 && playheadMs < clipEnd(item) - 250)
      ?? null;
    if (!clip) return;

    // Non-destructive split: both segments keep the same source asset and
    // retain their original timeline positions. Only source ranges change.
    const split = splitTimelineClipAt(clip, playheadMs);
    if (!split) return;
    setClips(current => current.flatMap(item => item.id === clip.id ? [split.left, split.right] : [item]));
    setSelectedId(split.right.id);
    setSelectedMotionId(null);
    setSelectedMembers([]);
    stopPlayback();
  }

  // Seeking only moves the playhead. Selection belongs to the explicit
  // layer/clip click handlers, otherwise seeking an overlay can silently
  // replace its selection with the clip underneath it.
  function seekTo(ms: number) {
    const bounded = Math.max(0, Math.min(totalDuration, ms));
    setPlayheadMs(bounded);
    setPreviewTick(value => value + 1);
  }

  function togglePlayback() {
    if (playing) { stopPlayback(); return; }
    if (!clips.length) return;
    lastMotionSounds.current = {};
    if (playheadMs >= totalDuration) setPlayheadMs(0);
    setPlaying(true);
  }

  function handleTimelineDragOver(event: DragEvent<HTMLDivElement>) {
    // Chromium/Tauri only treats the timeline as a valid drop target when the
    // drag operation is explicitly accepted during dragover.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleAssetDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const atMs = ratio * scale;
    const customTransitionType = event.dataTransfer.getData("text/transition-type");
    const plainTransitionData = event.dataTransfer.getData("text/plain");
    const transitionType = customTransitionType || (plainTransitionData.startsWith("transition:") ? plainTransitionData.slice("transition:".length) : plainTransitionData);
    if (transitionType && ["fade-black", "fade-white", "flash"].includes(transitionType)) {
      if (event.currentTarget.closest(".audio-track")) return;
      const nextClip = visualClips.filter(clip => clip.timelineStartMs >= atMs - 150).sort((a, b) => a.timelineStartMs - b.timelineStartMs)[0];
      if (!nextClip) { setExportMessage("Solte a transição antes de um clipe para aplicá-la."); return; }
      updateClip(nextClip.id, { transitionType: transitionType as TimelineClip["transitionType"], transitionMs: transitionType === "flash" ? 250 : 600 });
      setSelectedId(nextClip.id); setSelectedMotionId(null); setExportMessage(""); stopPlayback();
      return;
    }
    setTimelineInsertAtMs(atMs);
    setPlayheadMs(atMs);
    const assetId = event.dataTransfer.getData("text/asset-id");
    const clipId = event.dataTransfer.getData("text/timeline-clip-id");
    if (clipId) {
      updateClip(clipId, { timelineStartMs: atMs });
      stopPlayback();
    } else {
      const asset = assets.find(item => item.id === assetId);
      if (asset) addToTimeline(asset, atMs);
    }
  }

  const percentLeft = (clip: TimelineClip) => (clip.timelineStartMs / scale) * 100;
  const percentWidth = (clip: TimelineClip) => Math.max(1.2, (clipDuration(clip) / scale) * 100);


  return <section className="framelab-editor">
    <aside className="editor-tool-rail" aria-label="Ferramentas">
      <button className={activeTool === "media" ? "active" : ""} onClick={() => setActiveTool("media")}><Film size={19}/><small>Mídia</small></button>
      <button className={activeTool === "audio" ? "active" : ""} onClick={() => setActiveTool("audio")}><Music2 size={19}/><small>Áudio</small></button>
      <button className={activeTool === "text" ? "active" : ""} onClick={() => { setActiveTool("text"); if (selectedMotion?.isCaption) setSelectedMotionId(null); setSelectedOverlayId(null); }}><Type size={19}/><small>Texto</small></button>
      <button className={activeTool === "captions" ? "active" : ""} onClick={() => { setActiveTool("captions"); if (selectedMotion && !selectedMotion.isCaption) setSelectedMotionId(null); setSelectedOverlayId(null); }}><Captions size={19}/><small>Legendas</small></button>
      <button className={activeTool === "effects" ? "active" : ""} onClick={() => setActiveTool("effects")}><WandSparkles size={19}/><small>Efeitos</small></button>
      <button className={activeTool === "templates" ? "active" : ""} onClick={() => setActiveTool("templates")}><PanelsTopLeft size={19}/><small>Modelos</small></button>
      <button className="transcription-tool" onClick={() => { setActiveTool("captions"); const clip=clips.find(item=>item.id===selectedId); const asset=clip?assets.find(item=>item.id===clip.assetId):null; onOpenTranscription?.(asset&&(asset.kind==="audio"||asset.kind==="video")?asset.id:undefined,clip&&asset&&(asset.kind==="audio"||asset.kind==="video")?{clipId:clip.id,timelineStartMs:clip.timelineStartMs,sourceStartMs:clip.sourceStartMs,sourceEndMs:clip.sourceEndMs}:undefined); }} title="Gerar legendas automaticamente"><Captions size={19}/><small>Transcrever</small></button>
    </aside>
    <aside className="editor-content-panel">
      {activeTool === "media" && <>
        <div className="editor-panel-head"><div><b>Biblioteca</b><small>{assets.length} arquivo(s) disponíveis</small></div><button className="secondary-action" onClick={onAddMedia}><Plus size={14}/> Importar</button></div>
        {assets.length ? <div className="editor-media-grid">{assets.map(asset => <article key={asset.id} className="editor-media-card" draggable onDragStart={event => event.dataTransfer.setData("text/asset-id", asset.id)}>
          <div className={"editor-media-thumb " + asset.kind}>{asset.kind === "image" && mediaUrls[asset.id] ? <img src={mediaUrls[asset.id]} alt={asset.name}/> : asset.kind === "video" && mediaUrls[asset.id] ? <video src={mediaUrls[asset.id]} muted preload="auto" playsInline/> : asset.kind === "video" ? <Film size={22}/> : <AudioLines size={22}/>}<small>{timeLabel(defaultDuration(asset))}</small></div>
          <b title={asset.name}>{asset.name}</b><button className="icon-action" title="Adicionar à timeline" onClick={() => addToTimeline(asset)}><Plus size={15}/></button>
        </article>)}</div> : <div className="editor-empty"><Film size={24}/><b>Nenhuma mídia importada</b><p>Adicione vídeos, áudios ou imagens para começar.</p><button className="primary" onClick={onAddMedia}><Plus size={14}/> Importar mídia</button></div>}
      </>}
      {activeTool === "audio" && <>
        <div className="editor-panel-head"><div><b>Áudio</b><small>Arquivos de áudio da biblioteca</small></div><button className="secondary-action" onClick={onAddMedia}><Plus size={14}/> Importar</button></div>
        <div className="editor-media-grid">{assets.filter(asset => asset.kind === "audio").map(asset => <article key={asset.id} className="editor-media-card" draggable onDragStart={event => event.dataTransfer.setData("text/asset-id", asset.id)}><div className="editor-media-thumb audio"><AudioLines size={22}/><small>{timeLabel(defaultDuration(asset))}</small></div><b title={asset.name}>{asset.name}</b><button className="icon-action" title="Adicionar à timeline" onClick={() => addToTimeline(asset)}><Plus size={15}/></button></article>)}</div>
        {!assets.some(asset => asset.kind === "audio") && <div className="editor-empty"><AudioLines size={24}/><b>Nenhum áudio importado</b><p>Importe uma faixa para adicioná-la à timeline.</p><button className="primary" onClick={onAddMedia}><Plus size={14}/> Importar áudio</button></div>}
      </>}
      {activeTool === "text" && <>
        <div className="editor-panel-head"><div><b>Textos e composições</b><small>Elementos gráficos independentes das legendas.</small></div><span className="preview-live">{textLayers.length} ELEMENTO(S)</span></div>
        <div className="motion-presets editor-preset-grid">{motionPresets.map(preset => <button key={preset.id} className="motion-preset" onClick={() => addMotion(preset.id)}><b>{preset.label}</b><small>Som: {preset.sound}</small><span>+ Adicionar</span></button>)}</div>
      </>}
      {activeTool === "captions" && <>
        <div className="editor-panel-head"><div><b>Transcrição e legendas</b><small>Gerencie texto falado, traduções, sincronização e karaoke.</small></div><span className="preview-live">{captions.length} LEGENDA(S)</span></div>
        <div className="caption-workspace-actions">
          <button className="primary" type="button" onClick={() => { const clip=clips.find(item=>item.id===selectedId); const asset=clip?assets.find(item=>item.id===clip.assetId):null; onOpenTranscription?.(asset&&(asset.kind==="audio"||asset.kind==="video")?asset.id:undefined,clip&&asset&&(asset.kind==="audio"||asset.kind==="video")?{clipId:clip.id,timelineStartMs:clip.timelineStartMs,sourceStartMs:clip.sourceStartMs,sourceEndMs:clip.sourceEndMs}:undefined); }}><Captions size={14}/> Transcrever mídia</button>
        </div>
        <section className="translation-panel">
          <div className="translation-panel-heading"><div><b><Languages size={15}/> Tradução de legendas</b><small>Traduza apenas as legendas, preservando a sincronização.</small></div><span className="preview-live">{captions.filter(item=>!(item.captionTranslation||"").trim()).length} PENDENTE(S)</span></div>
          <button className="primary translation-action" type="button" onClick={()=>void translateCaptions()} disabled={translationBusy || !captions.some(item => !(item.captionTranslation||"").trim())}>{translationBusy?<><LoaderCircle className="spin" size={14}/> Traduzindo...</>:<><Languages size={14}/> Traduzir legendas sem tradução</>}</button>
          {translationBusy && <button className="secondary-action" type="button" onClick={requestStopAfterCurrentBatch}>Parar após o lote atual</button>}
          {translationBusy && <div className="translation-live-status" role="status" aria-live="polite"><LoaderCircle className="spin" size={17}/><div><b>{translationPhase}</b><span>{translationMessage}</span></div></div>}
          {translationBusy && <div className="translation-progress"><div><span>Legendas traduzidas</span><b>{translationProgress.done}/{translationProgress.total}</b></div><div className="progress-track"><i style={{width:(translationProgress.total?translationProgress.done/translationProgress.total*100:0)+"%"}}/></div></div>}
          {!translationBusy && translationMessage && <p className={"translation-message" + (translationPhase === "Falha identificada" ? " is-error" : translationPhase === "Concluído" ? " is-success" : "")} role="status">{translationMessage}</p>}
          <small className="property-hint">As traduções são salvas automaticamente. Execute novamente para continuar apenas as pendentes.</small>
        </section>
      </>}
      {activeTool === "templates" && <>
        <div className="editor-panel-head"><div><b>Presets de cena</b><small>Layouts prontos com tipografia e posicionamento definidos.</small></div><span className="preview-live">{SCENE_TEMPLATES.length} MODELOS</span></div>
        <div className="scene-template-list">{SCENE_TEMPLATES.map(template => <article className="scene-template-card" key={template.id}>
          <div className="scene-template-preview" aria-hidden="true">{template.preview}</div>
          <b>{template.name}</b><small>{template.description}</small>
          <button className="primary" type="button" onClick={() => applySceneTemplate(template.id)}><Plus size={14}/> Aplicar na posição {timeLabel(playheadMs)}</button>
        </article>)}</div>
        <div className="scene-spec-tools">
          <div><b><FileJson size={15}/> Scene Spec JSON</b><small>Importe Scene Spec ou Super JSON do iHubEnglish. Legendas e tempos por palavra serão preservados.</small></div>
          <label className="secondary-action scene-spec-import"><Upload size={14}/> Importar JSON<input type="file" accept=".json,application/json" onChange={event => void importSceneSpec(event)}/></label>
          <button className="secondary-action" type="button" onClick={exportSceneSpec}><Download size={14}/> Exportar JSON</button>
        </div>
        {sceneSpecMessage && <div className="sound-library-message" role="status">{sceneSpecMessage}</div>}
      </>}
      {activeTool === "effects" && <>
        <div className="editor-panel-head"><div><b>Transições e sons</b><small>Posicione o marcador na timeline, escolha uma transição e insira.</small></div></div>
        <div className="transition-library">
          {[{id:"fade-black",name:"Fade para preto",detail:"Entrada suave a partir do preto",symbol:"◐"},{id:"fade-white",name:"Fade para branco",detail:"Entrada suave a partir do branco",symbol:"◑"},{id:"flash",name:"Flash branco",detail:"Abertura rápida com clarão",symbol:"✦"}].map(item=><button type="button" key={item.id} className={"transition-library-item"+(selectedTransition===item.id?" selected":"")} onClick={()=>setSelectedTransition(item.id as TimelineClip["transitionType"])}><span>{item.symbol}</span><b>{item.name}</b><small>{item.detail}</small><em>{selectedTransition===item.id?"Selecionada":"Selecionar transição"}</em></button>)}
        </div>
        <div className="transition-insert-panel">
          <small>Posição do marcador: <b>{timeLabel(playheadMs)}</b></small>
          <button className="primary" type="button" onClick={insertSelectedTransition} disabled={!selectedTransition || !visualClips.length}><Plus size={14}/> Inserir transição</button>
        </div>
        <div className="editor-panel-head sound-library-heading"><div><b>Biblioteca de sons</b><small>{globalSounds.length} efeito(s) global(is), disponíveis em todos os projetos</small></div></div>
        <div className="sound-library-import">
          <label>Nome do efeito<input value={newSoundName} onChange={event => setNewSoundName(event.target.value)} placeholder="Ex.: Pop, Check, Whoosh"/></label>
          <button className="primary" onClick={() => void importGlobalSound()} disabled={soundBusy}><Plus size={14}/>{soundBusy ? "Importando..." : "Importar áudio"}</button>
          <small>MP3, WAV, OGG, M4A, AAC ou FLAC. O arquivo será copiado para a biblioteca global.</small>
        </div>
        {soundMessage && <div className="sound-library-message" role="status">{soundMessage}</div>}
        {globalSounds.length ? <div className="sound-library-list">{globalSounds.map(sound => <article className="sound-library-row" key={sound.id}>
          <div className="sound-library-icon"><AudioLines size={18}/></div><div className="sound-library-info"><b>{sound.name}</b><small>{sound.fileName}</small></div>
          <button className="icon-action" title="Ouvir efeito" onClick={() => { const audio = new Audio(soundUrls[sound.id]); void audio.play().catch(() => setSoundMessage("Não foi possível reproduzir este arquivo.")); }} disabled={!soundUrls[sound.id]}><Play size={14}/></button>
          <button className="icon-action danger" title="Excluir efeito" onClick={() => void removeGlobalSound(sound.id)}><Trash2 size={14}/></button>
        </article>)}</div> : <div className="editor-empty"><AudioLines size={24}/><b>Sua biblioteca está vazia</b><p>Importe efeitos reais para usar nas animações de texto.</p></div>}
      </>}
    </aside>
    <section className="editor-center">
      <div className="preview-stage"><div className="preview-media-frame" ref={previewFrameRef}>
        {!previewAsset ? <div className="preview-placeholder"><Play size={27}/><span>Seu vídeo aparecerá aqui</span><small>Adicione uma mídia à timeline para visualizar</small></div> :
          !previewUrl ? <div className="preview-placeholder"><span>Não foi possível carregar esta mídia.</span><small>{loadError || "Verifique se o arquivo continua na pasta do projeto."}</small></div> :
          previewAsset.kind === "video" ? <video key={previewAsset.id} ref={videoRef} src={previewUrl} muted={!!previewClip?.muted} controls={!playing} style={{ opacity: previewOpacity, transition: "opacity 40ms linear" }} onLoadedMetadata={event => { const clip = activeVisualClip?.assetId === previewAsset.id ? activeVisualClip : visualClips.find(item => item.assetId === previewAsset.id && playheadMs >= item.timelineStartMs && playheadMs < clipEnd(item)); if (clip) { const target = Math.max(0, (clip.sourceStartMs + playheadMs - clip.timelineStartMs) / 1000); if (Math.abs(event.currentTarget.currentTime - target) > 0.04) event.currentTarget.currentTime = target; } }} onError={() => setLoadError("Formato não suportado pelo preview do sistema.")}/> :
          previewAsset.kind === "audio" ? <div className="audio-preview"><AudioLines size={48}/><b>{previewAsset.name}</b><span>Áudio na timeline</span></div> :
          <img src={previewUrl} alt={previewAsset.name} style={{ opacity: previewOpacity, transform: cameraTransform, transition: "opacity 40ms linear" }}/>} {transitionWhiteOpacity > 0 && <div className="transition-preview-white" style={{opacity:transitionWhiteOpacity}}/>}
        {activeOverlays.map(item=>{const url=mediaUrls[item.assetId];if(!url)return null;const entrance=imageOverlayEntranceState(item,playheadMs);return <div key={item.id} className={"image-overlay-preview"+(selectedOverlayId===item.id?" selected":"")} style={{left:item.x+"%",top:item.y+"%",width:item.width*previewScale,height:item.height*previewScale,transform:entrance.transform,opacity:entrance.opacity}} onPointerDown={event=>overlayPointerDown(event,item,(event.target as HTMLElement).closest(".image-overlay-handle")?"resize":"move")} onPointerMove={overlayPointerMove} onPointerUp={overlayPointerUp} onPointerCancel={overlayPointerUp} onClick={event=>{event.stopPropagation();setSelectedOverlayId(item.id);setSelectedMotionId(null);setSelectedId(null);}}><img src={url} alt="Imagem sobreposta" draggable={false}/>{selectedOverlayId===item.id&&<span className="image-overlay-handle"/>}</div>;})}
        {previewMotion.map(item => {
          const animation = selectedMotion?.id === item.id && !playing ? motionPreviewState(item, item.endMs) : motionPreviewState(item, playheadMs);
          return <div key={item.id} className={"motion-overlay motion-" + item.preset + (item.isCaption ? " caption-overlay" : "") + (selectedMotionId === item.id ? " motion-selected" : "")} style={{ "--motion-color": item.color, "--motion-accent": item.accent, "--motion-size": (item.fontSize * previewScale) + "px", "--motion-x": item.isCaption ? ((100 - (item.captionWidth ?? 90)) / 2) + "%" : item.x + "%", "--motion-y": item.y + "%" , width: item.isCaption ? (item.captionWidth ?? 90) + "%" : undefined, transform: item.isCaption ? "translateY(-50%)" : item.textAlign === "left" ? "translate(0,-50%)" : item.textAlign === "right" ? "translate(-100%,-50%)" : "translate(-50%,-50%)" } as CSSProperties}>
            <span className={"motion-content-group anchor-" + (item.lucideIconAnchor || "left")} style={{ display: item.isCaption ? "block" : "inline-flex", alignItems: "center", justifyContent: "center", gap: Math.max(4, (item.lucideIconSize ?? item.fontSize) * previewScale * 0.22), flexDirection: item.lucideIconAnchor === "top" ? "column" : item.lucideIconAnchor === "bottom" ? "column-reverse" : item.lucideIconAnchor === "right" ? "row-reverse" : "row", transform: animation.transform, transformOrigin: item.textAlign === "left" ? "left center" : item.textAlign === "right" ? "right center" : "center center", opacity: animation.opacity, willChange: "transform,opacity" }} onPointerDown={event => { if(item.locked)return; selectMotionItem(item); event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const rect = event.currentTarget.closest(".preview-media-frame")?.getBoundingClientRect(); if (!rect) return; updateMotion(item.id, item.isCaption ? { y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)) } : { x: Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)), y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)) }); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onClick={event=>{event.stopPropagation();selectMotionItem(item);}}>
              {item.lucideIconName && lucideIconLibrary[item.lucideIconName as LucideIconName] && (() => { const IconView = lucideIconLibrary[item.lucideIconName as LucideIconName]; return <IconView size={(item.lucideIconSize ?? item.fontSize) * previewScale} color={item.lucideIconColor || item.accent} strokeWidth={2.2} aria-hidden="true"/>; })()}
              <span className="motion-main-text" style={{fontFamily:item.fontFamily || "Arial",fontWeight:(item.fontWeight || 900) >= 700 ? 700 : 400,fontSize:item.fontSize * previewScale,textAlign:item.textAlign || "center",background:item.isCaption ? captionBackgroundRgba(item.captionBackgroundColor,item.captionBackgroundOpacity) : "transparent",padding:item.isCaption ? `${item.captionPaddingEm ?? 0.32}em .55em` : "0",borderRadius:"0",boxDecorationBreak:"clone",WebkitBoxDecorationBreak:"clone",display:item.isCaption ? "block" : "inline",width:item.isCaption ? "100%" : undefined,maxWidth:item.isCaption ? "100%" : "90%",boxSizing:"border-box",whiteSpace:"pre-wrap"}}>{item.captionMode === "karaoke" && item.captionWords?.length ? (() => {
                const previewWords = captionWordsForTimeline(item.captionWords, item.startMs, item.endMs);
                const captionPlayheadMs = playheadMs >= item.startMs && playheadMs < item.endMs
                  ? playheadMs
                  : selectedMotion?.id === item.id && !playing ? item.startMs : playheadMs;
                const semanticGroups = captionSemanticGroups(previewWords);
                const activeGroupId = semanticGroups.find(group => captionPlayheadMs >= group.startMs && captionPlayheadMs < group.endMs)?.id;
                return <><span>{previewWords.map((word, index) => {
                  const active = captionPlayheadMs >= word.startMs && captionPlayheadMs < word.endMs;
                  return <span key={index} style={{ color: active ? item.accent : item.color, textShadow: active ? "0 0 12px " + item.accent : "none" }}>{word.text}{index < previewWords.length - 1 ? " " : ""}</span>;
                })}</span>{(semanticGroups.length > 0 || item.captionTranslation) && <><br/><span style={{color:"#d8d4df",fontSize:"0.72em"}}>{semanticGroups.length ? semanticGroups.map((group,index) => <span key={group.id} style={{color:group.id===activeGroupId?item.accent:"#d8d4df",textShadow:group.id===activeGroupId?"0 0 10px "+item.accent:"none"}}>{group.text}{index<semanticGroups.length-1?" ":""}</span>) : item.captionTranslation}</span></>}</>;
              })() : item.captionTranslation && item.captionMode !== "source" ? <>{item.captionEnglish || item.text}<br/><span style={{color:"#d8d4df",fontSize:"0.72em"}}>{item.captionTranslation}</span></> : animation.text}</span>
            </span>
          </div>;
        })}
      </div></div>
      <div className="editor-transport">
        <button className="transport-button" title="Voltar ao início" onClick={() => { stopPlayback(); seekTo(0); }}><SkipBack size={15}/></button>
        <button className="transport-play" onClick={togglePlayback} disabled={!clips.length}>{playing ? <Pause size={17}/> : <Play size={17} fill="currentColor"/>}{playing ? "Pausar" : "Reproduzir"}</button>
        <button className="transport-button" title="Avançar 5 segundos" onClick={() => seekTo(playheadMs + 5000)}><SkipForward size={15}/></button>
        <span className="transport-time">{timeLabel(playheadMs)} / {timeLabel(totalDuration)}</span><button className="secondary-action" onClick={exportIHubSuperJson} disabled={!captions.length} title="Exportar legendas, tempos e grupos semânticos para o iHubEnglish"><FileJson size={14}/> Super JSON</button><button className="primary export-inline" onClick={() => void exportVideo()} disabled={exporting || !visualClips.length}>{exporting ? <LoaderCircle className="spin" size={15}/> : <Download size={15}/>} {exporting ? "Exportando..." : "Exportar MP4"}</button>
      </div>
      {exporting && <div className="export-progress" role="status" aria-label={`Exportando vídeo: ${Math.floor(exportProgress)}%`}><div className="export-progress-track"><div className="export-progress-fill" style={{ width: `${exportProgress}%` }}/></div><span>{Math.floor(exportProgress)}%</span></div>}{exportMessage && <div className="export-status export-error" role="alert">{exportMessage}</div>}
    </section>
    <aside className="editor-properties">
      <div className="editor-panel-head layer-panel-heading"><div><b><Layers size={14}/> Camadas</b><small>Visibilidade, bloqueio e ordem</small></div></div>
      <div className="layer-manager">
        <details className="layer-manager-group"><summary>Imagens</summary>{[...imageOverlays].reverse().map((item,ri)=>{const index=imageOverlays.length-1-ri;return <div key={item.id} className={"layer-manager-row"+(selectedOverlayId===item.id?" selected":"")} onClick={()=>{setSelectedOverlayId(item.id);setSelectedMotionId(null);setSelectedId(null);}}><Image size={14}/><span>{assets.find(asset=>asset.id===item.assetId)?.name||"Imagem"}</span><button type="button" title="Visibilidade" onClick={event=>{event.stopPropagation();updateOverlay(item.id,{visible:item.visible===false});}}><Eye size={13}/></button><button type="button" title="Bloquear" onClick={event=>{event.stopPropagation();updateOverlay(item.id,{locked:!item.locked});}}>{item.locked?<ShieldCheck size={13}/>:<MousePointer2 size={13}/>}</button><button type="button" title="Subir camada" disabled={index===imageOverlays.length-1} onClick={event=>{event.stopPropagation();moveOverlayLayer(item.id,1);}}>↑</button><button type="button" title="Descer camada" disabled={index===0} onClick={event=>{event.stopPropagation();moveOverlayLayer(item.id,-1);}}>↓</button></div>;})}{!imageOverlays.length&&<small className="layer-empty">Nenhuma imagem</small>}</details>
        <details className="layer-manager-group"><summary>Textos e composições</summary>{[...textLayers].reverse().map(item=>{const index=motion.findIndex(layer=>layer.id===item.id);return <div key={item.id} className={"layer-manager-row"+(selectedMotionId===item.id?" selected":"")} onClick={()=>selectMotionItem(item)}><Type size={14}/><span>{(item.text||"Texto").slice(0,24)}</span><button type="button" title="Visibilidade" onClick={event=>{event.stopPropagation();updateMotion(item.id,{visible:item.visible===false});}}><Eye size={13}/></button><button type="button" title="Bloquear" onClick={event=>{event.stopPropagation();updateMotion(item.id,{locked:!item.locked});}}>{item.locked?<ShieldCheck size={13}/>:<MousePointer2 size={13}/>}</button><button type="button" title="Subir camada" disabled={index===motion.length-1} onClick={event=>{event.stopPropagation();moveMotionLayer(item.id,1);}}>↑</button><button type="button" title="Descer camada" disabled={index===0} onClick={event=>{event.stopPropagation();moveMotionLayer(item.id,-1);}}>↓</button></div>;})}{!textLayers.length&&<small className="layer-empty">Nenhum texto ou composição</small>}</details>
         <details className="layer-manager-group"><summary>Transcrição e legendas</summary>{[...captions].reverse().map(item=>{const index=motion.findIndex(layer=>layer.id===item.id);return <div key={item.id} className={"layer-manager-row"+(selectedMotionId===item.id?" selected":"")} onClick={()=>selectMotionItem(item)}><Captions size={14}/><span>{(item.captionEnglish||item.text||"Legenda").slice(0,24)}</span><button type="button" title="Visibilidade" onClick={event=>{event.stopPropagation();updateMotion(item.id,{visible:item.visible===false});}}><Eye size={13}/></button><button type="button" title="Bloquear" onClick={event=>{event.stopPropagation();updateMotion(item.id,{locked:!item.locked});}}>{item.locked?<ShieldCheck size={13}/>:<MousePointer2 size={13}/>}</button><button type="button" title="Subir camada" disabled={index===motion.length-1} onClick={event=>{event.stopPropagation();moveMotionLayer(item.id,1);}}>↑</button><button type="button" title="Descer camada" disabled={index===0} onClick={event=>{event.stopPropagation();moveMotionLayer(item.id,-1);}}>↓</button></div>;})}{!captions.length&&<small className="layer-empty">Nenhuma legenda</small>}</details>
      </div>
      {selectedOverlay ? <><div className="editor-panel-head"><div><b>Imagem sobreposta</b><small>Camada independente</small></div></div><div className="properties-scroll"><div className="property-section"><b>Dimensões proporcionais</b><label>Largura <strong>{Math.round(selectedOverlay.width)} px</strong><input type="range" min="60" max="1080" value={selectedOverlay.width} onChange={event=>{const width=Number(event.target.value);updateOverlay(selectedOverlay.id,{width,height:width/(selectedOverlay.width/Math.max(1,selectedOverlay.height))});}}/></label><small>Arraste a alça no canto inferior direito para redimensionar diretamente no preview.</small></div><div className="property-section"><b>Animação de entrada</b><label>Estilo<select value={selectedOverlay.entranceAnimation||"none"} onChange={event=>updateOverlay(selectedOverlay.id,{entranceAnimation:event.target.value as ImageOverlay["entranceAnimation"]})}><option value="none">Sem animação</option><option value="fade">Aparecer suavemente</option><option value="slide-left">Entrar pela esquerda</option><option value="slide-right">Entrar pela direita</option><option value="slide-up">Entrar por baixo</option><option value="slide-down">Entrar por cima</option></select></label>{(selectedOverlay.entranceAnimation||"none")!=="none"&&<label>Duração <strong>{((selectedOverlay.entranceDurationMs??600)/1000).toFixed(1)} s</strong><input type="range" min="100" max="2000" step="100" value={selectedOverlay.entranceDurationMs??600} onChange={event=>updateOverlay(selectedOverlay.id,{entranceDurationMs:Number(event.target.value)})}/></label>}</div><div className="property-section"><b>Tempo</b><label>Início (s)<input type="number" min="0" step="0.1" value={(selectedOverlay.startMs/1000).toFixed(1)} onChange={event=>updateOverlay(selectedOverlay.id,{startMs:Math.max(0,Number(event.target.value)*1000)})}/></label><label>Saída (s)<input type="number" min={(selectedOverlay.startMs+100)/1000} step="0.1" value={(selectedOverlay.endMs/1000).toFixed(1)} onChange={event=>{const value=Number(event.target.value);if(Number.isFinite(value))updateOverlay(selectedOverlay.id,{endMs:Math.max(selectedOverlay.startMs+100,value*1000)});}}/></label><div className="overlay-duration-actions"><button type="button" title="Diminuir saída em 0,1 segundo" disabled={selectedOverlay.endMs<=selectedOverlay.startMs+100} onClick={()=>updateOverlay(selectedOverlay.id,{endMs:Math.max(selectedOverlay.startMs+100,selectedOverlay.endMs-100)})}>− 0,1 s</button><button type="button" title="Aumentar saída em 0,1 segundo" onClick={()=>updateOverlay(selectedOverlay.id,{endMs:selectedOverlay.endMs+100})}>+ 0,1 s</button><button type="button" title="Estender a imagem até o fim do restante da timeline" onClick={()=>updateOverlay(selectedOverlay.id,{endMs:Math.max(selectedOverlay.startMs+100,timelineContentEndMs)})}>Até o fim da timeline</button></div></div><div className="property-section"><b>Efeito sonoro da imagem</b><label>Som<select value={selectedOverlay.soundId||""} onChange={event=>updateOverlay(selectedOverlay.id,{soundId:event.target.value})}><option value="">Sem efeito sonoro</option>{globalSounds.map(sound=><option key={sound.id} value={sound.id}>{sound.name}</option>)}</select></label><label>Volume <strong>{selectedOverlay.soundVolume}%</strong><input type="range" min="0" max="100" value={selectedOverlay.soundVolume} onChange={event=>updateOverlay(selectedOverlay.id,{soundVolume:Number(event.target.value)})}/></label></div><div className="property-section"><b>Posição</b><label>Horizontal (%)<input type="range" min="0" max="100" value={selectedOverlay.x} onChange={event=>updateOverlay(selectedOverlay.id,{x:Number(event.target.value)})}/></label><label>Vertical (%)<input type="range" min="0" max="100" value={selectedOverlay.y} onChange={event=>updateOverlay(selectedOverlay.id,{y:Number(event.target.value)})}/></label></div><button className="danger-action property-delete" onClick={()=>removeOverlay(selectedOverlay.id)}>Excluir imagem</button></div></> : selectedMotion ? <>
        <div className="editor-panel-head"><div><b>{selectedMotion.isCaption ? "Propriedades da legenda" : "Propriedades do texto"}</b><small>{selectedMotion.isCaption ? "Conteúdo falado, estilo, fundo e sincronização." : "Tipografia, composição, animação e efeitos."}</small></div></div>
        {selectedMotion.isCaption && <div className="caption-quick-actions">
          <button type="button" className="secondary-action" onClick={splitSelectedCaption} title="Dividir legenda"><Scissors size={12}/> Dividir</button>
          <button type="button" className="secondary-action" onClick={()=>mergeSelectedCaption("previous")} disabled={!captions.some(item=>item.id!==selectedMotion.id&&item.endMs<=selectedMotion.startMs)} title="Mesclar com a anterior">Mesclar ant.</button>
          <button type="button" className="secondary-action" onClick={()=>mergeSelectedCaption("next")} disabled={!captions.some(item=>item.id!==selectedMotion.id&&item.startMs>=selectedMotion.endMs)} title="Mesclar com a próxima">Mesclar próx.</button>
          <button type="button" className="secondary-action" onClick={duplicateSelectedCaption} title="Duplicar legenda"><Copy size={12}/> Duplicar</button>
        </div>}
        <div className="properties-scroll">
          {selectedMotion.isCaption ? <>
            <details open className="property-section"><summary>Conteúdo e idioma</summary>
              <div className="caption-translate-actions"><b>Traduzir legenda</b><small>Idioma de origem: {selectedMotion.captionSourceLanguage || "automático"}.</small><div><button type="button" className="secondary-action" disabled={singleCaptionTranslationBusy} onClick={()=>void translateSelectedCaption("English")}>{singleCaptionTranslationBusy?<LoaderCircle className="spin" size={13}/>:<Languages size={13}/>} Para inglês</button><button type="button" className="secondary-action" disabled={singleCaptionTranslationBusy} onClick={()=>void translateSelectedCaption("Português brasileiro")}>{singleCaptionTranslationBusy?<LoaderCircle className="spin" size={13}/>:<Languages size={13}/>} Para PT-BR</button></div>{translationMessage&&!translationBusy&&<small className={translationPhase==="Falha identificada"?"is-error":"is-success"}>{translationMessage}</small>}</div>
              <label>Modo<select value={selectedMotion.captionMode || (selectedMotion.captionTranslation ? "bilingual" : "source")} onChange={event=>updateMotion(selectedMotion.id,{captionMode:event.target.value as MotionGraphic["captionMode"]})}><option value="source">Original</option><option value="bilingual" disabled={!selectedMotion.captionTranslation}>Original + tradução</option><option value="karaoke" disabled={!selectedMotion.captionWords?.length}>Karaoke por palavra</option></select></label>
              <label>Texto original<textarea className="motion-textarea" rows={5} value={selectedMotion.captionEnglish || selectedMotion.text} onChange={event=>updateMotion(selectedMotion.id,{text:event.target.value,captionEnglish:event.target.value})} maxLength={1200}/></label>
              <label>Tradução<textarea className="motion-textarea" rows={3} value={selectedMotion.captionTranslation || ""} onChange={event=>updateMotion(selectedMotion.id,{captionTranslation:event.target.value})} maxLength={1200} placeholder="Texto traduzido"/></label>
            </details>
            <details open className="property-section"><summary>Estilo da legenda</summary>
              <label>Fonte<select value={selectedMotion.fontFamily || "Arial"} onChange={event=>updateMotion(selectedMotion.id,{fontFamily:event.target.value})}><option value="Arial">Arial</option><option value="Georgia">Georgia</option><option value="Impact">Impact</option><option value="Trebuchet MS">Trebuchet MS</option><option value="Verdana">Verdana</option><option value="Courier New">Courier New</option></select></label>
              <label>Tamanho<input type="number" min="18" max="180" value={selectedMotion.fontSize} onChange={event=>updateMotion(selectedMotion.id,{fontSize:Math.max(18,Math.min(180,Number(event.target.value)))})}/></label>
              <label>Peso<select value={selectedMotion.fontWeight || 900} onChange={event=>updateMotion(selectedMotion.id,{fontWeight:Number(event.target.value)})}><option value={400}>Normal</option><option value={600}>Semibold</option><option value={700}>Negrito</option><option value={900}>Extra negrito</option></select></label>
              <label>Alinhamento<select value={selectedMotion.textAlign || "center"} onChange={event=>updateMotion(selectedMotion.id,{textAlign:event.target.value as MotionGraphic["textAlign"]})}><option value="left">Esquerda</option><option value="center">Centralizado</option><option value="right">Direita</option></select></label>
              <div className="motion-colors"><label>Texto<input type="color" value={selectedMotion.color} onChange={event=>updateMotion(selectedMotion.id,{color:event.target.value})}/></label><label>Palavra ativa<input type="color" value={selectedMotion.accent} onChange={event=>updateMotion(selectedMotion.id,{accent:event.target.value})}/></label></div>
              <button type="button" className="secondary-action caption-apply-all" onClick={applySelectedCaptionStyleToAll}><Copy size={13}/> Aplicar este estilo a todas as legendas</button>
              <button type="button" className="secondary-action caption-apply-all" onClick={applySelectedCaptionStyleToSelection} disabled={!captions.some(item=>selectedMembers.includes("motion:"+item.id))}><Copy size={13}/> Aplicar às legendas selecionadas</button>
              <div className="caption-style-controls"><b>Fundo e área</b>
                <label>Cor do fundo<input type="color" value={selectedMotion.captionBackgroundColor || "#000000"} onChange={event=>updateMotion(selectedMotion.id,{captionBackgroundColor:event.target.value})}/></label>
                <label>Opacidade <strong>{Math.round((selectedMotion.captionBackgroundOpacity ?? 0.76)*100)}%</strong><input type="range" min="0" max="100" value={Math.round((selectedMotion.captionBackgroundOpacity ?? 0.76)*100)} onChange={event=>updateMotion(selectedMotion.id,{captionBackgroundOpacity:Number(event.target.value)/100})}/></label>
                <label>Largura <strong>{selectedMotion.captionWidth ?? 90}%</strong><input type="range" min="60" max="100" value={selectedMotion.captionWidth ?? 90} onChange={event=>updateMotion(selectedMotion.id,{captionWidth:Number(event.target.value)})}/></label>
                <label>Espaçamento interno <strong>{(selectedMotion.captionPaddingEm ?? 0.32).toFixed(2)} em</strong><input type="range" min="0" max="1" step="0.02" value={selectedMotion.captionPaddingEm ?? 0.32} onChange={event=>updateMotion(selectedMotion.id,{captionPaddingEm:Number(event.target.value)})}/></label>
              </div>
            </details>
            <details open className="property-section"><summary>Tempo e posição</summary>
              <div className="motion-fields two"><label>Início (s)<input type="number" min="0" step="0.1" value={(selectedMotion.startMs/1000).toFixed(1)} onChange={event=>updateMotion(selectedMotion.id,{startMs:Math.max(0,Number(event.target.value)*1000)})}/></label><label>Saída (s)<input type="number" min={(selectedMotion.startMs/1000+0.3).toFixed(1)} step="0.1" value={(selectedMotion.endMs/1000).toFixed(1)} onChange={event=>updateMotion(selectedMotion.id,{endMs:Math.max(selectedMotion.startMs+300,Number(event.target.value)*1000)})}/></label></div>
              <label>Vertical <strong>{Math.round(selectedMotion.y)}%</strong><input type="range" min="0" max="100" value={selectedMotion.y} onChange={event=>updateMotion(selectedMotion.id,{y:Number(event.target.value)})}/></label>
              <button className="secondary-action" onClick={()=>updateMotion(selectedMotion.id,{y:82})}>Restaurar posição vertical</button>
            </details>
          </> : <>
            <details open className="property-section"><summary>Texto</summary>
              <label>Conteúdo<textarea className="motion-textarea" rows={6} value={selectedMotion.text} onChange={event=>updateMotion(selectedMotion.id,{text:event.target.value})} maxLength={1200} placeholder="Digite sua frase. Use Enter para criar uma nova linha."/></label>
              <details className="lucide-library">
                <summary>Biblioteca de ícones</summary>
                <div className="lucide-library-heading"><b>Biblioteca Lucide SVG</b><small>Ícone vetorial ancorado ao texto</small></div>
                <label className="lucide-search"><Search size={14}/><input value={iconSearch} onChange={event=>setIconSearch(event.target.value)} placeholder="Buscar ícone..."/></label>
                <div className="lucide-icon-grid">{lucideIconPickerNames.filter(name=>name.toLowerCase().includes(iconSearch.trim().toLowerCase())).map(name=>{const IconView=lucideIconLibrary[name];return <button type="button" key={name} className={"lucide-icon-option"+(selectedMotion.lucideIconName===name?" selected":"")} title={name} aria-label={name} onClick={()=>updateMotion(selectedMotion.id,{lucideIconName:selectedMotion.lucideIconName===name?undefined:name})}><IconView size={19}/><small>{name}</small></button>;})}</div>
                {selectedMotion.lucideIconName && <><div className="motion-fields two"><label>Âncora<select value={selectedMotion.lucideIconAnchor || "left"} onChange={event=>updateMotion(selectedMotion.id,{lucideIconAnchor:event.target.value as MotionGraphic["lucideIconAnchor"]})}><option value="left">À esquerda do texto</option><option value="right">À direita do texto</option><option value="top">Acima do texto</option><option value="bottom">Abaixo do texto</option></select></label><label>Tamanho (px)<input type="number" min="12" max="180" value={selectedMotion.lucideIconSize ?? selectedMotion.fontSize} onChange={event=>updateMotion(selectedMotion.id,{lucideIconSize:Math.max(12,Math.min(180,Number(event.target.value)))})}/></label></div><label>Cor do ícone<input type="color" value={selectedMotion.lucideIconColor || selectedMotion.accent} onChange={event=>updateMotion(selectedMotion.id,{lucideIconColor:event.target.value})}/></label><button type="button" className="secondary-action" onClick={()=>updateMotion(selectedMotion.id,{lucideIconName:undefined})}>Remover ícone SVG</button></>}
              </details>
              <label>Emoji ou símbolo (opcional)<input value={selectedMotion.icon || ""} onChange={event=>updateMotion(selectedMotion.id,{icon:event.target.value})} maxLength={12} placeholder="Ex.: ★  →  ✓"/></label>
            </details>
            <details open className="property-section"><summary>Tempo</summary><div className="motion-fields two"><label>Início (s)<input type="number" min="0" step="0.1" value={(selectedMotion.startMs/1000).toFixed(1)} onChange={event=>updateMotion(selectedMotion.id,{startMs:Math.max(0,Number(event.target.value)*1000)})}/></label><label>Saída (s)<input type="number" min={(selectedMotion.startMs/1000+0.3).toFixed(1)} step="0.1" value={(selectedMotion.endMs/1000).toFixed(1)} onChange={event=>updateMotion(selectedMotion.id,{endMs:Math.max(selectedMotion.startMs+300,Number(event.target.value)*1000)})}/></label></div></details>
            <details open className="property-section"><summary>Estilo e animação</summary>
              <label>Fonte<select value={selectedMotion.fontFamily || "Arial"} onChange={event=>updateMotion(selectedMotion.id,{fontFamily:event.target.value})}><option value="Arial">Arial</option><option value="Georgia">Georgia</option><option value="Impact">Impact</option><option value="Trebuchet MS">Trebuchet MS</option><option value="Verdana">Verdana</option><option value="Courier New">Courier New</option></select></label>
              <label>Tamanho<input type="number" min="18" max="180" value={selectedMotion.fontSize} onChange={event=>updateMotion(selectedMotion.id,{fontSize:Math.max(18,Math.min(180,Number(event.target.value)))})}/></label>
              <label>Peso<select value={selectedMotion.fontWeight || 900} onChange={event=>updateMotion(selectedMotion.id,{fontWeight:Number(event.target.value)})}><option value={400}>Normal</option><option value={600}>Semibold</option><option value={700}>Negrito</option><option value={900}>Extra negrito</option></select></label>
              <label>Alinhamento<select value={selectedMotion.textAlign || "center"} onChange={event=>updateMotion(selectedMotion.id,{textAlign:event.target.value as MotionGraphic["textAlign"]})}><option value="left">Esquerda</option><option value="center">Centralizado</option><option value="right">Direita</option></select></label>
              <label>Animação<select value={selectedMotion.preset} onChange={event=>updateMotion(selectedMotion.id,{preset:event.target.value as MotionGraphic["preset"]})}>{motionPresets.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
              {selectedMotion.preset==="typewriter"
                ? <label>Duração da escrita <strong>{((selectedMotion.typewriterDurationMs ?? 1500)/1000).toFixed(2)} s</strong><input type="range" min="100" max="5000" step="50" value={Math.max(100,Math.min(5000,selectedMotion.typewriterDurationMs ?? 1500))} onChange={event=>updateMotion(selectedMotion.id,{typewriterDurationMs:Number(event.target.value)})}/></label>
                : <label>Tempo da animação de entrada <strong>{((selectedMotion.entranceDurationMs ?? 700)/1000).toFixed(2)} s</strong><input type="range" min="100" max="5000" step="50" value={Math.max(100,Math.min(5000,selectedMotion.entranceDurationMs ?? 700))} onChange={event=>updateMotion(selectedMotion.id,{entranceDurationMs:Number(event.target.value)})}/></label>}
              <label>Efeito sonoro<select value={selectedMotion.soundId || ""} onChange={event=>updateMotion(selectedMotion.id,{soundId:event.target.value,sound:"none"})}><option value="">Sem efeito sonoro</option>{globalSounds.map(sound=><option key={sound.id} value={sound.id}>{sound.name}</option>)}</select></label>
              <label>Volume do efeito <strong>{selectedMotion.soundVolume ?? 80}%</strong><input type="range" min="0" max="100" value={selectedMotion.soundVolume ?? 80} onChange={event=>updateMotion(selectedMotion.id,{soundVolume:Number(event.target.value)})}/></label>
              <div className="motion-colors"><label>Texto<input type="color" value={selectedMotion.color} onChange={event=>updateMotion(selectedMotion.id,{color:event.target.value})}/></label><label>Destaque<input type="color" value={selectedMotion.accent} onChange={event=>updateMotion(selectedMotion.id,{accent:event.target.value})}/></label></div>
            </details>
            <details open className="property-section"><summary>Posição</summary><label>Horizontal <strong>{Math.round(selectedMotion.x)}%</strong><input type="range" min="0" max="100" value={selectedMotion.x} onChange={event=>updateMotion(selectedMotion.id,{x:Number(event.target.value)})}/></label><label>Vertical <strong>{Math.round(selectedMotion.y)}%</strong><input type="range" min="0" max="100" value={selectedMotion.y} onChange={event=>updateMotion(selectedMotion.id,{y:Number(event.target.value)})}/></label><button className="secondary-action" onClick={()=>updateMotion(selectedMotion.id,{x:50,y:50})}>Centralizar</button></details>
          </>}
          <button className="danger-action property-delete" onClick={()=>removeMotion(selectedMotion.id)}>Excluir {selectedMotion.isCaption ? "legenda" : "texto"}</button>
        </div>
      </> : <>
        <div className="editor-panel-head"><div><b>Ajustes do clipe</b><small>{selectedAsset?.name ?? "Selecione um clipe na timeline"}</small></div></div>
        <div className="properties-scroll">
          {selectedClip && selectedAsset ? <>
            <div className="trim-heading"><b><Scissors size={14}/> Ajustes do clipe</b><span>{timeLabel(selectedDuration)}</span></div>
            {selectedId === selectedClip.id && (selectedAsset.kind === "audio" || selectedAsset.kind === "video") && <button className="primary transcription-clip-action" type="button" onClick={() => onOpenTranscription?.(selectedAsset.id, { clipId: selectedClip.id, timelineStartMs: selectedClip.timelineStartMs, sourceStartMs: selectedClip.sourceStartMs, sourceEndMs: selectedClip.sourceEndMs })}><Captions size={14}/> Transcrever este clipe</button>}
            <label className="property-control">Início do arquivo <strong>{timeLabel(selectedClip.sourceStartMs)}</strong><input type="range" min={0} max={Math.max(1000, selectedSourceDuration - 250)} step={100} value={selectedClip.sourceStartMs} onChange={event => updateClip(selectedClip.id, { sourceStartMs: Math.min(Number(event.target.value), selectedClip.sourceEndMs - 250) })}/><input className="numeric-time-input" type="number" min="0" max={Math.max(0, selectedClip.sourceEndMs-250)} step="0.1" value={(selectedClip.sourceStartMs/1000).toFixed(1)} aria-label="Início do arquivo em segundos" onChange={event=>{const value=Number(event.target.value);if(event.target.value!==""&&Number.isFinite(value))updateClip(selectedClip.id,{sourceStartMs:Math.max(0,Math.min(value*1000,selectedClip.sourceEndMs-250))});}}/></label>
            <label className="property-control">Fim do arquivo <strong>{timeLabel(selectedClip.sourceEndMs)}</strong><input type="range" min={250} max={Math.max(250, selectedSourceDuration)} step={100} value={Math.min(selectedClip.sourceEndMs, selectedSourceDuration)} onChange={event => updateClip(selectedClip.id, { sourceEndMs: Math.max(Number(event.target.value), selectedClip.sourceStartMs + 250) })}/><input className="numeric-time-input" type="number" min={(selectedClip.sourceStartMs+250)/1000} max={selectedSourceDuration/1000} step="0.1" value={(selectedClip.sourceEndMs/1000).toFixed(1)} aria-label="Fim do arquivo em segundos" onChange={event=>{const value=Number(event.target.value);if(event.target.value!==""&&Number.isFinite(value))updateClip(selectedClip.id,{sourceEndMs:Math.max(selectedClip.sourceStartMs+250,Math.min(value*1000,selectedSourceDuration))});}}/></label>
            <div className="clip-order-controls"><span>Ordem de exibição</span><div><button className="secondary-action" onClick={() => moveVisualClip(selectedClip.id, -1)} disabled={visualClips.slice().sort((a,b)=>a.timelineStartMs-b.timelineStartMs)[0]?.id === selectedClip.id}><ChevronLeft size={14}/> Antes</button><button className="secondary-action" onClick={() => moveVisualClip(selectedClip.id, 1)} disabled={visualClips.slice().sort((a,b)=>a.timelineStartMs-b.timelineStartMs)[visualClips.length - 1]?.id === selectedClip.id}>Depois <ChevronRight size={14}/></button></div></div>
            {selectedAsset.kind === "video" && <div className="clip-toggle-row"><span><Volume2 size={14}/> Áudio original do vídeo</span><button className={selectedClip.muted ? "mute-toggle muted" : "mute-toggle"} onClick={() => updateClip(selectedClip.id, { muted: !selectedClip.muted })}>{selectedClip.muted ? <><VolumeX size={14}/> Silenciado</> : <><Volume2 size={14}/> Com som</>}</button></div>}
            {(selectedAsset.kind === "audio" || selectedAsset.kind === "video") && <label className="volume-control">Volume {selectedAsset.kind === "audio" ? "do áudio" : "do vídeo"} <strong>{selectedClip.volume}%</strong><input type="range" min={0} max={100} value={selectedClip.volume} onChange={event => updateClip(selectedClip.id, { volume: Number(event.target.value) })}/></label>}
            {selectedAsset.kind === "image" && <div className="property-section"><b>Movimento da imagem</b><label className="property-control">Movimento de câmera<select value={selectedClip.cameraMotion ?? "none"} onChange={event => updateClip(selectedClip.id, { cameraMotion: event.target.value as TimelineClip["cameraMotion"] })}><option value="none">Sem movimento</option><option value="zoom-in">Zoom lento de aproximação</option><option value="zoom-out">Zoom lento de afastamento</option><option value="pan-left">Câmera para a esquerda</option><option value="pan-right">Câmera para a direita</option><option value="pan-up">Câmera para cima</option><option value="pan-down">Câmera para baixo</option></select></label></div>}
            {selectedAsset.kind !== "audio" && <div className="property-section"><b>Transição de entrada</b><label className="property-control">Tipo<select value={selectedClip.transitionType ?? "fade-black"} onChange={event=>updateClip(selectedClip.id,{transitionType:event.target.value as TimelineClip["transitionType"]})}><option value="fade-black">Fade para preto</option><option value="fade-white">Fade para branco</option><option value="flash">Flash branco</option></select></label><label className="property-control">Duração <strong>{selectedClip.transitionMs ?? 500} ms</strong><input type="range" min={0} max={2000} step={50} value={selectedClip.transitionMs ?? 500} onChange={event => updateClip(selectedClip.id, { transitionMs: Number(event.target.value) })}/></label><button className="secondary-action" onClick={()=>updateClip(selectedClip.id,{transitionMs:0})}>Remover transição</button></div>}
            <label className="property-control">Posição na timeline <strong>{timeLabel(selectedClip.timelineStartMs)}</strong><input type="range" min={0} max={Math.max(1000, totalDuration + 10000)} step={100} value={selectedClip.timelineStartMs} onChange={event => updateClip(selectedClip.id, { timelineStartMs: Number(event.target.value) })}/><input className="numeric-time-input" type="number" min="0" step="0.1" value={(selectedClip.timelineStartMs/1000).toFixed(1)} aria-label="Posição na timeline em segundos" onChange={event=>{const value=Number(event.target.value);if(event.target.value!==""&&Number.isFinite(value))updateClip(selectedClip.id,{timelineStartMs:Math.max(0,value*1000)});}}/></label>
          </> : <div className="editor-empty"><MousePointer2 size={24}/><b>Nenhum clipe selecionado</b><p>Adicione uma mídia à timeline para ajustar seus parâmetros.</p></div>}
        </div>
      </>}
    </aside>
    <section className="editor-timeline">
      <div className="timeline-toolbar">
        <div className="timeline-toolbar-actions">
          <small className="timeline-group-hint">Clique para posicionar a mídia · Ctrl + clique para agrupar</small>
          <button className="secondary-action" onClick={()=>void addImageOverlay()}><Image size={13}/> Imagem sobreposta</button>
          <button className="secondary-action" onClick={createGroup} disabled={selectedMembers.length < 2}><Copy size={13}/> Agrupar ({selectedMembers.length})</button>
          <button className="secondary-action" onClick={ungroupSelection} disabled={!groups.some(group => group.members.some(member => selectedMembers.includes(member)))}>Desagrupar</button>
          <button className="secondary-action" onClick={splitAtPlayhead} disabled={!clips.some(clip => playheadMs > clip.timelineStartMs + 250 && playheadMs < clipEnd(clip) - 250)} title="Divide o clipe selecionado ou o clipe sob o cursor, seja vídeo ou áudio"><Scissors size={13}/> Dividir no cursor</button>
          <button className="secondary-action" onClick={() => selectedClip && duplicateClip(selectedClip)} disabled={!selectedClip}><Copy size={13}/> Duplicar</button>
          <button className="secondary-action danger-action" onClick={() => selectedClip && removeClip(selectedClip.id)} disabled={!selectedClip}><Trash2 size={13}/> Excluir selecionado</button>
          <button className="secondary-action" onClick={() => { stopPlayback(); setClips([]); setSelectedId(null); setPlayheadMs(0); }} disabled={!clips.length}><Trash2 size={13}/> Limpar timeline</button>
        </div>
        <label className="timeline-zoom">Zoom <input type="range" min="50" max="200" step="10" value={timelineZoom} onChange={event => setTimelineZoom(Number(event.target.value))}/></label>
      </div>
      
      <div className="timeline-lanes"><div className="timeline-ruler timeline-grid-ruler"><div className="timeline-track-label-spacer"/><div className="timeline-ruler-canvas" style={{width:Math.max(100,timelineZoom)+"%"}} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();if(!rect.width)return;const atMs=Math.max(0,Math.min(scale,((event.clientX-rect.left)/rect.width)*scale));setTimelineInsertAtMs(atMs);setPlayheadMs(atMs);setPreviewTick(value=>value+1);stopPlayback();}}>{Array.from({length:Math.ceil(scale/1000)+1},(_,second)=>second).map(second=><span key={second} className={second%5===0?"major":""} style={{left:(second*1000/scale*100)+"%"}}>{second%5===0?timeLabel(second*1000):""}</span>)}</div></div>
        <div className="timeline-track timeline-positioned-track"><div className="track-label">VÍDEO / IMAGEM</div><div className="track-clips timeline-canvas" style={{width:Math.max(100,timelineZoom)+"%"}} onClick={event=>{if((event.target as HTMLElement).closest(".clip-controls,.clip-trim-edge"))return;const rect=event.currentTarget.getBoundingClientRect();if(!rect.width)return;const atMs=Math.max(0,Math.min(scale,((event.clientX-rect.left)/rect.width)*scale));setTimelineInsertAtMs(atMs);setPlayheadMs(atMs);setPreviewTick(value=>value+1);stopPlayback();}} onDragOver={handleTimelineDragOver} onDragEnter={handleTimelineDragOver} onDrop={handleAssetDrop}>
          {visualClips.map(clip => {
            const asset = assets.find(item => item.id === clip.assetId);
            if (!asset) return null;
            return <TimelineClipItem
              key={clip.id}
              clip={clip}
              asset={asset}
              left={percentLeft(clip)}
              width={percentWidth(clip)}
              selected={selectedId === clip.id}
              grouped={groups.some(group => group.members.includes(memberKeyForClip(clip.id)))}
              multiSelected={selectedMembers.includes(memberKeyForClip(clip.id))}
              mediaUrl={mediaUrls[asset.id]}
              onPointerDown={event => beginClipMove(event, clip)}
              onPointerMove={moveClipOnTimeline}
              onPointerUp={endClipMove}
              onSelect={() => { setSelectedId(clip.id); setSelectedMotionId(null); seekTo(clip.timelineStartMs); }}
              onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(clip.id); setSelectedMotionId(null); seekTo(clip.timelineStartMs); } }}
              onTrimStart={(event, edge) => beginClipTrim(event, clip, edge)}
              onTrimMove={moveClipTrim}
              onTrimEnd={endClipTrim}
              onDuplicate={() => duplicateClip(clip)}
              onRemove={() => removeClip(clip.id)}
            />;
          })}
          {!visualClips.length&&<span className="track-hint">Arraste vídeos ou imagens da biblioteca para cá</span>}<div className="timeline-cursor" style={{left:playheadMs/scale*100+"%"}}/>
        </div></div>
        <div className="timeline-track timeline-positioned-track audio-track"><div className="track-label">ÁUDIO</div><div className="track-clips timeline-canvas" style={{width:Math.max(100,timelineZoom)+"%"}} onClick={event=>{if((event.target as HTMLElement).closest(".clip-controls,.clip-trim-edge"))return;const rect=event.currentTarget.getBoundingClientRect();if(!rect.width)return;const atMs=Math.max(0,Math.min(scale,((event.clientX-rect.left)/rect.width)*scale));setTimelineInsertAtMs(atMs);setPlayheadMs(atMs);setPreviewTick(value=>value+1);stopPlayback();}} onDragOver={handleTimelineDragOver} onDragEnter={handleTimelineDragOver} onDrop={handleAssetDrop}>
          {audioClips.map(clip => {
            const asset = assets.find(item => item.id === clip.assetId);
            if (!asset) return null;
            return <TimelineClipItem
              key={clip.id}
              clip={clip}
              asset={asset}
              left={percentLeft(clip)}
              width={percentWidth(clip)}
              selected={selectedId === clip.id}
              grouped={groups.some(group => group.members.includes(memberKeyForClip(clip.id)))}
              multiSelected={selectedMembers.includes(memberKeyForClip(clip.id))}
              audio
              onPointerDown={event => beginClipMove(event, clip)}
              onPointerMove={moveClipOnTimeline}
              onPointerUp={endClipMove}
              onSelect={() => { setSelectedId(clip.id); setSelectedMotionId(null); seekTo(clip.timelineStartMs); }}
              onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(clip.id); setSelectedMotionId(null); seekTo(clip.timelineStartMs); } }}
              onTrimStart={(event, edge) => beginClipTrim(event, clip, edge)}
              onTrimMove={moveClipTrim}
              onTrimEnd={endClipTrim}
              onDuplicate={() => duplicateClip(clip)}
              onRemove={() => removeClip(clip.id)}
            />;
          })}
          {!audioClips.length&&<span className="track-hint">Arraste um áudio para cá. Ele tocará junto com o vídeo</span>}<div className="timeline-cursor" style={{left:playheadMs/scale*100+"%"}}/>
        </div></div>
        <div className="motion-track-row timeline-motion-row image-overlay-track-row"><div className="track-label">IMAGENS LIVRES</div><div className="track-clips timeline-canvas motion-timeline image-overlay-track" style={{width:Math.max(100,timelineZoom)+"%"}} onClick={event=>{if((event.target as HTMLElement).closest(".image-overlay-timeline"))return;const rect=event.currentTarget.getBoundingClientRect();if(!rect.width)return;const atMs=Math.max(0,Math.min(scale,((event.clientX-rect.left)/rect.width)*scale));setTimelineInsertAtMs(atMs);setPlayheadMs(atMs);setPreviewTick(value=>value+1);stopPlayback();}}>
          {imageOverlays.filter(item=>item.visible!==false).map(item=><button key={item.id} type="button" className={"motion-timeline-clip image-overlay-timeline"+(selectedOverlayId===item.id?" selected":"")} style={{left:item.startMs/scale*100+"%",width:Math.max(3,(item.endMs-item.startMs)/scale*100)+"%",touchAction:"none"}} onPointerDown={event=>beginOverlayTimelineMove(event,item)} onPointerMove={moveOverlayOnTimeline} onPointerUp={endOverlayTimelineDrag} onPointerCancel={endOverlayTimelineDrag} onClick={()=>{if(overlayTimelineDidMoveRef.current){overlayTimelineDidMoveRef.current=false;return;}setSelectedOverlayId(item.id);setSelectedMotionId(null);setSelectedId(null);seekTo(item.startMs);}}><span className="image-overlay-trim-edge left" onPointerDown={event=>beginOverlayTimelineTrim(event,item,"start")} onPointerMove={moveOverlayOnTimeline} onPointerUp={endOverlayTimelineDrag} onPointerCancel={endOverlayTimelineDrag}/><b>▧ {assets.find(asset=>asset.id===item.assetId)?.name||"Imagem livre"}</b><small>{timeLabel(item.endMs-item.startMs)}</small><span className="image-overlay-trim-edge right" onPointerDown={event=>beginOverlayTimelineTrim(event,item,"end")} onPointerMove={moveOverlayOnTimeline} onPointerUp={endOverlayTimelineDrag} onPointerCancel={endOverlayTimelineDrag}/></button>)}
          {!imageOverlays.some(item=>item.visible!==false)&&<span className="track-hint">{imageOverlays.length?"Todas as imagens estão ocultas. Reative-as no painel Camadas.":"Adicione imagens livres para organizá-las nesta faixa"}</span>}<div className="timeline-cursor" style={{left:playheadMs/scale*100+"%"}}/>
        </div></div>
        <div className="motion-track-row timeline-motion-row transcript-track-row"><div className="track-label">LEGENDAS</div><div className="track-clips timeline-canvas motion-timeline transcript-timeline" style={{width:Math.max(100,timelineZoom)+"%"}} onClick={event=>{if((event.target as HTMLElement).closest(".motion-timeline-clip"))return;const rect=event.currentTarget.getBoundingClientRect();if(!rect.width)return;const atMs=Math.max(0,Math.min(scale,((event.clientX-rect.left)/rect.width)*scale));setTimelineInsertAtMs(atMs);setPlayheadMs(atMs);setPreviewTick(value=>value+1);stopPlayback();}} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();const id=event.dataTransfer.getData("text/motion-graphic-id");if(!id)return;const rect=event.currentTarget.getBoundingClientRect();updateMotion(id,{startMs:Math.max(0,(event.clientX-rect.left)/rect.width*scale)});}}>
          {captions.filter(item=>item.visible!==false).map(item=><button key={item.id} type="button" className={"motion-timeline-clip transcript-timeline-clip"+(selectedMotionId===item.id?" selected":"")} style={{left:item.startMs/scale*100+"%",width:Math.max(3,(item.endMs-item.startMs)/scale*100)+"%",touchAction:"none"}} onPointerDown={event=>beginMotionMove(event,item)} onPointerMove={moveMotionOnTimeline} onPointerUp={endMotionTrim} onPointerCancel={endMotionTrim} onClick={event=>{event.stopPropagation();if(motionTimelineDidMoveRef.current){motionTimelineDidMoveRef.current=false;return;}selectMotionItem(item);}}><span className="motion-trim-edge left" onPointerDown={event=>beginMotionTrim(event,item,"start")} onPointerMove={moveMotionOnTimeline} onPointerUp={endMotionTrim} onPointerCancel={endMotionTrim}/><b>{item.captionEnglish||item.text}</b><small>{timeLabel(item.startMs)} · {item.captionTranslation?"TRADUZIDA":"ORIGINAL"}</small><span className="motion-trim-edge right" onPointerDown={event=>beginMotionTrim(event,item,"end")} onPointerMove={moveMotionOnTimeline} onPointerUp={endMotionTrim} onPointerCancel={endMotionTrim}/></button>)}
          {!captions.some(item=>item.visible!==false)&&<span className="track-hint">{captions.length?"Todas as legendas estão ocultas. Reative-as no painel Camadas.":"As legendas transcritas aparecerão nesta faixa exclusiva"}</span>}<div className="timeline-cursor" style={{left:playheadMs/scale*100+"%"}}/>
        </div></div>
        <div className="motion-track-row timeline-motion-row"><div className="track-label">COMPOSIÇÕES</div><div className="track-clips timeline-canvas motion-timeline" style={{width:Math.max(100,timelineZoom)+"%"}} onClick={event=>{if((event.target as HTMLElement).closest(".motion-timeline-clip"))return;const rect=event.currentTarget.getBoundingClientRect();if(!rect.width)return;const atMs=Math.max(0,Math.min(scale,((event.clientX-rect.left)/rect.width)*scale));setTimelineInsertAtMs(atMs);setPlayheadMs(atMs);setPreviewTick(value=>value+1);stopPlayback();}} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();const id=event.dataTransfer.getData("text/motion-graphic-id");if(!id)return;const rect=event.currentTarget.getBoundingClientRect();updateMotion(id,{startMs:Math.max(0,(event.clientX-rect.left)/rect.width*scale)});}}>
          {textLayers.filter(item=>item.visible!==false).map(item=><button key={item.id} className={"motion-timeline-clip"+(selectedMotionId===item.id?" selected":"")+(groups.some(group=>group.members.includes(memberKeyForMotion(item.id)))?" grouped":"")+(selectedMembers.includes(memberKeyForMotion(item.id))?" multi-selected":"")} style={{left:item.startMs/scale*100+"%",width:Math.max(3,(item.endMs-item.startMs)/scale*100)+"%",touchAction:"none"}} onPointerDown={event=>beginMotionMove(event,item)} onPointerMove={moveMotionOnTimeline} onPointerUp={endMotionTrim} onPointerCancel={endMotionTrim} onClick={()=>{if(motionTimelineDidMoveRef.current){motionTimelineDidMoveRef.current=false;return;}selectMotionItem(item);}}><span className="motion-trim-edge left" onPointerDown={event=>beginMotionTrim(event,item,"start")} onPointerMove={moveMotionOnTimeline} onPointerUp={endMotionTrim} onPointerCancel={endMotionTrim}/><b>{item.icon ? item.icon + " " : ""}{item.text}</b><small>{item.preset}</small><span className="motion-trim-edge right" onPointerDown={event=>beginMotionTrim(event,item,"end")} onPointerMove={moveMotionOnTimeline} onPointerUp={endMotionTrim} onPointerCancel={endMotionTrim}/></button>)}
          <div className="timeline-cursor" style={{left:playheadMs/scale*100+"%"}}/>
        </div></div>
      </div>
      {audioClips.map(clip=>{const asset=assets.find(item=>item.id===clip.assetId);const url=mediaUrls[clip.assetId];return asset&&url?<audio key={clip.id} ref={node=>{audioRefs.current[clip.id]=node;}} src={url} preload="metadata" onLoadedMetadata={event=>{const durationMs=event.currentTarget.duration*1000;if(!Number.isFinite(durationMs)||durationMs<=0)return;const measuredDurationMs=Math.round(durationMs);setMediaDurations(current=>({...current,[asset.id]:measuredDurationMs}));setClips(current=>current.map(item=>{if(item.assetId!==asset.id)return item;const shouldExpandDefault=item.sourceDurationMs==null&&item.sourceEndMs===30000;const shouldClamp=item.sourceEndMs>durationMs;return {...item,sourceDurationMs:measuredDurationMs,sourceEndMs:shouldExpandDefault||shouldClamp?measuredDurationMs:item.sourceEndMs};}));}}/>:null;})}
    </section>
  </section>;
}
