import { Save } from "lucide-react";
import { useMemo, useState } from "react";
import type { WordTiming } from "../../lib/api.types";
import { PageHeader } from "../../components/PageHeader";
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
  const [cues, setCues] = useState(sampleCues);
  const [history, setHistory] = useState<TimelineCue[][]>([]);
  const [selectedCueId, setSelectedCueId] = useState(cueId);
  const [selectedWordId, setSelectedWordId] = useState<string>();
  const [playheadMs, setPlayheadMs] = useState(1200);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(2);
  const selectedCue = useMemo(
    () => cues.find((cue) => cue.id === selectedCueId) ?? cues[0],
    [cues, selectedCueId],
  );
  function replaceCues(next: TimelineCue[]) {
    setHistory((value) => [...value, cues]);
    setCues(next);
  }
  function nudge(edge: "start" | "end", deltaMs: number) {
    replaceCues(
      cues.map((cue) =>
        cue.id !== selectedCue.id
          ? cue
          : { ...cue, speech_timing: nudgeTiming(cue.speech_timing, edge, deltaMs, 6000) },
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
  return (
    <section>
      <PageHeader
        title="Revisão editorial"
        description="Texto e timing têm fluxos separados: a timeline ajusta tempos sem normalizar acentos, espaços ou pontuação."
      />
      <CueWordTimeline
        cues={cues}
        durationMs={6000}
        playheadMs={playheadMs}
        playing={playing}
        zoom={zoom}
        selectedCueId={selectedCueId}
        selectedWordId={selectedWordId}
        onPlayToggle={() => setPlaying((value) => !value)}
        onPlayheadChange={setPlayheadMs}
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
          <label>
            Inglês aprovado
            <textarea value={selectedCue.approved_en} readOnly rows={3} />
          </label>
          <label>
            Português aprovado
            <textarea value={selectedCue.approved_pt} readOnly rows={3} />
          </label>
          <p className="hint">A edição de texto é salva separadamente da edição de timing.</p>
          <button type="button" className="primary-button">
            <Save /> Salvar texto
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
        </article>
      </div>
    </section>
  );
}
