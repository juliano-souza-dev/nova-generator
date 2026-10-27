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
  Music2,
  Pause,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { PageHeader } from "../../components/PageHeader";
import { studioApi } from "../../lib/studio-api";
import { imageForSlide, paintSlide } from "./slide-canvas";
import {
  blankSlide,
  mediaApi,
  readExternalStoryboard,
  type MediaFormat,
  type MediaKind,
  type MediaProject,
  type MediaSlide,
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
  const scenes = useQuery({
    queryKey: ["tiktok-scenes", sourceId],
    queryFn: () => studioApi.editorialScenes(sourceId),
    enabled: Boolean(sourceId),
  });
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiCount, setAiCount] = useState(5);
  const [externalJson, setExternalJson] = useState("");
  const [proposed, setProposed] = useState<MediaSlide[] | null>(null);
  const [notice, setNotice] = useState("");
  const [audioMode, setAudioMode] = useState<"silent" | "uploaded" | "voice">("silent");
  const [voiceId, setVoiceId] = useState("");
  const [jobId, setJobId] = useState("");
  const [renderId, setRenderId] = useState("");
  const editVersion = useRef(0);
  const loadedId = useRef<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!selectedId && projects.data?.length) selectProject(projects.data[0].id);
  }, [projects.data, selectedId]);

  useEffect(() => {
    if (projectQuery.data && loadedId.current !== selectedId) {
      loadedId.current = selectedId;
      setDraft(projectQuery.data);
      setDirty(false);
      setActiveIndex(0);
      setJobId("");
      setRenderId("");
    }
  }, [projectQuery.data, selectedId]);

  function edit(change: (current: MediaProject) => MediaProject) {
    editVersion.current += 1;
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
  useEffect(() => {
    const context = previewRef.current?.getContext("2d");
    if (context && active && draft) paintSlide(context, active, draft, activeIndex);
  }, [draft, active, activeIndex]);

  useEffect(() => {
    if (!playing || !active || !draft) return;
    const timeout = window.setTimeout(() => {
      if (activeIndex < draft.slides.length - 1) setActiveIndex(activeIndex + 1);
      else setPlaying(false);
    }, active.duration_ms);
    return () => window.clearTimeout(timeout);
  }, [playing, activeIndex, active, draft]);

  const ai = useMutation({
    mutationFn: () => mediaApi.ideas(aiPrompt.trim(), draft!.format, aiCount),
    onSuccess: (data) => {
      setProposed(data.slides.map((slide) => ({ ...slide, id: crypto.randomUUID() })));
      setNotice("A proposta da IA está pronta. Revise os textos antes de aplicar.");
    },
    onError: (error) => setNotice(`${error.message} Use o campo de JSON externo abaixo.`),
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
      return approved.slice(0, 30).map(
        (cue): MediaSlide => ({
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
        }),
      );
    },
    onSuccess: (slides) => {
      edit((current) => ({ ...current, source_project_id: sourceId, slides }));
      setActiveIndex(0);
      setNotice(`${slides.length} falas importadas. Revise o enquadramento e a tradução.`);
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
      const images = await Promise.all(draft.slides.map((_, index) => imageForSlide(draft, index)));
      return mediaApi.render(draft.id, draft.revision, images, audioMode, voiceId);
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
                    Formato: <code>{'{"slides":[{"kind":"lesson","en":"...","pt":"..."}]}'}</code>
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
                        setNotice("Roteiro importado para revisão. Nenhum quadro foi substituído.");
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
                    <p>{proposed.length} quadros propostos · revisão obrigatória</p>
                    <button
                      className="tm-accent"
                      onClick={() => {
                        edit((current) => ({ ...current, slides: proposed }));
                        setActiveIndex(0);
                        setProposed(null);
                      }}
                    >
                      Aplicar proposta
                    </button>
                    <button onClick={() => setProposed(null)}>Descartar</button>
                  </div>
                )}
              </div>
              <div className="tm-card">
                <h2>
                  <ArrowLeft size={18} /> Importar do Generator
                </h2>
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
                <button
                  onClick={() => importCues.mutate()}
                  disabled={!sceneId || importCues.isPending}
                >
                  Importar falas revisadas
                </button>
                <p className="tm-small">
                  Usa EN/PT aprovados no Editorial. Para criar novos recortes e transcrever, acesse{" "}
                  <Link to="/media">Mídia</Link>.
                </p>
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
                    title="Quadro anterior"
                    onClick={() => setActiveIndex(Math.max(0, activeIndex - 1))}
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <button
                    title={playing ? "Pausar" : "Reproduzir sequência"}
                    onClick={() => {
                      if (!playing && activeIndex === draft.slides.length - 1) setActiveIndex(0);
                      setPlaying(!playing);
                    }}
                  >
                    {playing ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <button
                    title="Próximo quadro"
                    onClick={() =>
                      setActiveIndex(Math.min(draft.slides.length - 1, activeIndex + 1))
                    }
                  >
                    <ArrowRight size={16} />
                  </button>
                </span>
              </div>
              <div className="tm-stage">
                <canvas
                  ref={previewRef}
                  width={1080}
                  height={1920}
                  aria-label="Prévia do quadro 9:16"
                  role="img"
                />
              </div>
              <div className="tm-timeline-heading">
                <h2>
                  Sequência{" "}
                  <span>
                    {draft.slides.length} quadros ·{" "}
                    {(draft.slides.reduce((sum, item) => sum + item.duration_ms, 0) / 1000).toFixed(
                      1,
                    )}{" "}
                    s
                  </span>
                </h2>
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
              </div>
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
            </main>

            <aside className="tm-inspector">
              <div className="tm-card">
                <h2>Configurações</h2>
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
                    onChange={(event) =>
                      edit((current) => ({
                        ...current,
                        format: event.target.value as MediaFormat,
                      }))
                    }
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
              </div>
              {active && (
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
                    <option value="silent">Sem áudio</option>
                    <option value="uploaded">Áudio enviado</option>
                    <option value="voice">Narração com voz do Generator</option>
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
                <button
                  className="tm-accent"
                  onClick={() => exportSlides.mutate()}
                  disabled={dirty || save.isPending || exportSlides.isPending}
                >
                  <Download size={16} />{" "}
                  {exportSlides.isPending ? "Preparando…" : "Baixar carrossel (ZIP)"}
                </button>
                <button
                  onClick={() => render.mutate()}
                  disabled={
                    dirty ||
                    save.isPending ||
                    render.isPending ||
                    (audioMode === "voice" && !voiceId) ||
                    (audioMode === "uploaded" && !draft.audio_filename)
                  }
                >
                  <Film size={16} /> {render.isPending ? "Enviando quadros…" : "Gerar vídeo MP4"}
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
