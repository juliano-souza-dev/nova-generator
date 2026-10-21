import { useEffect, useState } from "react";
import type { AnkiDidacticCard } from "../../lib/api.types";
import { splitIHubHighlight } from "./ihub-card-presentation";

function Highlight({
  text,
  phrase,
}: {
  text: string;
  phrase: string;
}) {
  return (
    <>
      {splitIHubHighlight(text, phrase).map((part, index) =>
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

const FIELDS = [
  ["focus_text", "Expressão ou estrutura"],
  ["meaning", "Significado contextual"],
  ["marked_en", "Destaque na frente"],
  ["marked_pt", "Destaque no verso"],
  ["explanation_pt", "Mini-aula (PT-BR)"],
  ["example_en", "Outro exemplo (EN)"],
  ["example_pt", "Outro exemplo (PT)"],
] as const;

export function AnkiCardEditor({
  card,
  position,
  saving,
  saveError,
  revision,
  onSave,
}: {
  card: AnkiDidacticCard;
  position: number;
  saving: boolean;
  saveError?: string;
  revision: string;
  onSave: (card: AnkiDidacticCard) => void;
}) {
  const [draft, setDraft] = useState(card);
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState("");

  useEffect(() => {
    setDraft(card);
    setDirty(false);
    setValidation("");
    // A new revision is received only when the server has saved the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.card_id, revision]);

  function update<K extends keyof AnkiDidacticCard>(field: K, value: AnkiDidacticCard[K]) {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setDirty(true);
    setValidation("");
  }

  function save() {
    const front = draft.front_en.trim();
    const back = draft.back_pt.trim();
    if (!front || !back || !draft.explanation_pt.trim() || !draft.focus_text.trim()) {
      setValidation("Preencha a frente, o verso, o foco e a mini-aula.");
      return;
    }
    if (!draft.source_context_en.toLowerCase().includes(draft.focus_text.toLowerCase())) {
      setValidation("A expressão selecionada precisa existir no contexto original da cena.");
      return;
    }
    if (
      !front.toLowerCase().includes(draft.marked_en.toLowerCase()) ||
      !back.toLowerCase().includes(draft.marked_pt.toLowerCase()) ||
      !draft.marked_en.trim() ||
      !draft.marked_pt.trim()
    ) {
      setValidation("Os destaques devem aparecer literalmente na frente e no verso.");
      return;
    }
    if (
      draft.uses_literal_scene_line !==
      (front === draft.source_context_en && back === draft.source_context_pt)
    ) {
      setValidation("Marque fala literal somente quando frente e verso reproduzirem a cena.");
      return;
    }
    onSave(draft);
  }

  return (
    <article className="anki-editor" aria-label={`Editar card Anki ${position}`}>
      <header className="anki-editor-heading">
        <div>
          <small>Card {position} · {draft.card_type}</small>
          <h4>{draft.focus_text}</h4>
        </div>
        <span>{dirty ? "Alterações não salvas" : "Salvo"}</span>
      </header>
      <div className="anki-editor-main">
        <div className="anki-editor-faces" aria-label="Frente e verso no formato iHub">
          <section className="ihub-flashcard-front anki-editor-face">
            <span className="ihub-flashcard-direction">FRENTE · EN → PT</span>
            <div className="ihub-flashcard-sentence">
              <Highlight text={draft.front_en} phrase={draft.marked_en} />
            </div>
          </section>
          <section className="ihub-flashcard-answer anki-editor-face">
            <span className="ihub-flashcard-direction">VERSO · PORTUGUÊS</span>
            <div className="ihub-flashcard-sentence is-pt">
              <Highlight text={draft.back_pt} phrase={draft.marked_pt} />
            </div>
            <div className="ihub-flashcard-mini-lesson">
              <span className="ihub-flashcard-mini-lesson-title">MINI LESSON</span>
              <section className="ihub-flashcard-lesson-summary">
                <span>{draft.card_type}</span>
                <strong>{draft.focus_text}</strong>
                <small>MEANING</small>
                <b>{draft.meaning}</b>
              </section>
              <section className="ihub-flashcard-lesson-explanation">
                <span>HOW TO UNDERSTAND / USE</span>
                <p>{draft.explanation_pt}</p>
              </section>
              <section className="ihub-flashcard-lesson-example">
                <span>ANOTHER EXAMPLE</span>
                <strong>{draft.example_en}</strong>
                <small>{draft.example_pt}</small>
              </section>
            </div>
          </section>
        </div>
        <div className="anki-editor-fields">
          <div className="anki-editor-top-fields">
            <label>
              Frente editável (EN)
              <textarea
                rows={2}
                value={draft.front_en}
                onChange={(event) => update("front_en", event.target.value)}
              />
            </label>
            <label>
              Verso editável (PT)
              <textarea
                rows={2}
                value={draft.back_pt}
                onChange={(event) => update("back_pt", event.target.value)}
              />
            </label>
          </div>
          <div className="anki-editor-details">
            <label>
              Tipo
              <select
                value={draft.card_type}
                onChange={(event) => update("card_type", event.target.value)}
              >
                {Array.from(
                  new Set([
                    draft.card_type,
                    "PHRASAL_VERB",
                    "EXPRESSION",
                    "COLLOCATION",
                    "GRAMMAR",
                    "VOCABULARY",
                  ]),
                ).map((type) => (
                  <option value={type} key={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            {FIELDS.map(([field, label]) => (
              <label key={field}>
                {label}
                {field === "explanation_pt" ? (
                  <textarea
                    rows={3}
                    value={draft[field]}
                    onChange={(event) => update(field, event.target.value)}
                  />
                ) : (
                  <input
                    value={draft[field]}
                    onChange={(event) => update(field, event.target.value)}
                  />
                )}
              </label>
            ))}
            <label>
              Tags (separe com vírgulas)
              <input
                value={draft.tags.join(", ")}
                onChange={(event) =>
                  update(
                    "tags",
                    event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean),
                  )
                }
              />
            </label>
          </div>
          <label className="anki-editor-literal">
            <input
              type="checkbox"
              checked={draft.uses_literal_scene_line}
              onChange={(event) =>
                update("uses_literal_scene_line", event.target.checked)
              }
            />
            Usar excepcionalmente a fala original como card
          </label>
          <details className="anki-editor-context">
            <summary>Contexto original da cena (preservado)</summary>
            <strong>{draft.source_context_en}</strong>
            <p>{draft.source_context_pt}</p>
          </details>
          <footer className="anki-editor-actions">
            {validation && <p role="alert">{validation}</p>}
            {saveError && <p role="alert">{saveError}</p>}
            <button
              type="button"
              className="secondary-button"
              disabled={!dirty || saving}
              onClick={() => {
                setDraft(card);
                setDirty(false);
                setValidation("");
              }}
            >
              Descartar alterações
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!dirty || saving}
              onClick={save}
            >
              {saving ? "Salvando…" : "Salvar card"}
            </button>
          </footer>
        </div>
      </div>
    </article>
  );
}
