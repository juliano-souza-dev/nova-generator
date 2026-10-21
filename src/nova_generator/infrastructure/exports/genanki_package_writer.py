"""Offline Anki cards share the exact frozen pedagogical content used by iHub."""

from __future__ import annotations

import html
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from nova_generator.domain.exports import DIDACTIC_LAYOUT, ExportCue

# A new Anki model ID is essential. Anki keeps the template of previously
# imported model IDs, even if a future APKG includes changed HTML/CSS.
DIDACTIC_MODEL_ID = 1607392323
DIDACTIC_MODEL_NAME = "iHub English · Didactic v3"
DIDACTIC_DECK_ID = 2059400111

_DIDACTIC_CSS = """
/* Offline iHub card. No remote fonts, scripts, or network resources. */
.card {
  font-family: Arial, Helvetica, sans-serif !important;
  font-size: 19px;
  color: #09264b;
  background: #fff9f2;
  text-align: left;
  margin: 0;
  padding: 12px 16px 36px;
  line-height: 1.44;
}
#qa, #qa > div { max-width: 100%; }
.ihub-card {
  width: 100%;
  max-width: 680px;
  box-sizing: border-box;
  margin: 10px auto;
  background: #fffaf2;
  border: 1px solid #eddfc9;
  border-radius: 15px;
  padding: 24px 24px 28px;
  color: #082b54;
  text-align: left;
}
.ihub-pill {
  display: inline-block;
  padding: 7px 11px;
  background: #dff7ec;
  color: #087448;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 850;
  letter-spacing: .025em;
}
.ihub-label {
  display: block;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1.05px;
  font-weight: 850;
  color: #305d7a;
  margin: 0 0 7px;
}
.ihub-sentence {
  margin: 17px 0;
  color: #072346;
  font-size: 28px;
  line-height: 1.35;
  font-weight: 800;
  overflow-wrap: anywhere;
}
.ihub-sentence.ihub-pt {
  color: #087b50;
  font-size: 27px;
}
.ihub-highlight {
  background: #ffcf65;
  color: #754000 !important;
  border-radius: 5px;
  padding: 1px 5px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  font-weight: 900;
}
.ihub-audio { margin: 20px 0 8px; }
.ihub-audio .replay-button, .ihub-audio .soundLink {
  color: #1179ad !important;
}
.ihub-front-hint {
  color: #52718a;
  font-size: 13px;
  margin-top: 17px;
}
.ihub-divider {
  height: 1px;
  border: 0;
  margin: 24px 0;
  background: #bfc3c3;
}
.ihub-lesson-title {
  display: block;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 1.4px;
  color: #315976;
  text-transform: uppercase;
  margin: 24px 0 8px;
}
.ihub-lesson { display: block; }
.ihub-section {
  padding: 16px 18px;
  margin-top: 12px;
  border-left: 4px solid #348ce2;
  background: #e9f4ff;
  box-sizing: border-box;
  overflow-wrap: anywhere;
}
.ihub-section.ihub-understand {
  background: #f1f4f5;
  border-left-color: #f16a62;
}
.ihub-section.ihub-example {
  border: 1px solid #d6e0e4;
  border-radius: 8px;
  background: #ffffff;
  margin-top: 12px;
  padding: 15px;
}
.ihub-term {
  display: block;
  color: #002e65;
  font-size: 23px;
  line-height: 1.35;
  font-weight: 850;
  margin: 3px 0 10px;
}
.ihub-meaning {
  display: block;
  font-weight: 800;
  font-size: 18px;
  color: #995000;
}
.ihub-explanation {
  font-size: 16px;
  color: #1c344c;
  line-height: 1.55;
  margin: 7px 0 0;
}
.ihub-example-en {
  display: block;
  font-size: 16px;
  font-weight: 750;
  color: #143257;
}
.ihub-example-pt {
  display: block;
  font-size: 14px;
  color: #486f90;
  margin-top: 6px;
}
.ihub-context {
  color: #58718a;
  margin-top: 20px;
  padding-top: 13px;
  border-top: 1px solid #e2e6ea;
  font-size: 12px;
  line-height: 1.4;
}
.ihub-context p { margin: 4px 0; }
.ihub-tags { color: #6c7891; font-size: 11px; margin-top: 13px; }
@media (max-width: 480px) {
  .card { padding: 0 3px 24px; font-size: 16px; }
  .ihub-card { padding: 16px 14px 22px; border-radius: 9px; }
  .ihub-sentence { font-size: 23px; }
  .ihub-sentence.ihub-pt { font-size: 23px; }
  .ihub-term { font-size: 21px; }
  .ihub-section { padding: 13px; }
}
.nightMode .card, .nightMode.card { background: #fff9f2 !important; color: #09264b !important; }
"""

_DIDACTIC_FIELDS = [
    "Front", "Back", "Audio", "Focus", "Meaning", "Explanation",
    "ExampleEn", "ExamplePt", "CardType", "Tags", "ContextEn", "ContextPt",
]

_DIDACTIC_FRONT = """
<div class="ihub-card ihub-front">
  <span class="ihub-pill">EN → PT</span>
  <div class="ihub-sentence">{{Front}}</div>
  <div class="ihub-audio">{{Audio}}</div>
  <div class="ihub-front-hint">Ouça a frase. Lembre-se do significado e revele a mini-aula.</div>
</div>
"""

