import { Check, ChevronLeft, ChevronRight, Clock3, Film, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Project, ProjectMedia, Scene } from "../../lib/api.types";
import { PageHeader } from "../../components/PageHeader";
import { studioApi } from "../../lib/studio-api";
import { CueWordTimeline, type TimelineCue } from "./CueWordTimeline";
import { nudgeTiming } from "./timeline";
import "./timeline.css";

const formatTime = (timeMs: number) => {
  const seconds = Math.max(0, timeMs) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
};

export function EditorialPage() {
  const [params] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [media, setMedia] = useState<ProjectMedia | null>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
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
    void Promise.all([studioApi.projectMedia(projectId), studioApi.openEditorialReview(projectId)])
      .then(([currentMedia, context]) => {
        setMedia(currentMedia);
        setScenes([context.scene]);
        setSceneId(context.scene.id);
        setMessage("Transcrição pronta para revisão.");
      })
      .catch((error: Error) => setMessage(error.message));
  }, [projectId]);
  useEffect(() => {
    setCues([]);
    setSelectedCueId("");
    setHistory([]);
    if (!sceneId) return;
    void studioApi
      .editorialCues(sceneId)
      .then((items) => {
        setCues(items);
        setSelectedCueId(items[0]?.id ?? "");
        setPlayheadMs(items[0]?.speech_timing.start_ms ?? 0);
      })
      .catch((error: Error) => setMessage(error.message));
  }, [sceneId]);
  useEffect(() => {
    setApprovedEn(selectedCue?.approved_en ?? "");
    setApprovedPt(selectedCue?.approved_pt ?? "");
  }, [selectedCue?.id, selectedCue?.approved_en, selectedCue?.approved_pt]);
  useEffect(() => {
    setWordStart(selectedWord?.start_ms ?? 0);
    setWordEnd(selectedWord?.end_ms ?? 0);
  }, [selectedWord?.id, selectedWord?.start_ms, selectedWord?.end_ms]);

  async function refreshCues() {
    if (!sceneId) return;
    setCues(await studioApi.editorialCues(sceneId));
    setHistory([]);
  }
  function seek(timeMs: number) {
    const bounded = Math.max(0, Math.min(timeMs, durationMs));
    setPlayheadMs(bounded);
    if (mediaRef.current) mediaRef.current.currentTime = bounded / 1000;
  }
  function selectCue(id: string) {
    if (id !== selectedCueId && isDirty) {
      setMessage("Salve ou desfaça as alterações antes de trocar de cue.");
      return;
    }
    setSelectedCueId(id);
    setSelectedWordId(undefined);
    const cue = cues.find((item) => item.id === id);
    if (cue) seek(cue.speech_timing.start_ms);
  }
  function replaceCues(next: TimelineCue[]) {
    setHistory((value) => [...value, cues]);
    setCues(next);
  }
  function nudge(edge: "start" | "end", deltaMs: number) {
    if (!selectedCue) return;
    replaceCues(
      cues.map((cue) =>
        cue.id !== selectedCue.id
          ? cue
          : { ...cue, speech_timing: nudgeTiming(cue.speech_timing, edge, deltaMs, durationMs) },
      ),
    );
  }
  function undo() {
    const prior = history.at(-1);
    if (!prior) return;
    setCues(prior);
    setHistory((value) => value.slice(0, -1));
  }
  function togglePlayback() {
    const player = mediaRef.current;
    if (!player) return;
    if (player.paused) void player.play().catch((error: Error) => setMessage(error.message));
    else player.pause();
  }
  async function saveChanges(approve = false) {
    if (!selectedCue || saving) return;
    if (approve && (!approvedEn || !approvedPt)) {
      setMessage("Preencha os textos em inglês e português antes de aprovar o cue.");
      return;
    }
    setSaving(true);
    try {
      if (textDirty || approve)
        await studioApi.updateCueText(selectedCue.id, {
          author,
          approved_en: approvedEn,
          approved_pt: approvedPt,
        });
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
      await refreshCues();
      setMessage(approve ? `Cue ${selectedCue.order} aprovado.` : "Alterações salvas.");
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
          <h2>Aguardando transcrição</h2>
          <p>
            Quando o processamento da mídia terminar, o primeiro cue será aberto automaticamente.
          </p>
        </div>
      )}
      {selectedCue && (
        <>
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
                onTimeUpdate={(event) => setPlayheadMs(event.currentTarget.currentTime * 1000)}
              />
            ) : (
              <div className="player-unavailable" role="status">
                Prévia do corte indisponível
              </div>
            )}
          </section>
          <CueWordTimeline
            cues={cues}
            waveform={matchingMedia ? media?.waveform : null}
            durationMs={durationMs}
            playheadMs={playheadMs}
            playing={playing}
            zoom={zoom}
            selectedCueId={selectedCueId}
            selectedWordId={selectedWordId}
            onPlayToggle={togglePlayback}
            onPlayheadChange={seek}
            onZoomChange={setZoom}
            onSelectCue={selectCue}
            onSelectWord={setSelectedWordId}
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
              </div>
              <div className="language-fields">
                <label>
                  <span>Inglês aprovado</span>
                  <textarea
                    value={approvedEn}
                    onChange={(event) => setApprovedEn(event.target.value)}
                    rows={4}
                  />
                </label>
                <label>
                  <span>Português aprovado</span>
                  <textarea
                    value={approvedPt}
                    onChange={(event) => setApprovedPt(event.target.value)}
                    rows={4}
                  />
                </label>
              </div>
              <p className="hint">
                O texto é preservado literalmente, incluindo acentos, aspas e pontuação.
              </p>
              <details className="technical-details">
                <summary>Ajuste fino do cue</summary>
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
              <ol className="word-list" aria-label="Palavras do cue selecionado">
                {selectedCue.words.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={item.id === selectedWordId ? "word-row selected" : "word-row"}
                      onClick={() => setSelectedWordId(item.id)}
                      aria-pressed={item.id === selectedWordId}
                    >
                      <strong>{item.surface}</strong>
                      <span>
                        {formatTime(item.start_ms)}–{formatTime(item.end_ms)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              {selectedWord && (
                <div className="word-timing-fields">
                  <label>
                    <span>Início (ms)</span>
                    <input
                      type="number"
                      value={wordStart}
                      onChange={(event) => setWordStart(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    <span>Fim (ms)</span>
                    <input
                      type="number"
                      value={wordEnd}
                      onChange={(event) => setWordEnd(Number(event.target.value))}
                    />
                  </label>
                </div>
              )}
            </aside>
          </div>
          <footer className="review-actions" aria-label="Ações da revisão">
            <div>
              <strong>
                Cue {selectedCue.order} de {cues.length}
              </strong>
              <span>{isDirty ? "Há alterações não salvas" : cueStatus}</span>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void saveChanges()}
              disabled={!isDirty || saving}
            >
              <Save aria-hidden="true" /> Salvar alterações
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
