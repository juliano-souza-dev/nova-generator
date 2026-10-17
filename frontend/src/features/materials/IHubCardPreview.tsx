import { useEffect, useRef, useState } from "react";
import type { MaterialAiDocument, MaterialCard } from "../../lib/api.types";
import "./ihub-card-preview.css";

export type IHubPreviewSource = Pick<
  MaterialCard,
  "cue_id" | "approved_en" | "approved_pt" | "speaker" | "audio_url" | "highlights"
> & {
  pedagogical?: MaterialAiDocument["anki_cards"][number] | null;
};

export function splitIHubHighlight(source: string, target: string) {
  // This reproduces iHub's first, case-insensitive substring match only.
  const index = source.toLocaleLowerCase().indexOf(target.toLocaleLowerCase());
  if (!target || index < 0) return [{ text: source, marked: false }];
  return [
    { text: source.slice(0, index), marked: false },
    { text: source.slice(index, index + target.length), marked: true },
    { text: source.slice(index + target.length), marked: false },
  ].filter((part) => part.text);
}

function MarkedSentence({ sentence, target }: { sentence: string; target: string }) {
  return (
    <>
      {splitIHubHighlight(sentence, target).map((part, index) =>
        part.marked ? (
          <span className="ihub-flashcard-focus-highlight" key={index}>
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

const ratings = [
  { key: "again", icon: "↻", title: "Again", interval: "1m" },
  { key: "hard", icon: "−", title: "Hard", interval: "6m" },
  { key: "good", icon: "✓", title: "Good", interval: "10m" },
  { key: "easy", icon: "↗", title: "Easy", interval: "1d" },
] as const;

export function IHubCardPreview({
  card,
  onClose,
  onPrevious,
  onNext,
  position,
  total,
}: {
  card: IHubPreviewSource;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  position?: number;
  total?: number;
}) {
  const [face, setFace] = useState<"front" | "turning" | "revealing" | "back">("front");
  const [rating, setRating] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setFace("front");
    setRating(null);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, [card.cue_id, card.pedagogical]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [onClose]);

  const pedagogical = card.pedagogical;
  const front = card.approved_en.trim();
  const back = card.approved_pt.trim();
  const focus = pedagogical?.focus_text || card.highlights[0]?.en || front;
  const meaning = pedagogical?.meaning || card.highlights[0]?.pt || back;
  const markedEn = pedagogical?.marked_en || focus;
  const markedPt = pedagogical?.marked_pt || meaning;
  const explanation =
    pedagogical?.explanation_pt?.trim() ||
    `“${focus}” significa “${meaning}”${front !== focus ? ` na frase “${front}”` : ""}.`;

  function reveal() {
    if (face !== "front") return;
    setRating(null);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduced) {
      setFace("back");
      return;
    }
    setFace("turning");
    timerRef.current = setTimeout(() => {
      setFace("revealing");
      timerRef.current = setTimeout(() => setFace("back"), 240);
    }, 180);
  }

  function playAudio() {
    if (!card.audio_url) return;
    if (!audioRef.current) {
      audioRef.current = new Audio(card.audio_url);
    }
    // Preview uses the SAME canonical WAV that feeds the dedicated Anki reel.
    // Neither face ever plays source scene media.
    void audioRef.current.play().catch(() => undefined);
  }

  return (
    <div
      className="ihub-preview-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="ihub-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Prévia do card no iHub"
      >
        <header className="ihub-preview-toolbar">
          <div>
            <strong>Prévia fiel ao iHub</strong>
            <span>Somente visualização. As avaliações não salvam progresso.</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar prévia">
            ✕
          </button>
        </header>
        {typeof position === "number" && typeof total === "number" && (
          <div className="ihub-preview-navigation">
            <button type="button" onClick={onPrevious} disabled={!onPrevious}>
              ← Card anterior
            </button>
            <span>
              {position} / {total}
            </span>
            <button type="button" onClick={onNext} disabled={!onNext}>
              Próximo card →
            </button>
          </div>
        )}
        <article className="ihub-immersion-flashcard">
          <div
            className="ihub-flashcard-flip-stage"
            data-card-face={face === "front" || face === "turning" ? "front" : "back"}
          >
            {(face === "front" || face === "turning") && (
              <section className={`ihub-flashcard-face ${face === "turning" ? "is-flip-out" : ""}`}>
                <div className="ihub-flashcard-front">
                  {card.audio_url && (
                    <button
                      className="ihub-flashcard-audio"
                      type="button"
                      onClick={playAudio}
                      title="Listen to pronunciation"
                      aria-label="Listen to pronunciation"
                    >
                      ▶
                    </button>
                  )}
                  <span className="ihub-flashcard-direction">EN → PT</span>
                  <h2 className="ihub-flashcard-sentence">
                    <MarkedSentence sentence={front} target={markedEn} />
                  </h2>
                </div>
                <button
                  className="ihub-flashcard-reveal"
                  type="button"
                  onClick={reveal}
                  disabled={face !== "front"}
                >
                  Show answer
                </button>
              </section>
            )}
            {(face === "revealing" || face === "back") && (
              <section
                className={`ihub-flashcard-face ${face === "revealing" ? "is-flip-in" : ""}`}
              >
                <div className="ihub-flashcard-answer">
                  <div className="ihub-flashcard-answer-primary">
                    <h3 className="ihub-flashcard-sentence is-pt">
                      <MarkedSentence sentence={back} target={markedPt} />
                    </h3>
                  </div>
                  <div className="ihub-flashcard-mini-lesson" aria-label="Card mini lesson">
                    <span className="ihub-flashcard-mini-lesson-title">MINI LESSON</span>
                    <section className="ihub-flashcard-lesson-summary">
                      <span>{pedagogical?.card_type || "EXPRESSION"}</span>
                      <strong>{focus}</strong>
                      <small>MEANING</small>
                      <b>{meaning}</b>
                    </section>
                    <section className="ihub-flashcard-lesson-explanation">
                      <span>HOW TO UNDERSTAND / USE</span>
                      <p>{explanation}</p>
                    </section>
                    {(pedagogical?.example_en || pedagogical?.example_pt) && (
                      <section className="ihub-flashcard-lesson-example">
                        <span>ANOTHER EXAMPLE</span>
                        <strong>{pedagogical.example_en}</strong>
                        <small>{pedagogical.example_pt}</small>
                      </section>
                    )}
                    {card.speaker && (
                      <p className="ihub-flashcard-speaker">
                        Speaker: <span>{card.speaker}</span>
                      </p>
                    )}
                    {card.audio_url && (
                      <div className="ihub-flashcard-scene-audio">
                        <span>Card audio:</span>
                        <button type="button" onClick={playAudio} aria-label="Listen to card audio">
                          ▶
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>
          <div className="ihub-flashcard-ratings" aria-label="Review quality">
            {ratings.map((option) => (
              <button
                type="button"
                key={option.key}
                data-card-rating={option.key}
                disabled={face !== "back"}
                onClick={() => setRating(option.title)}
              >
                <span className="ihub-flashcard-rating-icon" aria-hidden="true">
                  {option.icon}
                </span>
                <strong>{option.title}</strong>
                <small>{option.interval}</small>
              </button>
            ))}
          </div>
        </article>
        {rating && (
          <p className="ihub-preview-feedback" role="status">
            Simulação: {rating}. Nenhuma avaliação foi registrada.
          </p>
        )}
        {!pedagogical && (
          <p className="ihub-preview-feedback">
            Conteúdo pedagógico ainda não importado. A mini lesson está exibindo uma explicação
            provisória, não um texto aprovado pela IA.
          </p>
        )}
        {!card.audio_url && (
          <p className="ihub-preview-feedback">
            O botão de áudio aparecerá após preparar o WAV canônico. No iHub, ele reproduz
            exclusivamente o reel Anki publicado.
          </p>
        )}
      </section>
    </div>
  );
}
