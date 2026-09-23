import { Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Project, ProjectMedia, Scene, WordTiming } from "../../lib/api.types";
import { PageHeader } from "../../components/PageHeader";
import { studioApi } from "../../lib/studio-api";
import { CueWordTimeline, type TimelineCue } from "./CueWordTimeline";
import { nudgeTiming } from "./timeline";
import "./timeline.css";

const cueId = "00000000-0000-0000-0000-000000000001";
const word = (
  id: string,
  order: number,
  surface: string,
  start_ms: number,
  end_ms: number,
): WordTiming => ({ id, order, surface, start_ms, end_ms });
const sampleCues: TimelineCue[] = [
  {
    id: cueId,
    scene_id: "scene-demo",
    order: 1,
    speaker: "Narrador",
    original_en: "I'm ready, aren't you?",
    approved_en: "I'm ready, aren't you?",
    approved_pt: "Estou pronto, não está?",
    speech_timing: { start_ms: 1200, end_ms: 3500 },
    subtitle_timing: { start_ms: 1150, end_ms: 3550 },
    revision: 1,
    words: [
      word("word-1", 1, "I'm", 1200, 1660),
      word("word-2", 2, "ready,", 1700, 2260),
      word("word-3", 3, "aren't", 2450, 2920),
      word("word-4", 4, "you?", 2980, 3500),
    ],
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    scene_id: "scene-demo",
    order: 2,
    speaker: "Narrador",
    original_en: "Let's begin.",
    approved_en: "Let's begin.",
    approved_pt: "Vamos começar.",
    speech_timing: { start_ms: 3900, end_ms: 5100 },
    subtitle_timing: { start_ms: 3850, end_ms: 5150 },
    revision: 1,
    words: [word("word-5", 1, "Let's", 3900, 4450), word("word-6", 2, "begin.", 4510, 5100)],
  },
];

