import { Check, ChevronLeft, ChevronRight, Clock3, Film, Play, Save, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Project, ProjectMedia, Scene } from "../../lib/api.types";
import { PageHeader } from "../../components/PageHeader";
import { studioApi } from "../../lib/studio-api";
import { CueWordTimeline, type TimelineCue } from "./CueWordTimeline";
import { nudgeTiming, setTimingEdge, validateTimeline } from "./timeline";
import "./timeline.css";
import "./editorial-workspace.css";

const formatTime = (timeMs: number) => {
  const seconds = Math.max(0, timeMs) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
};

export function EditorialPage() {
  const [params] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [media, setMedia] = useState<ProjectMedia | null>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const playbackEnd = useRef<number | null>(null);
  const [projectId, setProjectId] = useState(params.get("project") ?? "");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sceneId, setSceneId] = useState("");
  const [message, setMessage] = useState("");
  const [cues, setCues] = useState<TimelineCue[]>([]);
  const [history, setHistory] = useState<TimelineCue[][]>([]);
  const [selectedCueId, setSelectedCueId] = useState("");
  const [selectedWordId, setSelectedWordId] = useState<string>();
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [approvedEn, setApprovedEn] = useState("");
  const [approvedPt, setApprovedPt] = useState("");
  const [wordStart, setWordStart] = useState(0);
  const [wordEnd, setWordEnd] = useState(0);
  const [saving, setSaving] = useState(false);
  const [startingMedia, setStartingMedia] = useState(false);
  const [mediaReload, setMediaReload] = useState(0);
  const author = "local-editor";

  const project = projects.find((item) => item.id === projectId);
  const selectedScene = scenes.find((item) => item.id === sceneId);
  const durationMs = selectedScene?.duration_ms ?? media?.duration_ms ?? 1;
  const matchingMedia = Boolean(
    media?.ingest_job_id && media.ingest_job_id === selectedScene?.provenance.ingest_job_id,
  );
  const selectedCueIndex = cues.findIndex((cue) => cue.id === selectedCueId);
  const selectedCue = cues[selectedCueIndex];
  const selectedWord = selectedCue?.words.find((item) => item.id === selectedWordId);
  const approvedCount = cues.filter((cue) => cue.provenance?.approval === "approved").length;
  const textDirty = Boolean(
    selectedCue &&
    (approvedEn !== selectedCue.approved_en || approvedPt !== selectedCue.approved_pt),
  );
  const wordDirty = Boolean(
    selectedWord && (wordStart !== selectedWord.start_ms || wordEnd !== selectedWord.end_ms),
  );
  const selectedWordIndex =
    selectedCue?.words.findIndex((word) => word.id === selectedWordId) ?? -1;
  const previewCues = selectedWord
    ? cues.map((cue) =>
        cue.id === selectedCue.id
          ? {
              ...cue,
              words: cue.words.map((word) =>
                word.id === selectedWord.id
                  ? { ...word, start_ms: wordStart, end_ms: wordEnd }
                  : word,
              ),
            }
          : cue,
      )
    : cues;
  const timingDirty = history.length > 0;
  const isDirty = textDirty || wordDirty || timingDirty;
  const cueStatus = selectedCue?.provenance?.approval === "approved" ? "Aprovado" : "Pendente";

  useEffect(() => {
    void studioApi
      .projects()
      .then(setProjects)
      .catch((error: Error) => setMessage(error.message));
  }, []);
  useEffect(() => {
    setScenes([]);
    setSceneId("");
    setCues([]);
    setSelectedCueId("");
    setMedia(null);
    if (!projectId) return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    async function loadReview() {
      try {
        const currentMedia = await studioApi.projectMedia(projectId);
        if (cancelled) return;
        setMedia(currentMedia);
        if (!currentMedia.can_review) {
          setMessage("");
          if (currentMedia.state === "source_processing" || currentMedia.state === "asr_processing")
            refreshTimer = setTimeout(() => void loadReview(), 2000);
          return;
        }
        const context = await studioApi.openEditorialReview(projectId);
        if (cancelled) return;
        setScenes([context.scene]);
        setSceneId(context.scene.id);
        setMessage("");
      } catch {
        if (!cancelled)
          setMessage("Não foi possível carregar a etapa atual. Tente novamente ou abra Mídia.");
      }
    }
    void loadReview();
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [projectId, mediaReload]);
  useEffect(() => {
    setCues([]);
    setSelectedCueId("");
    setHistory([]);
    if (!sceneId) return;
    let cancelled = false;
    void studioApi
      .editorialCues(sceneId)
      .then((items) => {
        if (cancelled) return;
        setCues(items);
        setSelectedCueId(items[0]?.id ?? "");
        setPlayheadMs(items[0]?.speech_timing.start_ms ?? 0);
      })
      .catch((error: Error) => {
        if (!cancelled) setMessage(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sceneId]);
  useEffect(() => {
    setApprovedEn(selectedCue?.approved_en ?? "");
    setApprovedPt(selectedCue?.approved_pt ?? "");
  }, [selectedCue?.id, selectedCue?.approved_en, selectedCue?.approved_pt]);
  useEffect(() => {
    setWordStart(selectedWord?.start_ms ?? 0);
    setWordEnd(selectedWord?.end_ms ?? 0);
  }, [selectedWord?.id, selectedWord?.start_ms, selectedWord?.end_ms]);

  async function refreshCues(): Promise<TimelineCue[]> {
    if (!sceneId) return [];
    const refreshed = await studioApi.editorialCues(sceneId);
    setCues(refreshed);
    setHistory([]);
    return refreshed;
  }
  function seek(timeMs: number) {
    const bounded = Math.max(0, Math.min(timeMs, durationMs));
    setPlayheadMs(bounded);
    if (mediaRef.current) mediaRef.current.currentTime = bounded / 1000;
  }
  function selectCue(id: string) {
    if (id === selectedCueId || saving) return;
    if (id !== selectedCueId && isDirty) {
      setMessage("Salve ou desfaça as alterações antes de trocar de cue.");
      return;
    }
    mediaRef.current?.pause();
    playbackEnd.current = null;
    setSelectedCueId(id);
    setSelectedWordId(undefined);
    const cue = cues.find((item) => item.id === id);
    if (cue) seek(cue.speech_timing.start_ms);
  }
  function selectWord(id: string) {
    if (saving || id === selectedWordId) return;
    if (wordDirty) {
      setMessage("Salve ou descarte o ajuste da palavra antes de selecionar outra.");
      return;
    }
    const word = selectedCue?.words.find((item) => item.id === id);
    if (word) {
      setSelectedWordId(id);
      seek(word.start_ms);
      setMessage(`Editando palavra “${word.surface}”. Espaço ouve somente esta palavra.`);
    }
  }
  function moveWord(offset: number) {
    if (!selectedCue || wordDirty) {
      if (wordDirty) setMessage("Salve ou descarte o ajuste antes de trocar de palavra.");
      return;
    }
    const next = selectedCue.words[selectedWordIndex + offset];
    if (next) selectWord(next.id);
  }
  function leaveWordMode() {
    if (wordDirty) {
      setMessage("Salve ou descarte o ajuste da palavra antes de voltar ao cue.");
      return;
    }
    setSelectedWordId(undefined);
    if (selectedCue) seek(selectedCue.speech_timing.start_ms);
    setMessage("");
  }
  function discardChanges() {
    if (saving) return;
    const original = history[0]?.find((cue) => cue.id === selectedCueId) ?? selectedCue;
    if (history[0]) setCues(history[0]);
    setHistory([]);
    setApprovedEn(original?.approved_en ?? "");
    setApprovedPt(original?.approved_pt ?? "");
    const word = original?.words.find((item) => item.id === selectedWordId);
    setWordStart(word?.start_ms ?? 0);
    setWordEnd(word?.end_ms ?? 0);
    setMessage("Alterações locais descartadas.");
  }
  function playRange(start: number, end: number) {
    const player = mediaRef.current;
    if (!player || end <= start) return;
    seek(start);
    playbackEnd.current = end;
    void player.play().catch(() => setMessage("Não foi possível reproduzir o corte."));
  }
  function syncPlayback(player: HTMLVideoElement) {
    if (playbackEnd.current !== null && player.currentTime * 1000 >= playbackEnd.current) {
      const end = playbackEnd.current;
      playbackEnd.current = null;
      player.pause();
      player.currentTime = end / 1000;
    }
    setPlayheadMs(player.currentTime * 1000);
  }
  useEffect(() => {
    if (!playing) return;
    let frame: number;
    const tick = () => {
      if (mediaRef.current) syncPlayback(mediaRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (isDirty) void saveChanges();
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable=true]")
      )
        return;
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        moveCue(event.key === "ArrowUp" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  function replaceCues(next: TimelineCue[]) {
    setHistory((value) => [...value, cues]);
    setCues(next);
  }
  function nudge(edge: "start" | "end", deltaMs: number) {
    if (!selectedCue || saving) return;
    if (selectedWord) {
      const prior = selectedCue.words[selectedWordIndex - 1];
      const next = selectedCue.words[selectedWordIndex + 1];
      if (edge === "start") {
        const minimum = Math.max(selectedCue.speech_timing.start_ms, prior?.end_ms ?? 0);
        setWordStart(Math.max(minimum, Math.min(wordStart + deltaMs, wordEnd - 1)));
      } else {
        const maximum = Math.min(selectedCue.speech_timing.end_ms, next?.start_ms ?? durationMs);
        setWordEnd(Math.min(maximum, Math.max(wordEnd + deltaMs, wordStart + 1)));
      }
      return;
    }
    replaceCues(
      cues.map((cue) =>
        cue.id !== selectedCue.id
          ? cue
          : { ...cue, speech_timing: nudgeTiming(cue.speech_timing, edge, deltaMs, durationMs) },
      ),
    );
  }
  function markActiveEdge(edge: "start" | "end") {
    if (!selectedCue || saving) return;
    if (selectedWord) {
      const prior = selectedCue.words[selectedWordIndex - 1];
      const next = selectedCue.words[selectedWordIndex + 1];
      if (edge === "start") {
        const minimum = Math.max(selectedCue.speech_timing.start_ms, prior?.end_ms ?? 0);
        setWordStart(Math.max(minimum, Math.min(Math.round(playheadMs), wordEnd - 1)));
      } else {
        const maximum = Math.min(selectedCue.speech_timing.end_ms, next?.start_ms ?? durationMs);
        setWordEnd(Math.min(maximum, Math.max(Math.round(playheadMs), wordStart + 1)));
      }
      setMessage(
        `${edge === "start" ? "IN" : "OUT"} da palavra “${selectedWord.surface}” marcado em ${formatTime(playheadMs)}.`,
      );
      return;
    }
    replaceCues(
      cues.map((cue) =>
        cue.id !== selectedCue.id
          ? cue
          : {
              ...cue,
              speech_timing: setTimingEdge(cue.speech_timing, edge, playheadMs, durationMs),
            },
      ),
    );
    setMessage(
      `${edge === "start" ? "Início" : "Fim"} do cue marcado em ${formatTime(playheadMs)}.`,
    );
  }
  function undo() {
    if (wordDirty && selectedWord) {
      setWordStart(selectedWord.start_ms);
      setWordEnd(selectedWord.end_ms);
      setMessage("Ajuste da palavra desfeito.");
      return;
    }
    const prior = history.at(-1);
    if (!prior) return;
    setCues(prior);
    setHistory((value) => value.slice(0, -1));
  }
  function togglePlayback() {
    const player = mediaRef.current;
    if (!player || !selectedCue) return;
    if (player.paused)
      playRange(
        selectedWord ? wordStart : selectedCue.speech_timing.start_ms,
        selectedWord ? wordEnd : selectedCue.speech_timing.end_ms,
      );
    else {
      playbackEnd.current = null;
      player.pause();
    }
  }
  function toggleContinuousPlayback() {
    const player = mediaRef.current;
    if (!player) return;
    playbackEnd.current = null;
    if (player.paused)
      void player.play().catch(() => setMessage("Não foi possível reproduzir a cena."));
    else player.pause();
  }
  async function saveChanges(approve = false, advance = false) {
    if (!selectedCue || saving) return;
    if (approve && (!approvedEn || !approvedPt)) {
      setMessage("Preencha os textos em inglês e português antes de aprovar o cue.");
      return;
    }
    const candidate = previewCues.find((cue) => cue.id === selectedCue.id) ?? selectedCue;
    const errors = validateTimeline([candidate]);
    if (
      candidate.words.some(
        (word) => !Number.isInteger(word.start_ms) || !Number.isInteger(word.end_ms),
      )
    )
      errors.push("Use milissegundos inteiros nos tempos da palavra.");
    if (errors.length) {
      setMessage(errors[0]);
      return;
    }
    setSaving(true);
    try {
      if (timingDirty)
        await studioApi.updateCueTiming(selectedCue.id, {
          author,
          speech_timing: selectedCue.speech_timing,
          subtitle_timing: selectedCue.subtitle_timing,
        });
      if (wordDirty && selectedWord)
        await studioApi.updateWordTiming(selectedCue.id, {
          author,
          timings: selectedCue.words.map((item) => ({
            id: item.id,
            start_ms: item.id === selectedWord.id ? wordStart : item.start_ms,
            end_ms: item.id === selectedWord.id ? wordEnd : item.end_ms,
          })),
        });
      if (textDirty || approve)
        await studioApi.updateCueText(selectedCue.id, {
          author,
          approved_en: approvedEn,
          approved_pt: approvedPt,
          approve,
        });
      const nextWord =
        advance && selectedWord ? selectedCue.words[selectedWordIndex + 1] : undefined;
      const nextCueForWord =
        advance && selectedWord && !nextWord ? cues[selectedCueIndex + 1] : undefined;
      const refreshed = await refreshCues();
      const currentIndex = refreshed.findIndex((cue) => cue.id === selectedCue.id);
      const nextCue = advance && !selectedWord ? refreshed[currentIndex + 1] : undefined;
      if (nextWord) {
        setSelectedWordId(nextWord.id);
        seek(nextWord.start_ms);
      } else if (nextCueForWord) {
        const freshCue = refreshed.find((cue) => cue.id === nextCueForWord.id);
        const firstWord = freshCue?.words[0];
        if (freshCue && firstWord) {
          setSelectedCueId(freshCue.id);
          setSelectedWordId(firstWord.id);
          seek(firstWord.start_ms);
        }
      } else if (nextCue) {
        setSelectedCueId(nextCue.id);
        setSelectedWordId(undefined);
        seek(nextCue.speech_timing.start_ms);
      }
      setMessage(
        approve
          ? `Cue ${selectedCue.order} aprovado.`
          : advance && selectedWord && (nextWord || nextCueForWord)
            ? `Palavra “${selectedWord.surface}” salva. Próxima palavra aberta.`
            : nextCue
              ? `Cue ${selectedCue.order} salva. Próxima cue aberta.`
              : "Alterações salvas.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar revisão.");
    } finally {
      setSaving(false);
    }
  }
  function moveCue(offset: number) {
    const next = cues[selectedCueIndex + offset];
    if (next) selectCue(next.id);
  }
  async function startMediaProcessing() {
    if (!projectId || startingMedia) return;
    setStartingMedia(true);
    try {
      setMedia(await studioApi.startProjectMedia(projectId));
      setMessage("Processamento iniciado. Esta tela será atualizada automaticamente.");
      setMediaReload((value) => value + 1);
    } catch {
      setMessage("Não foi possível iniciar o processamento. Abra Mídia para ver os detalhes.");
    } finally {
      setStartingMedia(false);
    }
  }
  return (
    <section className="editorial-workstation">
      <PageHeader
        title="Revisão editorial"
        description="Ouça, compare e aprove cada cue sem perder o contexto do corte."
      />
      <header className="review-context" aria-label="Contexto da revisão">
        <label>
          <span>Projeto</span>
          <select
            value={projectId}
            onChange={(event) => {
              if (isDirty) setMessage("Salve ou desfaça as alterações antes de trocar de projeto.");
              else setProjectId(event.target.value);
            }}
          >
            <option value="">Selecione um projeto</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Cena</span>
          <select
            value={sceneId}
            onChange={(event) => {
              if (isDirty) setMessage("Salve ou desfaça as alterações antes de trocar de cena.");
              else setSceneId(event.target.value);
            }}
            disabled={!projectId || scenes.length === 0}
          >
            {scenes.length === 0 && <option value="">Nenhuma cena disponível</option>}
            {scenes.map((item) => (
              <option key={item.id} value={item.id}>
                Cena {item.order}
              </option>
            ))}
          </select>
        </label>
        <div
          className="review-progress"
          aria-label={`${approvedCount} de ${cues.length} cues aprovados`}
        >
          <span>{project?.title ?? "Escolha a produção"}</span>
          <strong>
            {cues.length ? `${approvedCount} de ${cues.length} cues` : "Sem revisão ativa"}
          </strong>
          <progress max={Math.max(cues.length, 1)} value={approvedCount} />
        </div>
      </header>
      {message && (
        <p className="review-message" role="status">
          {message}
        </p>
      )}
      {!projectId && (
        <div className="editorial-empty panel">
          <Film aria-hidden="true" />
          <h2>Escolha um projeto para revisar</h2>
          <p>Projetos com corte transcrito aparecem aqui com seus cues e palavras sincronizados.</p>
        </div>
      )}
      {projectId && !selectedCue && (
        <div className="editorial-empty panel" role="status">
          <Clock3 aria-hidden="true" />
          {media?.state === "source_validated" && (
            <>
              <h2>Vídeo validado</h2>
              <p>O download ainda não foi iniciado.</p>
              <button
                type="button"
                className="primary-button"
                onClick={() => void startMediaProcessing()}
                disabled={startingMedia}
              >
                {startingMedia ? "Iniciando…" : "Iniciar processamento"}
              </button>
            </>
          )}
          {media?.state === "source_processing" && (
            <>
              <h2>Baixando o vídeo</h2>
              <p>O download está em andamento. O estado será atualizado automaticamente.</p>
            </>
          )}
          {media?.state === "cut_required" && (
            <>
              <h2>Vídeo pronto para recorte</h2>
              <p>Escolha o início e o fim do trecho antes de transcrever.</p>
              <Link className="primary-button" to={`/media?project=${projectId}`}>
                Abrir recorte
              </Link>
            </>
          )}
          {media?.state === "asr_processing" && (
            <>
              <h2>Transcrevendo o corte</h2>
              <p>
                A transcrição está em andamento. Esta tela verifica o resultado automaticamente.
              </p>
            </>
          )}
          {media?.state === "failed" && (
            <>
              <h2>O processamento encontrou um problema</h2>
              <p>
                {media.download_error ?? media.ingest_error ?? "Consulte os detalhes da mídia."}
              </p>
              <Link className="primary-button" to={`/media?project=${projectId}`}>
                Ver detalhes e tentar novamente
              </Link>
            </>
          )}
          {!media && (
            <>
              <h2>Verificando a produção</h2>
              <p>Carregando a etapa atual…</p>
            </>
          )}
        </div>
      )}
      {selectedCue && (
        <>
          <div className="review-overview">
            <nav className="review-cue-list panel" aria-label="Lista de cues">
              <h2>
                Cues <span>{cues.length}</span>
              </h2>
              <ol>
                {cues.map((cue) => (
                  <li key={cue.id}>
                    <button
                      type="button"
                      aria-current={cue.id === selectedCueId ? "true" : undefined}
                      onClick={() => selectCue(cue.id)}
                      disabled={saving}
                    >
                      <span className="review-cue-number">{cue.order}</span>
                      <span className="review-cue-copy">
                        <strong>{cue.approved_en || cue.original_en}</strong>
                        <small>
                          {formatTime(cue.speech_timing.start_ms)} ·{" "}
                          {cue.provenance?.approval === "approved" ? "Aprovado" : "Pendente"}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <section className="review-player panel" aria-labelledby="cut-player-title">
              <div className="player-copy">
                <span className="eyebrow">Corte da cena {selectedScene?.order}</span>
                <h2 id="cut-player-title">{project?.title}</h2>
                <p>
                  Cue {selectedCue.order} · {formatTime(selectedCue.speech_timing.start_ms)}–
                  {formatTime(selectedCue.speech_timing.end_ms)}
                </p>
              </div>
              {matchingMedia && media?.cut_url ? (
                <video
                  ref={mediaRef}
                  src={media.cut_url}
                  controls
                  preload="metadata"
                  aria-label="Player do corte da cena"
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onTimeUpdate={(event) => syncPlayback(event.currentTarget)}
                  onEnded={() => setPlaying(false)}
                />
              ) : (
                <div className="player-unavailable" role="status">
                  Prévia do corte indisponível
                </div>
              )}
              <div className="review-listen-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!matchingMedia || !media?.cut_url}
                  onClick={() =>
                    playRange(selectedCue.speech_timing.start_ms, selectedCue.speech_timing.end_ms)
                  }
                >
                  <Play aria-hidden="true" /> Ouvir cue
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!selectedWord || !matchingMedia || !media?.cut_url}
                  onClick={() => playRange(wordStart, wordEnd)}
                >
                  <Play aria-hidden="true" /> Ouvir palavra
                </button>
              </div>
            </section>
          </div>
          <p className="review-keyboard-hints">
            <kbd>Espaço</kbd> cue · <kbd>Shift Espaço</kbd> cena · <kbd>A</kbd> IN · <kbd>S</kbd>
            OUT · <kbd>G</kbd> salvar + próxima · <kbd>←/→</kbd> cursor
          </p>
          <CueWordTimeline
            cues={previewCues}
            waveform={matchingMedia ? media?.waveform : null}
            durationMs={durationMs}
            playheadMs={playheadMs}
            playing={playing}
            zoom={zoom}
            selectedCueId={selectedCueId}
            selectedWordId={selectedWordId}
            onPlayToggle={togglePlayback}
            onContinuousPlayToggle={toggleContinuousPlayback}
            onSaveAndNext={() => void saveChanges(false, true)}
            onPlayheadChange={seek}
            onZoomChange={setZoom}
            onSelectCue={selectCue}
            onSelectWord={selectWord}
            onSetEdge={markActiveEdge}
            onNudge={nudge}
            onUndo={undo}
          />
          <nav className="cue-navigation" aria-label="Navegação entre cues">
            <button
              type="button"
              className="secondary-button"
              onClick={() => moveCue(-1)}
              disabled={selectedCueIndex <= 0}
            >
              <ChevronLeft aria-hidden="true" /> Cue anterior
            </button>
            <div>
              <strong>Cue {selectedCue.order}</strong>
              <span className={`cue-state cue-state-${cueStatus.toLowerCase().replace(" ", "-")}`}>
                {cueStatus}
              </span>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => moveCue(1)}
              disabled={selectedCueIndex >= cues.length - 1}
            >
              Próximo cue <ChevronRight aria-hidden="true" />
            </button>
          </nav>
          <div className="editorial-grid">
            <article className="panel cue-editor">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">Texto do cue</span>
                  <h2>Compare inglês e português</h2>
                </div>
                {isDirty && <span className="unsaved-badge">Alterações não salvas</span>}
              </div>
              <div className="asr-reference">
                <span>Transcrição original</span>
                <p>{selectedCue.original_en}</p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving || Boolean(approvedEn)}
                  onClick={() => setApprovedEn(selectedCue.original_en)}
                >
                  Usar transcrição no inglês
                </button>
              </div>
              <div className="language-fields">
                <label>
                  <span>Inglês aprovado</span>
                  <textarea
                    value={approvedEn}
                    onChange={(event) => setApprovedEn(event.target.value)}
                    rows={3}
                  />
                </label>
                <label>
                  <span>Português aprovado</span>
                  <textarea
                    value={approvedPt}
                    onChange={(event) => setApprovedPt(event.target.value)}
                    rows={3}
                  />
                </label>
              </div>

              <details className="technical-details">
                <summary>Ajuste fino da fala do cue</summary>
                <div className="timing-controls">
                  <span>Início {selectedCue.speech_timing.start_ms} ms</span>
                  <button
                    type="button"
                    onClick={() => nudge("start", -25)}
                    aria-label="Antecipar início do cue em 25 milissegundos"
                  >
                    −25
                  </button>
                  <button
                    type="button"
                    onClick={() => nudge("start", 25)}
                    aria-label="Atrasar início do cue em 25 milissegundos"
                  >
                    +25
                  </button>
                  <span>Fim {selectedCue.speech_timing.end_ms} ms</span>
                  <button
                    type="button"
                    onClick={() => nudge("end", -25)}
                    aria-label="Antecipar fim do cue em 25 milissegundos"
                  >
                    −25
                  </button>
                  <button
                    type="button"
                    onClick={() => nudge("end", 25)}
                    aria-label="Atrasar fim do cue em 25 milissegundos"
                  >
                    +25
                  </button>
                </div>
              </details>
            </article>
            <aside className="panel word-inspector" aria-labelledby="word-inspector-title">
              <span className="eyebrow">Inspetor contextual</span>
              <h2 id="word-inspector-title">
                {selectedWord ? `Palavra “${selectedWord.surface}”` : "Selecione uma palavra"}
              </h2>
              {selectedWord && (
                <div className="word-mode-status">
                  <span>
                    Palavra {selectedWordIndex + 1} de {selectedCue.words.length}
                  </span>
                  <button type="button" className="secondary-button" onClick={leaveWordMode}>
                    Voltar ao cue
                  </button>
                </div>
              )}
              <ol className="word-list" aria-label="Palavras do cue selecionado">
                {selectedCue.words.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={item.id === selectedWordId ? "word-row selected" : "word-row"}
                      onClick={() => selectWord(item.id)}
                      aria-pressed={item.id === selectedWordId}
                    >
                      <strong>{item.surface}</strong>
                      <span>
                        {formatTime(item.id === selectedWordId ? wordStart : item.start_ms)}–
                        {formatTime(item.id === selectedWordId ? wordEnd : item.end_ms)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              {selectedWord && (
                <div className="word-timing-editor">
                  <div className="word-timing-fields">
                    <label>
                      <span>IN (ms)</span>
                      <input
                        type="number"
                        min={selectedCue.speech_timing.start_ms}
                        max={wordEnd - 1}
                        step={1}
                        value={wordStart}
                        onChange={(event) => setWordStart(Number(event.target.value))}
                      />
                    </label>
                    <label>
                      <span>OUT (ms)</span>
                      <input
                        type="number"
                        min={wordStart + 1}
                        max={selectedCue.speech_timing.end_ms}
                        step={1}
                        value={wordEnd}
                        onChange={(event) => setWordEnd(Number(event.target.value))}
                      />
                    </label>
                  </div>
                  <p className="word-duration">
                    Duração <strong>{Math.max(0, wordEnd - wordStart)} ms</strong>
                  </p>
                  <div className="word-editor-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => playRange(wordStart, wordEnd)}
                    >
                      <Play aria-hidden="true" /> Ouvir palavra
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => markActiveEdge("start")}
                    >
                      <kbd>A</kbd> Marcar IN
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => markActiveEdge("end")}
                    >
                      <kbd>S</kbd> Marcar OUT
                    </button>
                  </div>
                  <div className="word-step-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={selectedWordIndex <= 0 || wordDirty || saving}
                      onClick={() => moveWord(-1)}
                    >
                      <ChevronLeft aria-hidden="true" /> Palavra anterior
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={saving}
                      onClick={() => void saveChanges(false, true)}
                    >
                      <Save aria-hidden="true" /> Salvar palavra e próxima
                    </button>
                  </div>
                </div>
              )}
            </aside>
          </div>
          <footer className="review-actions" aria-label="Ações da revisão">
            <div>
              <strong>
                {selectedWord
                  ? `Palavra ${selectedWordIndex + 1} de ${selectedCue.words.length} · Cue ${selectedCue.order}`
                  : `Cue ${selectedCue.order} de ${cues.length}`}
              </strong>
              <span>{isDirty ? "Há alterações não salvas" : cueStatus}</span>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={discardChanges}
              disabled={!isDirty || saving}
            >
              <Undo2 aria-hidden="true" /> Descartar
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void saveChanges()}
              disabled={!isDirty || saving}
            >
              <Save aria-hidden="true" /> {selectedWord ? "Salvar palavra" : "Salvar alterações"}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => void saveChanges(true)}
              disabled={saving}
            >
              <Check aria-hidden="true" /> Aprovar cue
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
