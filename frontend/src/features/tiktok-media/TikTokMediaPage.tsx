import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Clapperboard,
  Copy,
  Download,
  FileJson,
  Film,
  Link2,
  Music2,
  Pause,
  Play,
  Plus,
  Save,
  Sparkles,
  Subtitles,
  Trash2,
  Video,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router-dom";

import { PageHeader } from "../../components/PageHeader";
import { studioApi } from "../../lib/studio-api";
import { imageForSlide, paintSlide } from "./slide-canvas";
import { MusicLessonComposer } from "./MusicLessonComposer";
import {
  activeCaptionAt,
  adjustCaptionTiming,
  captionsFromApprovedCues,
  durationLabel,
} from "./caption-timeline";
import {
  blankSlide,
  DEFAULT_CAPTION_STYLE,
  mediaApi,
  readExternalStoryboard,
  type MediaAudioMode,
  type MediaCaption,
  type MediaCaptionStyle,
  type MediaFormat,
  type MediaKind,
  type MediaProject,
  type MediaSlide,
  type MediaVisualMode,
} from "./tiktok-api";
import "./tiktok-media.css";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function titleOf(kind: MediaKind): string {
  return {
    cover: "Abertura",
    lesson: "Mini-aula",
    example: "Exemplos",
    challenge: "Desafio",
    lyric: "Letra",
  }[kind];
}

function SlideThumb({ project, index }: { project: MediaProject; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) paintSlide(ctx, project.slides[index], project, index);
  }, [project, index]);
  return <canvas className="tm-thumb" ref={ref} width={1080} height={1920} aria-hidden="true" />;
}

function EditField({
  label,
  value,
  onChange,
  multiline = false,
  maxLength = 600,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  maxLength?: number;
  hint?: string;
}) {
  return (
    <label className="tm-field">
      <span>
        {label}
        <small>
          {value.length}/{maxLength}
        </small>
      </span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={maxLength}
          rows={3}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={maxLength}
        />
      )}
      {hint && <em>{hint}</em>}
    </label>
  );
}

