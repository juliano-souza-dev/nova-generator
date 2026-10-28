import { Music2, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";

import {
  buildMusicLesson,
  MUSIC_LESSON_EXAMPLE,
  musicLessonAiPrompt,
  musicLessonDuration,
  type MusicLessonInput,
} from "./music-lesson";
import type { MediaSlide } from "./tiktok-api";

type Props = {
  disabled: boolean;
  onDraft: (slides: MediaSlide[]) => void;
  onAiPrompt: (prompt: string) => void;
};

const lessonFields: Array<{
  key: keyof MusicLessonInput;
  label: string;
  multiline?: boolean;
  maxLength: number;
}> = [
  { key: "expression", label: "Expressão em inglês", maxLength: 120 },
  { key: "translation", label: "Tradução natural", maxLength: 300 },
  { key: "explanation", label: "Explicação didática", multiline: true, maxLength: 800 },
  { key: "pattern", label: "Estrutura de inglês", maxLength: 120 },
  { key: "patternExplanation", label: "Como usar a estrutura", multiline: true, maxLength: 800 },
  { key: "everydayEn", label: "Exemplo cotidiano (EN)", maxLength: 600 },
  { key: "everydayPt", label: "Exemplo cotidiano (PT)", maxLength: 800 },
  { key: "workEn", label: "Exemplo no trabalho (EN)", maxLength: 600 },
  { key: "workPt", label: "Exemplo no trabalho (PT)", maxLength: 800 },
  { key: "challengePt", label: "Desafio para o público (PT)", multiline: true, maxLength: 800 },
  { key: "challengeAnswerEn", label: "Resposta do desafio (EN)", maxLength: 600 },
];

export function MusicLessonComposer({ disabled, onDraft, onAiPrompt }: Props) {
  const [input, setInput] = useState<MusicLessonInput>({ ...MUSIC_LESSON_EXAMPLE });
  const [error, setError] = useState("");
  const duration = musicLessonDuration(input);

  function change(field: keyof MusicLessonInput, value: string) {
    setInput((current) => ({ ...current, [field]: value }));
    setError("");
  }

  function create(action: "draft" | "ai") {
    try {
      if (action === "draft") onDraft(buildMusicLesson(input));
      else onAiPrompt(musicLessonAiPrompt(input));
      setError("");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível montar o roteiro.");
    }
  }

  return (
    <div className="tm-card tm-music-composer">
      <h2>
        <Music2 size={18} /> Inglês na Vida Real · Música
      </h2>
      <p className="tm-small">
        Transforme um trecho de 30–60 segundos em uma mini-aula de 7 quadros. O exemplo está
        preenchido com “Count on Me”; adapte o conteúdo para outras músicas.
      </p>
      <div className="tm-music-grid">
        <label className="tm-field">
          <span>Música</span>
          <input
            aria-label="Música da mini-aula"
            value={input.song}
            maxLength={100}
            onChange={(event) => change("song", event.target.value)}
          />
        </label>
        <label className="tm-field">
          <span>Artista</span>
          <input
            aria-label="Artista da mini-aula"
            value={input.artist}
            maxLength={100}
            onChange={(event) => change("artist", event.target.value)}
          />
        </label>
      </div>
      <div className="tm-music-grid tm-music-times">
        <label className="tm-field">
          <span>Início (mm:ss)</span>
          <input
            aria-label="Início do trecho musical"
            value={input.start}
            placeholder="00:15"
            inputMode="numeric"
            onChange={(event) => change("start", event.target.value)}
          />
        </label>
        <label className="tm-field">
          <span>Fim (mm:ss)</span>
          <input
            aria-label="Fim do trecho musical"
            value={input.end}
            placeholder="01:10"
            inputMode="numeric"
            onChange={(event) => change("end", event.target.value)}
          />
        </label>
      </div>
      <p className="tm-music-duration" role="status">
        Roteiro: {duration === null ? "trecho inválido" : `${duration} segundos`} · 7 quadros
      </p>
      <details>
        <summary>Expressão, explicações, exemplos e desafio</summary>
        <p className="tm-small">
          Estes campos são conteúdo editorial revisável, não uma transcrição automática da música.
        </p>
        <div className="tm-music-fields">
          {lessonFields.map((field) => (
            <label className="tm-field" key={field.key}>
              <span>{field.label}</span>
              {field.multiline ? (
                <textarea
                  aria-label={field.label}
                  rows={3}
                  maxLength={field.maxLength}
                  value={input[field.key]}
                  onChange={(event) => change(field.key, event.target.value)}
                />
              ) : (
                <input
                  aria-label={field.label}
                  maxLength={field.maxLength}
                  value={input[field.key]}
                  onChange={(event) => change(field.key, event.target.value)}
                />
              )}
            </label>
          ))}
        </div>
      </details>
      <button className="tm-accent" onClick={() => create("draft")} disabled={disabled}>
        <Sparkles size={16} /> Montar mini-aula
      </button>
      <button onClick={() => create("ai")} disabled={disabled}>
        <Sparkles size={16} /> Preparar versão com IA
      </button>
      <button
        className="tm-music-reset"
        onClick={() => {
          setInput({ ...MUSIC_LESSON_EXAMPLE });
          setError("");
        }}
      >
        <RotateCcw size={15} /> Restaurar exemplo
      </button>
      {disabled && (
        <p className="tm-small" role="status">
          Esta produção usa vídeo original. Crie uma produção “Vídeo educativo” para montar quadros
          didáticos sem substituir o vídeo vinculado.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <p className="tm-small">
        O intervalo é uma referência para o recorte na área Mídia; não importa áudio sozinho. Use
        somente música licenciada/autorizada na exportação e revise tudo antes de publicar.
      </p>
    </div>
  );
}