export function EditorialPage() {
  const [params] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [media, setMedia] = useState<ProjectMedia | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [projectId, setProjectId] = useState(params.get("project") ?? "");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sceneId, setSceneId] = useState("");
  const author = "local-editor";
  const [message, setMessage] = useState("");
  const [cues, setCues] = useState(sampleCues);
  const [history, setHistory] = useState<TimelineCue[][]>([]);
  const [selectedCueId, setSelectedCueId] = useState(cueId);
  const [selectedWordId, setSelectedWordId] = useState<string>();
  const [playheadMs, setPlayheadMs] = useState(1200);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(2);
  const [approvedEn, setApprovedEn] = useState("");
  const [approvedPt, setApprovedPt] = useState("");
  const [wordStart, setWordStart] = useState(0);
  const [wordEnd, setWordEnd] = useState(0);
  const live = Boolean(projectId);
  const selectedScene = scenes.find((item) => item.id === sceneId);
  const durationMs = selectedScene?.duration_ms ?? 6000;
  const matchingMedia = Boolean(
    media?.ingest_job_id && media.ingest_job_id === selectedScene?.provenance.ingest_job_id,
  );
  const selectedCue = useMemo(
    () => cues.find((cue) => cue.id === selectedCueId) ?? cues[0],
    [cues, selectedCueId],
  );
  const selectedWord = selectedCue?.words.find((item) => item.id === selectedWordId);
  useEffect(() => {
    void studioApi
      .projects()
      .then(setProjects)
      .catch((error: Error) => setMessage(error.message));
  }, []);
  useEffect(() => {
    if (!projectId) {
      setScenes([]);
      setSceneId("");
      setCues(sampleCues);
      setMedia(null);
      return;
    }
    setCues([]);
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
    if (!sceneId) return;
    void studioApi
      .editorialCues(sceneId)
      .then((items) => {
        setCues(items);
        setSelectedCueId(items[0]?.id ?? "");
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
  async function refreshCues(id = sceneId) {
    setCues(await studioApi.editorialCues(id));
    setHistory([]);
  }
  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar revisão.");
    }
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
    if (prior) {
      setCues(prior);
      setHistory((value) => value.slice(0, -1));
    }
  }
  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) {
      setPlaying((value) => !value);
    } else if (audio.paused) {
      void audio.play().catch((error: Error) => setMessage(error.message));
    } else {
      audio.pause();
    }
  }
  function seek(timeMs: number) {
    setPlayheadMs(timeMs);
    if (audioRef.current) audioRef.current.currentTime = timeMs / 1000;
  }
  async function saveText() {
    if (!live || !selectedCue) return;
    await run(async () => {
      await studioApi.updateCueText(selectedCue.id, {
        author,
        approved_en: approvedEn,
        approved_pt: approvedPt,
      });
      await refreshCues();
    }, "Texto EN/PT aprovado sem alterar Unicode ou pontuação.");
  }
  async function saveTiming() {
    if (!live || !selectedCue) return;
    await run(async () => {
      await studioApi.updateCueTiming(selectedCue.id, {
        author,
        speech_timing: selectedCue.speech_timing,
        subtitle_timing: selectedCue.subtitle_timing,
      });
      await refreshCues();
    }, "Timing do cue salvo.");
  }
  async function saveWordTiming() {
    if (!live || !selectedCue || !selectedWord) return;
    await run(async () => {
      await studioApi.updateWordTiming(selectedCue.id, {
        author,
        timings: selectedCue.words.map((item) => ({
          id: item.id,
          start_ms: item.id === selectedWord.id ? wordStart : item.start_ms,
          end_ms: item.id === selectedWord.id ? wordEnd : item.end_ms,
        })),
      });
      await refreshCues();
    }, "Timing da palavra salvo sem alterar texto.");
  }
  return (
    <section>
      <PageHeader
        title="Revisão editorial"
        description="Revise o candidato ASR, aprove EN/PT literalmente e ajuste os tempos separadamente."
      />
      <div className="panel editorial-source">
        <label>
          Projeto
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Demonstração da timeline</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        {live && (
          <>
            <label>
              Cena
              <select value={sceneId} onChange={(event) => setSceneId(event.target.value)}>
                {scenes.map((item) => (
                  <option key={item.id} value={item.id}>
                    Cena {item.order}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      {message && <p role="status">{message}</p>}
      {live && !selectedCue && <p>Preparando a transcrição para revisão…</p>}
      {selectedCue && (
        <>
          {matchingMedia && media?.cut_url && (
            <audio
              ref={audioRef}
              src={media.cut_url}
              controls
              aria-label="Áudio do corte da cena"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(event) => setPlayheadMs(event.currentTarget.currentTime * 1000)}
            />
          )}
          <CueWordTimeline
            cues={cues}
            waveform={live ? (matchingMedia ? media?.waveform : null) : undefined}
            durationMs={durationMs}
            playheadMs={playheadMs}
            playing={playing}
            zoom={zoom}
            selectedCueId={selectedCueId}
            selectedWordId={selectedWordId}
            onPlayToggle={togglePlayback}
            onPlayheadChange={seek}
            onZoomChange={setZoom}
            onSelectCue={(id) => {
              setSelectedCueId(id);
              setSelectedWordId(undefined);
            }}
            onSelectWord={setSelectedWordId}
            onNudge={nudge}
            onUndo={undo}
          />
          <div className="editorial-grid">
            <article className="panel">
              <h2>Cue {selectedCue.order}</h2>
              <p className="timing-readout">
                {selectedCue.speech_timing.start_ms}–{selectedCue.speech_timing.end_ms} ms
              </p>
              {selectedCue.provenance?.approval === "draft" && (
                <p>Rascunho ASR aguardando aprovação.</p>
              )}
              <p>ASR original: {selectedCue.original_en}</p>
              <label>
                Inglês aprovado
                <textarea
                  value={approvedEn}
                  onChange={(event) => setApprovedEn(event.target.value)}
                  rows={3}
                />
              </label>
              <label>
                Português aprovado
                <textarea
                  value={approvedPt}
                  onChange={(event) => setApprovedPt(event.target.value)}
                  rows={3}
                />
              </label>
              <p className="hint">A edição de texto é salva separadamente da edição de timing.</p>
              <button
                type="button"
                className="primary-button"
                onClick={() => void saveText()}
                disabled={!live}
              >
                <Save /> Aprovar texto
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void saveTiming()}
                disabled={!live}
              >
                Salvar timing do cue
              </button>
            </article>
            <article className="panel">
              <h2>Tempos das palavras</h2>
              <p className="hint">
                Selecione um bloco na timeline para inspecionar. Os atalhos movem somente limites de
                tempo.
              </p>
              <ol className="word-list">
                {selectedCue.words.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={item.id === selectedWordId ? "word-row selected" : "word-row"}
                      onClick={() => setSelectedWordId(item.id)}
                    >
                      <strong>{item.surface}</strong>
                      <span>
                        {item.start_ms}–{item.end_ms} ms
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              {selectedWord && (
                <>
                  <label>
                    Início (ms)
                    <input
                      type="number"
                      value={wordStart}
                      onChange={(event) => setWordStart(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    Fim (ms)
                    <input
                      type="number"
                      value={wordEnd}
                      onChange={(event) => setWordEnd(Number(event.target.value))}
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void saveWordTiming()}
                    disabled={!live}
                  >
                    Salvar timing da palavra
                  </button>
                </>
              )}
            </article>
          </div>
        </>
      )}
    </section>
  );
}