_DIDACTIC_BACK = """
<div class="ihub-card ihub-back">
  <span class="ihub-pill">EN → PT</span>
  <div class="ihub-sentence">{{Front}}</div>
  <hr class="ihub-divider">
  <div class="ihub-sentence ihub-pt">{{Back}}</div>
  <span class="ihub-lesson-title">MINI AULA</span>
  <div class="ihub-lesson">
    <section class="ihub-section ihub-structure">
      <span class="ihub-label">{{CardType}}</span>
      <span class="ihub-term">{{Focus}}</span>
      <span class="ihub-label">SIGNIFICADO</span>
      <span class="ihub-meaning">{{Meaning}}</span>
    </section>
    <section class="ihub-section ihub-understand">
      <span class="ihub-label">COMO ENTENDER / USAR</span>
      <p class="ihub-explanation">{{Explanation}}</p>
    </section>
    <section class="ihub-section ihub-example">
      <span class="ihub-label">OUTRO EXEMPLO</span>
      <span class="ihub-example-en">{{ExampleEn}}</span>
      <span class="ihub-example-pt">{{ExamplePt}}</span>
    </section>
  </div>
  <div class="ihub-audio">{{Audio}}</div>
  {{#ContextEn}}
  <div class="ihub-context">
    <span class="ihub-label">CONTEXTO DA CENA</span>
    <p>{{ContextEn}}</p><p>{{ContextPt}}</p>
  </div>
  {{/ContextEn}}
  {{#Tags}}<div class="ihub-tags">{{Tags}}</div>{{/Tags}}
</div>
"""


def _highlight(text: str, mark: str) -> str:
    """Safely mark the same literal substring that the iHub card highlights."""
    match = re.search(re.escape(mark), text, re.IGNORECASE) if mark else None
    if not match:
        return html.escape(text)
    return (
        html.escape(text[:match.start()])
        + '<span class="ihub-highlight">'
        + html.escape(text[match.start():match.end()])
        + "</span>"
        + html.escape(text[match.end():])
    )


def _lesson_fields(cue: ExportCue, audio: str) -> list[str]:
    lesson: dict[str, Any] = cue.lesson or {}
    if lesson.get("front_en") != cue.approved_en or lesson.get("back_pt") != cue.approved_pt:
        raise ValueError("Anki didático diverge da frase do card exportado")
    required = (
        "focus_text", "meaning", "explanation_pt", "example_en", "example_pt",
        "card_type", "source_context_en", "source_context_pt", "marked_en", "marked_pt",
    )
    if any(not isinstance(lesson.get(field), str) or not lesson[field] for field in required):
        raise ValueError("O card Anki didático está sem campos da mini-aula do iHub")
    return [
        _highlight(cue.approved_en, lesson["marked_en"]),
        _highlight(cue.approved_pt, lesson["marked_pt"]),
        audio,
        html.escape(lesson["focus_text"]),
        html.escape(lesson["meaning"]),
        html.escape(lesson["explanation_pt"]).replace("\n", "<br>"),
        html.escape(lesson["example_en"]),
        html.escape(lesson["example_pt"]),
        html.escape(lesson["card_type"]),
        html.escape(", ".join(lesson.get("tags", []))),
        html.escape(lesson["source_context_en"]),
        html.escape(lesson["source_context_pt"]),
    ]


class GenankiPackageWriter:
    """Package dedicated WAVs and the same pedagogical faces published in iHub."""

    def write(self, *, cues: list[ExportCue], output: Path, deck_name: str) -> Path:
        try:
            import genanki
        except ImportError as exc:  # pragma: no cover - optional production dependency
            raise RuntimeError("Genanki é necessário para exportar o pacote Anki.") from exc
        output.parent.mkdir(parents=True, exist_ok=True)
        didactic = any(cue.lesson is not None for cue in cues)
        if didactic and not all(cue.lesson is not None for cue in cues):
            raise ValueError("Não misture cards didáticos com cards legados no mesmo APKG")
        if didactic:
            model = genanki.Model(
                DIDACTIC_MODEL_ID,
                DIDACTIC_MODEL_NAME,
                fields=[{"name": field} for field in _DIDACTIC_FIELDS],
                templates=[{
                    "name": "iHub Front and Back",
                    "qfmt": _DIDACTIC_FRONT,
                    "afmt": _DIDACTIC_BACK,
                }],
                css=_DIDACTIC_CSS,
            )
        else:
            model = genanki.Model(
                1607392319,
                "Nova Generator Cue",
                fields=[{"name": "English"}, {"name": "Portuguese"}, {"name": "Audio"}],
                templates=[{
                    "name": "Cue",
                    "qfmt": "{{English}}<br>{{Audio}}",
                    "afmt": "{{FrontSide}}<hr id=answer>{{Portuguese}}",
                }],
            )

        deck = (
            genanki.Deck(DIDACTIC_DECK_ID, f"iHub English::{deck_name}")
            if didactic else genanki.Deck(2059400110, deck_name)
        )
        with tempfile.TemporaryDirectory(prefix="nova_generator_anki_") as temporary:
            media: list[str] = []
            for cue in cues:
                filename = (
                    f"anki_{cue.cue_id}.wav" if didactic else f"cue_{cue.order:04d}.wav"
                )
                target = Path(temporary) / filename
                shutil.copyfile(cue.audio_path, target)
                sound = f"[sound:{filename}]"
                fields = (
                    _lesson_fields(cue, sound)
                    if didactic
                    else [html.escape(cue.approved_en), html.escape(cue.approved_pt), sound]
                )
                deck.add_note(
                    genanki.Note(
                        model=model,
                        fields=fields,
                        guid=(
                            genanki.guid_for(DIDACTIC_MODEL_NAME, str(cue.cue_id))
                            if didactic else genanki.guid_for(
                                str(cue.cue_id), cue.text_sha256, cue.audio_sha256
                            )
                        ),
                    )
                )
                media.append(str(target))
            package = genanki.Package(deck)
            package.media_files = media
            package.write_to_file(str(output))
        return output