export function TikTokMediaPage() {
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: ["tiktok-projects"],
    queryFn: mediaApi.list,
  });
  const sourceProjects = useQuery({
    queryKey: ["projects"],
    queryFn: () => studioApi.projects(),
  });
  const voices = useQuery({
    queryKey: ["tiktok-voices"],
    queryFn: studioApi.voices,
  });
  const [selectedId, selectProject] = useState<string | null>(null);
  const projectQuery = useQuery({
    queryKey: ["tiktok-project", selectedId],
    queryFn: () => mediaApi.get(selectedId!),
    enabled: Boolean(selectedId),
  });
  const [draft, setDraft] = useState<MediaProject | null>(null);
  const [dirty, setDirty] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [newTitle, setNewTitle] = useState("Minha publicação");
  const [newFormat, setNewFormat] = useState<MediaFormat>("carousel");
  const [sourceId, setSourceId] = useState("");
  const [sceneId, setSceneId] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [cutStart, setCutStart] = useState(0);
  const [cutEnd, setCutEnd] = useState(55);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [sourceDurationMs, setSourceDurationMs] = useState(0);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const sourceStatus = useQuery({
    queryKey: ["tiktok-source-status", selectedId, draft?.source_youtube_id],
    queryFn: () => mediaApi.sourceStatus(selectedId!),
    enabled: Boolean(selectedId && draft?.source_youtube_id),
    refetchInterval: (query) => {
      const status = query.state.data;
      return !status?.source_ready ||
        ["queued", "running", "retryable"].includes(status.ingest_status ?? "")
        ? 2500
        : false;
    },
  });
  const scenes = useQuery({
    queryKey: ["tiktok-scenes", sourceId],
    queryFn: () => studioApi.editorialScenes(sourceId),
    enabled: Boolean(sourceId),
  });
  const sourceMedia = useQuery({
    queryKey: ["project-media", sourceId],
    queryFn: () => studioApi.projectMedia(sourceId),
    enabled: Boolean(sourceId),
  });
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiCount, setAiCount] = useState(5);
  const [externalJson, setExternalJson] = useState("");
  const [proposed, setProposed] = useState<MediaSlide[] | null>(null);
  const [proposalOrigin, setProposalOrigin] = useState<"music" | null>(null);
  const [notice, setNotice] = useState("");
  const [audioMode, setAudioMode] = useState<MediaAudioMode>("silent");
  const [voiceId, setVoiceId] = useState("");
  const [jobId, setJobId] = useState("");
  const [renderId, setRenderId] = useState("");
  const [inspectorTab, setInspectorTab] = useState<"captions" | "export">("captions");
  const editVersion = useRef(0);
  const loadedId = useRef<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedId && projects.data?.length) selectProject(projects.data[0].id);
  }, [projects.data, selectedId]);

  useEffect(() => {
    if (
      projectQuery.data &&
      (loadedId.current !== selectedId ||
        (!dirty && projectQuery.data.revision > (draft?.revision ?? 0)))
    ) {
      loadedId.current = selectedId;
      setDraft(projectQuery.data);
      setDirty(false);
      setActiveIndex(0);
      setJobId("");
      setRenderId("");
      setSourceId(projectQuery.data.source_project_id ?? "");
      setSceneId(projectQuery.data.source_scene_id ?? "");
      setAudioMode(
        projectQuery.data.source_scene_id || projectQuery.data.source_youtube_id
          ? "original"
          : "silent",
      );
      setPlayheadMs(0);
      setSourceDurationMs(0);
      setSelectedCaptionId(null);
      setProposed(null);
      setProposalOrigin(null);
    }
  }, [projectQuery.data, selectedId, dirty, draft?.revision]);

  function edit(change: (current: MediaProject) => MediaProject) {
    editVersion.current += 1;
    videoRef.current?.pause();
    setDraft((current) => (current ? change(current) : current));
    setDirty(true);
    setNotice("");
    setPlaying(false);
  }

  const create = useMutation({
    mutationFn: () => mediaApi.create(newTitle.trim() || "Nova publicação", newFormat),
    onSuccess: (project) => {
      queryClient.setQueryData(["tiktok-project", project.id], project);
      void queryClient.invalidateQueries({ queryKey: ["tiktok-projects"] });
      loadedId.current = null;
      selectProject(project.id);
    },
  });

  const save = useMutation({
    mutationFn: ({ value }: { value: MediaProject; version: number }) =>
      mediaApi.update(value.id, {
        title: value.title,
        format: value.format,
        theme: value.theme,
        source_project_id: value.source_project_id,
        source_scene_id: value.source_scene_id,
        source_youtube_id: value.source_youtube_id,
        source_cut_job_id: value.source_cut_job_id,
        video_captions: value.video_captions,
        caption_style: value.caption_style,
        slides: value.slides,
        revision: value.revision,
      }),
    onSuccess: (updated, variables) => {
      queryClient.setQueryData(["tiktok-project", updated.id], updated);
      setDraft((current) =>
        current && current.id === updated.id ? { ...current, revision: updated.revision } : current,
      );
      setDirty(editVersion.current !== variables.version);
      setNotice(editVersion.current === variables.version ? "Tudo salvo" : "Salvando alterações…");
      void queryClient.invalidateQueries({ queryKey: ["tiktok-projects"] });
    },
    onError: (error) => {
      setDirty(true);
      setNotice(`Falha ao salvar: ${error.message}`);
    },
  });

  useEffect(() => {
    if (sourceStatus.data?.duration_ms) {
      setCutStart(0);
      setCutEnd(Math.min(55, sourceStatus.data.duration_ms / 1000));
    }
  }, [selectedId, sourceStatus.data?.duration_ms]);

  useEffect(() => {
    if (
      sourceStatus.data?.ingest_status === "succeeded" &&
      sourceStatus.data.ingest_job_id !== draft?.source_cut_job_id
    ) {
      void queryClient.invalidateQueries({ queryKey: ["tiktok-project", selectedId] });
    }
  }, [
    sourceStatus.data?.ingest_status,
    sourceStatus.data?.ingest_job_id,
    draft?.source_cut_job_id,
    selectedId,
    queryClient,
  ]);

  useEffect(() => {
    if (!draft || !dirty || save.isPending) return;
    const timer = window.setTimeout(() => {
      save.mutate({ value: draft, version: editVersion.current });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, save.isPending]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (draft && dirty && !save.isPending) {
          save.mutate({ value: draft, version: editVersion.current });
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft, dirty, save.isPending]);

  const active = draft?.slides[activeIndex] ?? null;
  const videoMode = Boolean(
    (draft?.source_scene_id || draft?.source_youtube_id) && draft?.format !== "carousel",
  );
  const captionStyle = draft?.caption_style ?? DEFAULT_CAPTION_STYLE;
  const captions = draft?.video_captions ?? [];
  const activeCaption = activeCaptionAt(captions, playheadMs);
  const selectedCaption =
    captions.find((caption) => caption.cue_id === selectedCaptionId) ?? activeCaption;
  // A cena pode apontar para um corte anterior ao último corte do projeto.
  // Só a rota canônica verifica a cena/ingestão exatas usadas na exportação.
  // Não requisitar o recorte enquanto a nova cena ainda não foi vinculada no servidor.
  // Isso evita uma primeira resposta 404 persistente no elemento de vídeo.
  const sourceVideoUrl =
    !videoMode || !draft
      ? null
      : draft.source_youtube_id
        ? draft.source_cut_job_id &&
          projectQuery.data?.source_cut_job_id === draft.source_cut_job_id
          ? mediaApi.sourceUrl(draft.id)
          : sourceStatus.data?.source_ready
            ? mediaApi.originalUrl(draft.id)
            : null
        : projectQuery.data?.source_scene_id === draft.source_scene_id &&
            projectQuery.data?.source_project_id === draft.source_project_id
          ? `${mediaApi.sourceUrl(draft.id)}?scene=${encodeURIComponent(draft.source_scene_id!)}`
          : null;
  const actualDurationMs =
    sourceDurationMs ||
    sourceStatus.data?.duration_ms ||
    Math.max(0, ...captions.map((caption) => caption.end_ms));
  useEffect(() => {
    const context = previewRef.current?.getContext("2d");
    if (context && active && draft) paintSlide(context, active, draft, activeIndex);
  }, [draft, active, activeIndex]);

  useEffect(() => {
    if (!playing || !active || !draft || videoMode) return;
    const timeout = window.setTimeout(() => {
      if (activeIndex < draft.slides.length - 1) setActiveIndex(activeIndex + 1);
      else setPlaying(false);
    }, active.duration_ms);
    return () => window.clearTimeout(timeout);
  }, [playing, activeIndex, active, draft, videoMode]);

  const ai = useMutation({
    mutationFn: () => mediaApi.ideas(aiPrompt.trim(), draft!.format, aiCount),
    onSuccess: (data) => {
      setProposed(data.slides.map((slide) => ({ ...slide, id: crypto.randomUUID() })));
      setProposalOrigin(null);
      setNotice("A proposta da IA está pronta. Revise os textos antes de aplicar.");
    },
    onError: (error) => setNotice(`${error.message} Use o campo de JSON externo abaixo.`),
  });
  const prepareYoutube = useMutation({
    mutationFn: async () => {
      const url = youtubeUrl.trim();
      if (dirty || save.isPending) throw new Error("Aguarde o salvamento da produção.");
      const production =
        draft && draft.format !== "carousel"
          ? draft
          : await mediaApi.create(newTitle.trim() || "Vídeo para TikTok", "lyrics_video");
      return mediaApi.prepareYoutube(production.id, production.revision, url);
    },
    onSuccess: ({ project }) => {
      queryClient.setQueryData(["tiktok-project", project.id], project);
      void queryClient.invalidateQueries({ queryKey: ["tiktok-projects"] });
      void queryClient.invalidateQueries({ queryKey: ["tiktok-source-status", project.id] });
      loadedId.current = null;
      selectProject(project.id);
      setDraft(project);
      setDirty(false);
      setAudioMode("original");
      setPlayheadMs(0);
      setSourceDurationMs(0);
      setSelectedCaptionId(null);
      setYoutubeUrl("");
      setNotice("Download iniciado. Você poderá selecionar o trecho e transcrever aqui mesmo.");
    },
    onError: (error) =>
      setNotice(
        error instanceof TypeError ? "Informe uma URL completa do YouTube." : error.message,
      ),
  });
  const transcribeCut = useMutation({
    mutationFn: () => {
      if (!draft || dirty || save.isPending) throw new Error("Aguarde o salvamento.");
      return mediaApi.transcribeCut(
        draft.id,
        draft.revision,
        Math.round(cutStart * 1000),
        Math.round(cutEnd * 1000),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tiktok-source-status", selectedId] });
      setNotice(
        "Transcrevendo o trecho. As legendas aparecerão na linha do tempo automaticamente.",
      );
    },
    onError: (error) => setNotice(error.message),
  });
  const importCues = useMutation({
    mutationFn: async () => {
      if (!sceneId) throw new Error("Selecione a cena.");
      const cues = await studioApi.editorialCues(sceneId);
      const approved = cues.filter(
        (cue) =>
          cue.approved_en.trim() && cue.approved_pt.trim() && cue.provenance?.approval !== "draft",
      );
      if (!approved.length) throw new Error("A cena não possui falas aprovadas.");
      if (approved.length > 30) {
        throw new Error(
          `Esta cena tem ${approved.length} falas aprovadas. Um carrossel aceita até 30. Use o vídeo com legendas ou prepare uma cena menor.`,
        );
      }
      return approved.map((cue): MediaSlide => ({
        ...blankSlide("lesson"),
        heading: cue.speaker || "ENGLISH IN CONTEXT",
        en: cue.approved_en,
        pt: cue.approved_pt,
        note: "Da cena para a vida real",
        speaker: cue.speaker,
        duration_ms: Math.min(
          20000,
          Math.max(2000, cue.speech_timing.end_ms - cue.speech_timing.start_ms),
        ),
      }));
    },
    onSuccess: (slides) => {
      edit((current) => ({ ...current, source_project_id: sourceId, slides }));
      setActiveIndex(0);
      setNotice(`${slides.length} falas importadas. Revise o enquadramento e a tradução.`);
    },
    onError: (error) => setNotice(error.message),
  });
  const importVideoCues = useMutation({
    mutationFn: async () => {
      if (!sceneId || !sourceId) throw new Error("Selecione uma cena revisada.");
      const sourceCues = await studioApi.editorialCues(sceneId);
      const prepared = captionsFromApprovedCues(sourceCues);
      if (!prepared.length) {
        throw new Error("A cena não possui falas revisadas com inglês e tradução aprovados.");
      }
      return prepared;
    },
    onSuccess: (prepared) => {
      videoRef.current?.pause();
      edit((current) => ({
        ...current,
        source_project_id: sourceId,
        source_scene_id: sceneId,
        source_youtube_id: null,
        source_cut_job_id: null,
        video_captions: prepared,
        caption_style: current.caption_style ?? { ...DEFAULT_CAPTION_STYLE },
        format: current.format === "carousel" ? "lyrics_video" : current.format,
      }));
      setPlayheadMs(prepared[0].start_ms);
      setSourceDurationMs(0);
      setSelectedCaptionId(prepared[0].cue_id);
      setAudioMode("original");
      setNotice(
        `${prepared.length} falas revisadas adicionadas ao vídeo. A tradução pode ser ajustada aqui sem alterar o Editorial.`,
      );
    },
    onError: (error) => setNotice(error.message),
  });
  const upload = useMutation({
    mutationFn: (file: File) => mediaApi.uploadAudio(draft!.id, file),
    onSuccess: (updated) => {
      setDraft(updated);
      setDirty(false);
      queryClient.setQueryData(["tiktok-project", updated.id], updated);
      setNotice("Áudio disponível para a trilha do vídeo.");
      setAudioMode("uploaded");
    },
    onError: (error) => setNotice(error.message),
  });
  const exportSlides = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Abra um projeto.");
      if (dirty || save.isPending) throw new Error("Aguarde o salvamento antes de exportar.");
      const images = await Promise.all(draft.slides.map((_, index) => imageForSlide(draft, index)));
      return mediaApi.exportSlides(draft.id, draft.revision, images);
    },
    onSuccess: (blob) => download(blob, "ihub-tiktok-carrossel.zip"),
    onError: (error) => setNotice(error.message),
  });
  const render = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Abra um projeto.");
      if (dirty || save.isPending) throw new Error("Aguarde o salvamento antes de exportar.");
      const visualMode: MediaVisualMode = videoMode ? "video_source" : "slides";
      const images =
        visualMode === "slides"
          ? await Promise.all(draft.slides.map((_, index) => imageForSlide(draft, index)))
          : [];
      return mediaApi.render(draft.id, draft.revision, images, audioMode, voiceId, visualMode);
    },
    onSuccess: (job) => {
      setJobId(job.job_id);
      setRenderId(job.render_id);
      setNotice("Exportação iniciada. O resultado será disponibilizado aqui.");
    },
    onError: (error) => setNotice(error.message),
  });
  const job = useQuery({
    queryKey: ["tiktok-render", jobId],
    queryFn: () => studioApi.job(jobId),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ["succeeded", "failed", "cancelled"].includes(status) ? false : 2500;
    },
  });

  function updateSlide(patch: Partial<MediaSlide>) {
    edit((current) => ({
      ...current,
      slides: current.slides.map((slide, index) =>
        index === activeIndex ? { ...slide, ...patch } : slide,
      ),
    }));
  }

  function seekVideo(timeMs: number) {
    const target = Math.max(0, Math.min(actualDurationMs, Math.round(timeMs)));
    setPlayheadMs(target);
    if (videoRef.current) videoRef.current.currentTime = target / 1000;
  }

  async function toggleVideoPlayback() {
    const player = videoRef.current;
    if (!player) return;
    if (player.paused) {
      try {
        await player.play();
      } catch {
        setNotice("Não foi possível reproduzir o vídeo. Verifique se o recorte está disponível.");
      }
    } else {
      player.pause();
    }
  }

  function updateCaption(cueId: string, patch: Partial<MediaCaption>) {
    videoRef.current?.pause();
    edit((current) => ({
      ...current,
      video_captions: (current.video_captions ?? []).map((cue) =>
        cue.cue_id === cueId ? { ...cue, ...patch } : cue,
      ),
    }));
  }

  function setCaptionTiming(cueId: string, edge: "start_ms" | "end_ms", value: number) {
    const caption = captions.find((cue) => cue.cue_id === cueId);
    if (!caption) return;
    const updated = adjustCaptionTiming(
      captions,
      cueId,
      { start_ms: caption.start_ms, end_ms: caption.end_ms, [edge]: value },
      actualDurationMs,
    );
    if (updated === captions) {
      setNotice("Os horários não podem se sobrepor ou ultrapassar a duração do vídeo.");
      return;
    }
    videoRef.current?.pause();
    edit((current) => ({ ...current, video_captions: updated }));
  }

  function dragCaptionEdge(
    event: ReactPointerEvent<HTMLButtonElement>,
    cueId: string,
    edge: "start_ms" | "end_ms",
  ) {
    event.preventDefault();
    event.stopPropagation();
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || !actualDurationMs) return;
    videoRef.current?.pause();
    let latest = 0;
    const measure = (clientX: number) => {
      latest = Math.max(
        0,
        Math.min(
          actualDurationMs,
          Math.round((((clientX - rect.left) / rect.width) * actualDurationMs) / 100) * 100,
        ),
      );
      seekVideo(latest);
    };
    const move = (pointer: PointerEvent) => measure(pointer.clientX);
    const finish = (pointer: PointerEvent) => {
      measure(pointer.clientX);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      setCaptionTiming(cueId, edge, latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  }

  function addCaptionAtPlayhead() {
    const start = Math.min(playheadMs, Math.max(0, actualDurationMs - 900));
    if (activeCaptionAt(captions, start) || captions.length >= 200) {
      setNotice("Escolha um intervalo livre para adicionar a legenda (limite de 200 blocos).");
      return;
    }
    const next = [...captions]
      .sort((a, b) => a.start_ms - b.start_ms)
      .find((caption) => caption.start_ms > start);
    const end = Math.min(start + 2400, next?.start_ms ?? actualDurationMs);
    if (end <= start) {
      setNotice("Não há espaço para uma nova legenda neste ponto.");
      return;
    }
    const cueId = crypto.randomUUID();
    edit((current) => ({
      ...current,
      video_captions: [
        ...(current.video_captions ?? []),
        {
          cue_id: cueId,
          start_ms: start,
          end_ms: end,
          en: "Nova legenda",
          pt: "",
          highlight: "",
          note: "",
          enabled: true,
        },
      ].sort((a, b) => a.start_ms - b.start_ms),
    }));
    setSelectedCaptionId(cueId);
  }

  function changeCaptionStyle(change: Partial<MediaCaptionStyle>) {
    edit((current) => ({
      ...current,
      caption_style: { ...DEFAULT_CAPTION_STYLE, ...current.caption_style, ...change },
    }));
  }

  function moveSlide(direction: -1 | 1) {
    if (!draft) return;
    const target = activeIndex + direction;
    if (target < 0 || target >= draft.slides.length) return;
    edit((current) => {
      const slides = [...current.slides];
      [slides[activeIndex], slides[target]] = [slides[target], slides[activeIndex]];
      return { ...current, slides };
    });
    setActiveIndex(target);
  }

  function addSlide(kind: MediaKind) {
    if (!draft || draft.slides.length >= 30) return;
    edit((current) => {
      const slides = [...current.slides];
      slides.splice(activeIndex + 1, 0, blankSlide(kind));
      return { ...current, slides };
    });
    setActiveIndex(activeIndex + 1);
  }

  function duplicateSlide() {
    if (!active || !draft || draft.slides.length >= 30) return;
    edit((current) => {
      const slides = [...current.slides];
      slides.splice(activeIndex + 1, 0, { ...active, id: crypto.randomUUID() });
      return { ...current, slides };
    });
    setActiveIndex(activeIndex + 1);
  }

  function removeSlide() {
    if (!draft || draft.slides.length < 2) return;
    edit((current) => ({
      ...current,
      slides: current.slides.filter((_, index) => index !== activeIndex),
    }));
    setActiveIndex(Math.max(0, activeIndex - 1));
  }

  return (
    <section className="tm-page">
      <PageHeader
        title="TikTok Mídia"
        description="Crie carrosséis, mini-aulas e vídeos verticais com inglês, tradução, voz e música."
        actions={
          <span className="tm-save-status">
            <Save size={16} />
            {save.isPending ? "Salvando…" : dirty ? "Alterações pendentes" : "Salvo"}
          </span>
        }
      />
      <div className="tm-workspace">
        <aside className="tm-rail">
          <div className="tm-card tm-start-card">
            <h2>
              <Video size={18} /> Começar com um vídeo
            </h2>
            <p className="tm-small">
              Cole um link do YouTube. O Media vai preparar o vídeo sem criar um projeto Editorial.
            </p>
            <input
              type="url"
              aria-label="URL do YouTube para preparar a fonte"
              placeholder="https://www.youtube.com/watch?v=..."
              value={youtubeUrl}
              onChange={(event) => setYoutubeUrl(event.target.value)}
            />
            <button
              className="tm-accent"
              onClick={() => prepareYoutube.mutate()}
              disabled={prepareYoutube.isPending || !youtubeUrl.trim() || dirty || save.isPending}
            >
              <Link2 size={16} /> {prepareYoutube.isPending ? "Preparando…" : "Usar este vídeo"}
            </button>
            {draft?.source_youtube_id && (
              <div className="tm-source-progress" aria-live="polite">
                <span>
                  {sourceStatus.data?.source_ready ? "✓ Vídeo disponível" : "Preparando download…"}
                </span>
                {sourceStatus.data?.download_error && (
                  <p role="alert">{sourceStatus.data.download_error}</p>
                )}
                {sourceStatus.data?.source_ready && (
                  <>
                    <p className="tm-small">
                      Escolha o trecho a transcrever (até 3 minutos). Você pode alterar esse recorte
                      depois.
                    </p>
                    <div className="tm-cut-fields">
                      <label>
                        Início (s)
                        <input
                          type="number"
                          aria-label="Início do trecho em segundos"
                          min={0}
                          step={0.1}
                          max={Math.max(0, (sourceStatus.data.duration_ms ?? 0) / 1000)}
                          value={cutStart}
                          onChange={(e) => setCutStart(Number(e.target.value))}
                        />
                      </label>
                      <label>
                        Fim (s)
                        <input
                          type="number"
                          aria-label="Fim do trecho em segundos"
                          min={0.1}
                          step={0.1}
                          max={(sourceStatus.data.duration_ms ?? 0) / 1000}
                          value={cutEnd}
                          onChange={(e) => setCutEnd(Number(e.target.value))}
                        />
                      </label>
                    </div>
                    <button
                      onClick={() => transcribeCut.mutate()}
                      disabled={
                        transcribeCut.isPending ||
                        dirty ||
                        save.isPending ||
                        ["queued", "running", "retryable"].includes(
                          sourceStatus.data.ingest_status ?? "",
                        ) ||
                        cutStart < 0 ||
                        cutEnd <= cutStart ||
                        cutEnd - cutStart > 180 ||
                        cutEnd * 1000 > (sourceStatus.data.duration_ms ?? 0)
                      }
                    >
                      <Subtitles size={16} />{" "}
                      {transcribeCut.isPending ? "Enviando…" : "Transcrever este trecho"}
                    </button>
                    {sourceStatus.data.ingest_status && (
                      <p className="tm-small">
                        Transcrição:{" "}
                        {sourceStatus.data.ingest_status === "succeeded"
                          ? "pronta para editar"
                          : sourceStatus.data.ingest_status}
                      </p>
                    )}
                    {sourceStatus.data.ingest_error && (
                      <p role="alert">{sourceStatus.data.ingest_error}</p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          <div className="tm-card">
            <h2>
              <Clapperboard size={18} /> Produções
            </h2>
            <div className="tm-stack">
              <select
                aria-label="Produção selecionada"
                value={selectedId ?? ""}
                onChange={(event) => {
                  if (dirty || save.isPending) {
                    setNotice("Aguarde o salvamento para trocar de produção.");
                    return;
                  }
                  loadedId.current = null;
                  selectProject(event.target.value);
                }}
              >
                <option value="">Selecione um projeto</option>
                {projects.data?.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
              <input
                aria-label="Nome da nova produção"
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                maxLength={140}
              />
              <select
                aria-label="Formato da nova produção"
                value={newFormat}
                onChange={(event) => setNewFormat(event.target.value as MediaFormat)}
              >
                <option value="carousel">Carrossel</option>
                <option value="lesson_video">Vídeo educativo</option>
                <option value="lyrics_video">Lyrics + tradução</option>
              </select>
              <button
                className="tm-accent"
                onClick={() => create.mutate()}
                disabled={create.isPending}
              >
                <Plus size={16} /> Nova produção
              </button>
              {create.isError && <p role="alert">{create.error.message}</p>}
            </div>
          </div>
          {draft && (
            <>
              {draft.format === "carousel" && (
                <>
                  <MusicLessonComposer
                    disabled={videoMode}
                    onDraft={(slides) => {
                      setProposed(slides);
                      setProposalOrigin("music");
                      setNotice(
                        "Mini-aula montada. Confira os 7 quadros e aplique somente após revisar.",
                      );
                    }}
                    onAiPrompt={(prompt) => {
                      setAiPrompt(prompt);
                      setAiCount(7);
                      setNotice("Prompt preparado. Use “Sugerir roteiro” na seção Roteiro com IA.");
                    }}
                  />
                  <div className="tm-card">
                    <h2>
                      <Sparkles size={18} /> Roteiro com IA
                    </h2>
                    <textarea
                      aria-label="Tema para geração por IA"
                      rows={3}
                      placeholder="Ex.: 5 formas naturais de pedir um favor em inglês…"
                      value={aiPrompt}
                      onChange={(event) => setAiPrompt(event.target.value)}
                    />
                    <label className="tm-inline-label">
                      Quadros
                      <input
                        type="number"
                        min={2}
                        max={10}
                        value={aiCount}
                        onChange={(event) => setAiCount(Number(event.target.value))}
                      />
                    </label>
                    <button
                      onClick={() => ai.mutate()}
                      disabled={ai.isPending || aiPrompt.trim().length < 10}
                    >
                      <Sparkles size={16} /> {ai.isPending ? "Criando…" : "Sugerir roteiro"}
                    </button>
                    <details>
                      <summary>Importar roteiro de outra IA (JSON)</summary>
                      <p className="tm-small">
                        Formato:{" "}
                        <code>{'{"slides":[{"kind":"lesson","en":"...","pt":"..."}]}'}</code>
                      </p>
                      <textarea
                        aria-label="Roteiro JSON externo"
                        rows={4}
                        value={externalJson}
                        onChange={(event) => setExternalJson(event.target.value)}
                      />
                      <button
                        onClick={() => {
                          try {
                            setProposed(readExternalStoryboard(externalJson));
                            setProposalOrigin(null);
                            setNotice(
                              "Roteiro importado para revisão. Nenhum quadro foi substituído.",
                            );
                          } catch (error) {
                            setNotice(error instanceof Error ? error.message : "JSON inválido.");
                          }
                        }}
                      >
                        <FileJson size={16} /> Validar JSON
                      </button>
                    </details>
                    {proposed && (
                      <div className="tm-proposal">
                        <p>
                          {proposed.length} quadros ·{" "}
                          {(
                            proposed.reduce((sum, slide) => sum + slide.duration_ms, 0) / 1000
                          ).toFixed(1)}{" "}
                          s · revisão obrigatória
                        </p>
                        <ol className="tm-proposal-frames">
                          {proposed.map((slide, index) => (
                            <li key={slide.id}>
                              <strong>
                                {index + 1}. {slide.heading || titleOf(slide.kind)}
                              </strong>
                              <span>{(slide.duration_ms / 1000).toFixed(1)} s</span>
                              <p>{slide.en || slide.pt}</p>
                            </li>
                          ))}
                        </ol>
                        <button
                          className="tm-accent"
                          onClick={() => {
                            edit((current) => ({
                              ...current,
                              format: proposalOrigin === "music" ? "lesson_video" : current.format,
                              slides: proposed,
                            }));
                            setActiveIndex(0);
                            setProposed(null);
                            setProposalOrigin(null);
                            setNotice(
                              "Roteiro aplicado. Revise os quadros e aguarde o salvamento.",
                            );
                          }}
                        >
                          Aplicar proposta
                        </button>
                        <button
                          onClick={() => {
                            setProposed(null);
                            setProposalOrigin(null);
                          }}
                        >
                          Descartar
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
              <div className="tm-card">
                <h2>
                  <Video size={18} /> Reaproveitar material
                </h2>
                <p className="tm-small">Opcional: usar cenas de projetos antigos.</p>
                <details>
                  <summary>Importar de um projeto antigo</summary>
                  <select
                    aria-label="Projeto de origem"
                    value={sourceId}
                    onChange={(event) => {
                      setSourceId(event.target.value);
                      setSceneId("");
                    }}
                  >
                    <option value="">Selecione um projeto</option>
                    {sourceProjects.data?.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Cena de origem"
                    value={sceneId}
                    onChange={(event) => setSceneId(event.target.value)}
                  >
                    <option value="">Selecione uma cena</option>
                    {scenes.data?.map((scene) => (
                      <option key={scene.id} value={scene.id}>
                        Cena {scene.order}
                      </option>
                    ))}
                  </select>
                  {sourceId && (
                    <div className="tm-preparation-links">
                      <Link to={`/media?project=${sourceId}`}>Recortar e transcrever</Link>
                      <Link to={`/editorial?project=${sourceId}`}>Revisar falas e tradução</Link>
                    </div>
                  )}
                  {sourceMedia.isError && (
                    <p className="tm-small" role="status">
                      Fonte não preparada. Abra o recorte e a transcrição primeiro.
                    </p>
                  )}
                  <button
                    className="tm-accent"
                    onClick={() => importVideoCues.mutate()}
                    disabled={!sceneId || importVideoCues.isPending}
                  >
                    <Subtitles size={16} /> Usar vídeo com legendas revisadas
                  </button>
                  <button
                    onClick={() => importCues.mutate()}
                    disabled={!sceneId || importCues.isPending}
                  >
                    Transformar falas em quadros
                  </button>
                  <p className="tm-small">
                    As legendas usam os tempos reais do corte. Nenhuma fala é publicada sem a sua
                    revisão. Se você acabou de preparar uma fonte, selecione-a acima quando voltar a
                    esta área.
                  </p>
                </details>
              </div>
            </>
          )}
        </aside>

        {!draft ? (
          <div className="tm-empty">
            <Film size={44} />
            <h2>Seu estúdio de conteúdo vertical</h2>
            <p>Crie uma produção ao lado para começar. Seus projetos ficam salvos no Generator.</p>
            {projectQuery.isError && <p role="alert">{projectQuery.error.message}</p>}
          </div>
        ) : (
          <>
            <main className="tm-center">
              <div className="tm-toolbar">
                <span className="tm-eyebrow">PRÉVIA · 9:16 · 1080 × 1920</span>
                <span className="tm-toolbar-actions">
                  <button
                    title={videoMode ? "Legenda anterior" : "Quadro anterior"}
                    onClick={() => {
                      if (videoMode) {
                        const previous = [...captions]
                          .reverse()
                          .find((cue) => cue.enabled && cue.start_ms < playheadMs - 100);
                        if (previous) {
                          setSelectedCaptionId(previous.cue_id);
                          seekVideo(previous.start_ms);
                        }
                      } else {
                        setActiveIndex(Math.max(0, activeIndex - 1));
                      }
                    }}
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <button
                    title={playing ? "Pausar" : "Reproduzir sequência"}
                    onClick={() => {
                      if (videoMode) {
                        void toggleVideoPlayback();
                        return;
                      }
                      if (!playing && activeIndex === draft.slides.length - 1) setActiveIndex(0);
                      setPlaying(!playing);
                    }}
                  >
                    {playing ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <button
                    title={videoMode ? "Próxima legenda" : "Próximo quadro"}
                    onClick={() => {
                      if (videoMode) {
                        const next = captions.find(
                          (cue) => cue.enabled && cue.start_ms > playheadMs + 100,
                        );
                        if (next) {
                          setSelectedCaptionId(next.cue_id);
                          seekVideo(next.start_ms);
                        }
                      } else {
                        setActiveIndex(Math.min(draft.slides.length - 1, activeIndex + 1));
                      }
                    }}
                  >
                    <ArrowRight size={16} />
                  </button>
                </span>
              </div>
              <div className={videoMode ? "tm-stage tm-stage-video" : "tm-stage"}>
                {videoMode ? (
                  <div className="tm-video-frame">
                    {sourceVideoUrl ? (
                      <video
                        key={`${draft.source_scene_id ?? draft.source_youtube_id}-${draft.source_cut_job_id ?? "original"}`}
                        ref={videoRef}
                        src={sourceVideoUrl}
                        preload="metadata"
                        playsInline
                        aria-label="Prévia da cena original com legendas"
                        onLoadedMetadata={(event) => {
                          const player = event.currentTarget;
                          setSourceDurationMs(Math.round(player.duration * 1000));
                          if (playheadMs > 0) player.currentTime = playheadMs / 1000;
                        }}
                        onTimeUpdate={(event) =>
                          setPlayheadMs(Math.round(event.currentTarget.currentTime * 1000))
                        }
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                        onEnded={() => setPlaying(false)}
                        onError={() =>
                          setNotice(
                            "A prévia do recorte não carregou. Confira a preparação do vídeo de origem.",
                          )
                        }
                      />
                    ) : (
                      <p className="tm-video-empty">Carregando o recorte para a prévia…</p>
                    )}
                    {activeCaption && (
                      <div
                        key={activeCaption.cue_id}
                        className={`tm-caption-overlay tm-caption-${captionStyle.template} tm-caption-${captionStyle.position} tm-animation-${captionStyle.animation}`}
                        style={{
                          fontSize: `${(((captionStyle.template === "impact" ? 70 : 58) * captionStyle.text_scale * 100) / 1080).toFixed(3)}cqw`,
                          color: captionStyle.text_color,
                        }}
                        aria-live="off"
                      >
                        <p className="tm-caption-en">
                          {activeCaption.highlight &&
                          activeCaption.en.includes(activeCaption.highlight) ? (
                            <>
                              {activeCaption.en.slice(
                                0,
                                activeCaption.en.indexOf(activeCaption.highlight),
                              )}
                              <mark>{activeCaption.highlight}</mark>
                              {activeCaption.en.slice(
                                activeCaption.en.indexOf(activeCaption.highlight) +
                                  activeCaption.highlight.length,
                              )}
                            </>
                          ) : (
                            activeCaption.en
                          )}
                        </p>
                        {activeCaption.pt && <p className="tm-caption-pt">{activeCaption.pt}</p>}
                        {activeCaption.note && (
                          <p className="tm-caption-note">{activeCaption.note}</p>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <canvas
                    ref={previewRef}
                    width={1080}
                    height={1920}
                    aria-label="Prévia do quadro 9:16"
                    role="img"
                  />
                )}
              </div>
              {videoMode && (
                <div className="tm-video-transport">
                  <button
                    onClick={() => void toggleVideoPlayback()}
                    disabled={!sourceVideoUrl}
                    aria-label={playing ? "Pausar vídeo" : "Reproduzir vídeo"}
                  >
                    {playing ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <span className="tm-time-readout">{durationLabel(playheadMs)}</span>
                  <input
                    type="range"
                    aria-label="Posição do vídeo"
                    min={0}
                    max={Math.max(1, actualDurationMs)}
                    step={100}
                    value={Math.max(0, Math.min(actualDurationMs, playheadMs))}
                    onChange={(event) => seekVideo(Number(event.target.value))}
                  />
                  <span className="tm-time-readout">{durationLabel(actualDurationMs)}</span>
                  {draft.source_youtube_id && !draft.source_cut_job_id && (
                    <div className="tm-mark-controls">
                      <button onClick={() => setCutStart(Number((playheadMs / 1000).toFixed(1)))}>
                        Marcar início
                      </button>
                      <button onClick={() => setCutEnd(Number((playheadMs / 1000).toFixed(1)))}>
                        Marcar fim
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="tm-timeline-heading">
                <h2>
                  {videoMode ? "Legendas sincronizadas" : "Sequência"}{" "}
                  {videoMode ? (
                    <span>{captions.filter((cue) => cue.enabled).length} falas no vídeo</span>
                  ) : (
                    <span>
                      {draft.slides.length} quadros ·{" "}
                      {(
                        draft.slides.reduce((sum, item) => sum + item.duration_ms, 0) / 1000
                      ).toFixed(1)}{" "}
                      s
                    </span>
                  )}
                </h2>
                {!videoMode && (
                  <div>
                    <button
                      title="Mover para esquerda"
                      onClick={() => moveSlide(-1)}
                      disabled={activeIndex === 0}
                    >
                      <ArrowUp size={17} />
                    </button>
                    <button
                      title="Mover para direita"
                      onClick={() => moveSlide(1)}
                      disabled={activeIndex === draft.slides.length - 1}
                    >
                      <ArrowDown size={17} />
                    </button>
                    <button
                      title="Duplicar quadro"
                      onClick={duplicateSlide}
                      disabled={draft.slides.length >= 30}
                    >
                      <Copy size={17} />
                    </button>
                    <button
                      title="Remover quadro"
                      onClick={removeSlide}
                      disabled={draft.slides.length === 1}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                )}
              </div>
              {videoMode ? (
                <div className="tm-caption-timeline" aria-label="Linha do tempo das legendas">
                  <div className="tm-timeline-guide">
                    <span>VÍDEO</span>
                    <span>LEGENDAS · arraste as bordas para sincronizar</span>
                    <button
                      onClick={addCaptionAtPlayhead}
                      disabled={!draft.source_cut_job_id && !draft.source_scene_id}
                    >
                      <Plus size={14} /> Bloco
                    </button>
                  </div>
                  <div className="tm-track-scroll">
                    <div
                      ref={timelineRef}
                      className="tm-caption-track"
                      style={{ width: `${Math.max(780, (actualDurationMs / 1000) * 18)}px` }}
                    >
                      {captions.map((caption, index) => (
                        <div
                          key={caption.cue_id}
                          role="button"
                          tabIndex={0}
                          className={`tm-caption-block ${selectedCaption?.cue_id === caption.cue_id ? "tm-caption-block-active" : ""} ${!caption.enabled ? "tm-caption-block-disabled" : ""}`}
                          style={{
                            left: `${(caption.start_ms / Math.max(1, actualDurationMs)) * 100}%`,
                            width: `${((caption.end_ms - caption.start_ms) / Math.max(1, actualDurationMs)) * 100}%`,
                          }}
                          aria-label={`Editar fala ${index + 1} em ${durationLabel(caption.start_ms)}`}
                          onClick={() => {
                            setSelectedCaptionId(caption.cue_id);
                            seekVideo(caption.start_ms);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedCaptionId(caption.cue_id);
                              seekVideo(caption.start_ms);
                            }
                          }}
                        >
                          <button
                            className="tm-edge tm-edge-start"
                            aria-label={`Arrastar início da fala ${index + 1}`}
                            onPointerDown={(event) =>
                              dragCaptionEdge(event, caption.cue_id, "start_ms")
                            }
                          />
                          <strong>{caption.en || `Fala ${index + 1}`}</strong>
                          <button
                            className="tm-edge tm-edge-end"
                            aria-label={`Arrastar fim da fala ${index + 1}`}
                            onPointerDown={(event) =>
                              dragCaptionEdge(event, caption.cue_id, "end_ms")
                            }
                          />
                        </div>
                      ))}
                      <div
                        className="tm-playhead"
                        aria-hidden="true"
                        style={{ left: `${(playheadMs / Math.max(1, actualDurationMs)) * 100}%` }}
                      />
                    </div>
                  </div>
                  {!captions.length && (
                    <p className="tm-small">
                      O vídeo aparece na prévia assim que o download termina. Transcreva um trecho
                      para editar cada bloco aqui.
                    </p>
                  )}
                </div>
              ) : (
                <div className="tm-timeline" aria-label="Linha do tempo dos quadros">
                  {draft.slides.map((slide, index) => (
                    <button
                      key={slide.id}
                      className={`tm-frame ${activeIndex === index ? "tm-frame-active" : ""}`}
                      onClick={() => {
                        setActiveIndex(index);
                        setPlaying(false);
                      }}
                    >
                      <SlideThumb project={draft} index={index} />
                      <span>
                        {index + 1}. {titleOf(slide.kind)}
                      </span>
                      <small>{(slide.duration_ms / 1000).toFixed(1)}s</small>
                    </button>
                  ))}
                  {draft.slides.length < 30 && (
                    <button className="tm-add-frame" onClick={() => addSlide("lesson")}>
                      <Plus /> Adicionar
                    </button>
                  )}
                </div>
              )}
            </main>

            <aside className="tm-inspector">
              {videoMode && (
                <div className="tm-inspector-tabs" role="group" aria-label="Ferramentas do editor">
                  <button
                    className={inspectorTab === "captions" ? "tm-tab-active" : ""}
                    onClick={() => setInspectorTab("captions")}
                  >
                    Editar legendas
                  </button>
                  <button
                    className={inspectorTab === "export" ? "tm-tab-active" : ""}
                    onClick={() => setInspectorTab("export")}
                  >
                    Exportar vídeo
                  </button>
                </div>
              )}
              <details className="tm-card tm-settings">
                <summary>Configurações da produção</summary>
                <EditField
                  label="Título do projeto"
                  value={draft.title}
                  onChange={(title) => edit((current) => ({ ...current, title }))}
                  maxLength={140}
                />
                <label className="tm-field">
                  <span>Formato</span>
                  <select
                    value={draft.format}
                    onChange={(event) => {
                      if (event.target.value === "carousel" && audioMode === "original") {
                        setAudioMode("silent");
                      }
                      edit((current) => ({
                        ...current,
                        format: event.target.value as MediaFormat,
                      }));
                    }}
                  >
                    <option value="carousel">Carrossel</option>
                    <option value="lesson_video">Vídeo educativo</option>
                    <option value="lyrics_video">Lyrics + tradução</option>
                  </select>
                </label>
                <label className="tm-field">
                  <span>Identidade visual</span>
                  <select
                    value={draft.theme}
                    onChange={(event) =>
                      edit((current) => ({
                        ...current,
                        theme: event.target.value as MediaProject["theme"],
                      }))
                    }
                  >
                    <option value="ihub">iHub English</option>
                    <option value="midnight">Midnight</option>
                    <option value="warm">Warm</option>
                  </select>
                </label>
              </details>
              {videoMode && inspectorTab === "captions" && (
                <div className="tm-card tm-caption-editor">
                  <h2>
                    <Subtitles size={18} /> Legendas e efeitos
                  </h2>
                  <p className="tm-small">
                    Prévia em cima do vídeo original. Use a linha do tempo para escolher a fala,
                    ajustar a tradução e destacar expressões. As alterações ficam só nesta produção.
                  </p>
                  <label className="tm-field">
                    <span>Estilo</span>
                    <select
                      aria-label="Estilo das legendas"
                      value={captionStyle.template}
                      onChange={(event) =>
                        changeCaptionStyle({
                          template: event.target.value as MediaCaptionStyle["template"],
                        })
                      }
                    >
                      <option value="clean">Leve e elegante</option>
                      <option value="impact">Impacto</option>
                      <option value="karaoke">Destaque da fala</option>
                    </select>
                  </label>
                  <label className="tm-field">
                    <span>Posição</span>
                    <select
                      aria-label="Posição das legendas"
                      value={captionStyle.position}
                      onChange={(event) =>
                        changeCaptionStyle({
                          position: event.target.value as MediaCaptionStyle["position"],
                        })
                      }
                    >
                      <option value="top">Superior</option>
                      <option value="center">Centro</option>
                      <option value="bottom">Inferior</option>
                    </select>
                  </label>
                  <label className="tm-field">
                    <span>Animação</span>
                    <select
                      aria-label="Animação das legendas"
                      value={captionStyle.animation}
                      onChange={(event) =>
                        changeCaptionStyle({
                          animation: event.target.value as MediaCaptionStyle["animation"],
                        })
                      }
                    >
                      <option value="none">Sem animação</option>
                      <option value="fade">Aparecer suavemente</option>
                      <option value="pop">Destacar ao entrar</option>
                    </select>
                  </label>
                  <label className="tm-field">
                    <span>Tamanho do texto: {Math.round(captionStyle.text_scale * 100)}%</span>
                    <input
                      type="range"
                      aria-label="Tamanho das legendas"
                      min={0.6}
                      max={1.6}
                      step={0.1}
                      value={captionStyle.text_scale}
                      onChange={(event) =>
                        changeCaptionStyle({ text_scale: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label className="tm-field">
                    <span>Cor das legendas</span>
                    <input
                      type="color"
                      aria-label="Cor das legendas"
                      value={captionStyle.text_color}
                      onChange={(event) =>
                        changeCaptionStyle({ text_color: event.target.value.toUpperCase() })
                      }
                    />
                  </label>
                  {selectedCaption ? (
                    <>
                      <div className="tm-editor-separator" />
                      <h2>Fala selecionada · {durationLabel(selectedCaption.start_ms)}</h2>
                      <label className="tm-enabled-toggle">
                        <input
                          type="checkbox"
                          checked={selectedCaption.enabled}
                          onChange={(event) =>
                            updateCaption(selectedCaption.cue_id, { enabled: event.target.checked })
                          }
                        />
                        Mostrar esta legenda no vídeo
                      </label>
                      <EditField
                        label="Inglês"
                        value={selectedCaption.en}
                        onChange={(en) => updateCaption(selectedCaption.cue_id, { en })}
                        multiline
                        maxLength={600}
                      />
                      <EditField
                        label="Tradução"
                        value={selectedCaption.pt}
                        onChange={(pt) => updateCaption(selectedCaption.cue_id, { pt })}
                        multiline
                        maxLength={800}
                      />
                      <EditField
                        label="Palavra ou expressão em destaque"
                        value={selectedCaption.highlight}
                        onChange={(highlight) =>
                          updateCaption(selectedCaption.cue_id, { highlight })
                        }
                        maxLength={120}
                        hint="Use exatamente o trecho que aparece no inglês."
                      />
                      <EditField
                        label="Mini-aula opcional"
                        value={selectedCaption.note ?? ""}
                        onChange={(note) => updateCaption(selectedCaption.cue_id, { note })}
                        multiline
                        maxLength={300}
                        hint="Uma explicação curta que aparece abaixo da tradução no vídeo."
                      />
                      <div className="tm-caption-timing">
                        <label className="tm-field">
                          <span>Entrada (segundos)</span>
                          <input
                            type="number"
                            min={0}
                            max={Math.max(0, actualDurationMs / 1000)}
                            step={0.1}
                            aria-label="Entrada da legenda em segundos"
                            value={selectedCaption.start_ms / 1000}
                            onChange={(event) =>
                              setCaptionTiming(
                                selectedCaption.cue_id,
                                "start_ms",
                                Number(event.target.value) * 1000,
                              )
                            }
                          />
                        </label>
                        <label className="tm-field">
                          <span>Saída (segundos)</span>
                          <input
                            type="number"
                            min={0}
                            max={Math.max(0, actualDurationMs / 1000)}
                            step={0.1}
                            aria-label="Saída da legenda em segundos"
                            value={selectedCaption.end_ms / 1000}
                            onChange={(event) =>
                              setCaptionTiming(
                                selectedCaption.cue_id,
                                "end_ms",
                                Number(event.target.value) * 1000,
                              )
                            }
                          />
                        </label>
                      </div>
                      <button
                        onClick={() => {
                          const removedId = selectedCaption.cue_id;
                          edit((current) => ({
                            ...current,
                            video_captions: current.video_captions?.filter(
                              (cue) => cue.cue_id !== removedId,
                            ),
                          }));
                          setSelectedCaptionId(null);
                        }}
                      >
                        <Trash2 size={14} /> Remover bloco
                      </button>
                    </>
                  ) : (
                    <p className="tm-small">Toque em uma fala da linha do tempo para editar.</p>
                  )}
                </div>
              )}
              {!videoMode && active && (
                <div className="tm-card">
                  <h2>Editar quadro {activeIndex + 1}</h2>
                  <label className="tm-field">
                    <span>Modelo</span>
                    <select
                      value={active.kind}
                      onChange={(event) => updateSlide({ kind: event.target.value as MediaKind })}
                    >
                      <option value="cover">Abertura</option>
                      <option value="lesson">Mini-aula</option>
                      <option value="example">Exemplo</option>
                      <option value="challenge">Desafio</option>
                      <option value="lyric">Letra + tradução</option>
                    </select>
                  </label>
                  <EditField
                    label="Chamada / etiqueta"
                    value={active.heading}
                    onChange={(heading) => updateSlide({ heading })}
                    maxLength={120}
                  />
                  <EditField
                    label="Texto em inglês"
                    value={active.en}
                    onChange={(en) => updateSlide({ en })}
                    multiline
                    maxLength={600}
                  />
                  <EditField
                    label="Tradução em português"
                    value={active.pt}
                    onChange={(pt) => updateSlide({ pt })}
                    multiline
                    maxLength={800}
                  />
                  <EditField
                    label="Contexto / explicação"
                    value={active.note}
                    onChange={(note) => updateSlide({ note })}
                    multiline
                    maxLength={900}
                  />
                  <EditField
                    label="Estrutura / destaque"
                    value={active.highlight}
                    onChange={(highlight) => updateSlide({ highlight })}
                    maxLength={120}
                  />
                  <label className="tm-field">
                    <span>Duração: {(active.duration_ms / 1000).toFixed(1)}s</span>
                    <input
                      type="range"
                      min={1000}
                      max={20000}
                      step={500}
                      value={active.duration_ms}
                      onChange={(event) => updateSlide({ duration_ms: Number(event.target.value) })}
                    />
                  </label>
                  <div className="tm-template-row">
                    <button onClick={() => addSlide("example")}>
                      <Plus size={14} /> Exemplo
                    </button>
                    <button onClick={() => addSlide("challenge")}>
                      <Plus size={14} /> Desafio
                    </button>
                    <button onClick={() => addSlide("lyric")}>
                      <Plus size={14} /> Lyric
                    </button>
                  </div>
                </div>
              )}
              {(!videoMode || inspectorTab === "export") && (
                <div className="tm-card">
                  <h2>
                    <Music2 size={18} /> Áudio e exportação
                  </h2>
                  <label className="tm-field">
                    <span>Enviar música ou áudio (MP3, WAV, OGG)</span>
                    <input
                      type="file"
                      accept=".mp3,.wav,.ogg,audio/*"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file && !dirty && !save.isPending) upload.mutate(file);
                        else if (file) setNotice("Aguarde o salvamento antes de enviar o áudio.");
                        event.target.value = "";
                      }}
                    />
                  </label>
                  {draft.audio_filename && (
                    <audio
                      controls
                      src={mediaApi.audioUrl(draft.id)}
                      aria-label="Prévia da trilha enviada"
                    />
                  )}
                  <label className="tm-field">
                    <span>Trilha do vídeo</span>
                    <select
                      value={audioMode}
                      onChange={(event) => setAudioMode(event.target.value as typeof audioMode)}
                    >
                      {videoMode && <option value="original">Som original do vídeo</option>}
                      <option value="silent">Sem áudio</option>
                      <option value="uploaded">Áudio enviado</option>
                      {!videoMode && <option value="voice">Narração com voz do Generator</option>}
                    </select>
                  </label>
                  {audioMode === "voice" && (
                    <label className="tm-field">
                      <span>Voz</span>
                      <select value={voiceId} onChange={(event) => setVoiceId(event.target.value)}>
                        <option value="">Selecione uma voz</option>
                        {voices.data?.map((voice) => (
                          <option key={voice.id} value={voice.id}>
                            {voice.name} · v{voice.version}
                          </option>
                        ))}
                      </select>
                      <Link to="/voices">Gerenciar vozes</Link>
                    </label>
                  )}
                  {!videoMode && (
                    <button
                      className="tm-accent"
                      onClick={() => exportSlides.mutate()}
                      disabled={dirty || save.isPending || exportSlides.isPending}
                    >
                      <Download size={16} />{" "}
                      {exportSlides.isPending ? "Preparando…" : "Baixar carrossel (ZIP)"}
                    </button>
                  )}
                  <button
                    onClick={() => render.mutate()}
                    disabled={
                      dirty ||
                      save.isPending ||
                      render.isPending ||
                      (videoMode &&
                        (!(draft.source_scene_id || draft.source_cut_job_id) ||
                          !captions.some((cue) => cue.enabled))) ||
                      (audioMode === "voice" && !voiceId) ||
                      (audioMode === "uploaded" && !draft.audio_filename)
                    }
                  >
                    <Film size={16} />{" "}
                    {render.isPending
                      ? "Preparando vídeo…"
                      : videoMode
                        ? "Gerar vídeo com legendas"
                        : "Gerar vídeo MP4"}
                  </button>
                  {jobId && (
                    <p className="tm-small">
                      Render: <Link to="/jobs">{job.data?.status ?? "aguardando"}</Link>
                      {job.data?.error_message ? ` · ${job.data.error_message}` : ""}
                    </p>
                  )}
                  {job.data?.status === "succeeded" && renderId && (
                    <>
                      <video
                        controls
                        src={mediaApi.videoUrl(draft.id, renderId)}
                        aria-label="Vídeo final exportado"
                      />
                      <a
                        className="tm-download"
                        href={mediaApi.videoUrl(draft.id, renderId)}
                        download="tiktok-media.mp4"
                      >
                        <Download size={16} /> Baixar MP4
                      </a>
                    </>
                  )}
                  <p className="tm-small">
                    Para músicas e cenas de terceiros, use apenas arquivos com autorização de uso.
                  </p>
                </div>
              )}
            </aside>
          </>
        )}
      </div>
      {notice && (
        <div className="tm-notice" role="status">
          {notice}
        </div>
      )}
      {projects.isError && <p role="alert">{projects.error.message}</p>}
    </section>
  );
}
