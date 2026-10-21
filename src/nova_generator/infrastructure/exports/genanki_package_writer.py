"""Offline Anki cards share the exact frozen pedagogical content used by iHub."""

from __future__ import annotations

import html
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from nova_generator.domain.exports import ExportCue

_DIDACTIC_CSS = """
.card {font-family: Arial, sans-serif; background:#eef4fa; color:#0b264a;
  margin:0; padding:16px; text-align:left; font-size:18px; line-height:1.5}
.ihub-card {max-width:720px; margin:0 auto; padding:22px;
  background:#fff; border:1px solid #d9e6f1; border-radius:14px}
.ihub-label {display:block; color:#9a4b00; font-size:11px;
  font-weight:800; letter-spacing:1px; text-transform:uppercase}
.ihub-sentence {font-size:clamp(21px, 4vw, 29px); font-weight:750;
  margin:14px 0 20px; overflow-wrap:anywhere}
.ihub-highlight {background:#fff0bd; color:#173d7c; font-weight:800;
  border-radius:3px; padding:0 2px}
.ihub-lesson {margin-top:20px; display:grid; gap:12px}
.ihub-section {padding:16px; background:#eef4fa; border-left:4px solid #3478df}
.ihub-section.understand {background:#f3f5f6; border-left-color:#f36b5c}
.ihub-section.example {background:#fff; border:1px solid #d5dfe6; border-radius:8px}
.ihub-section p {margin:7px 0 0; font-size:15px}
.ihub-term {display:block; font-weight:800; font-size:20px}
.ihub-meaning {font-weight:700; color:#a34e00}
.ihub-example-pt {display:block; color:#446485; font-size:14px}
.ihub-context {font-size:13px; color:#496985; padding-top:16px;
  margin-top:16px; border-top:1px solid #d5dfe6}
.ihub-audio {margin-top:14px}
"""

_DIDACTIC_FIELDS = [
    "Front", "Back", "Audio", "Focus", "Meaning", "Explanation",
    "ExampleEn", "ExamplePt", "CardType", "Tags", "ContextEn", "ContextPt",
]

_DIDACTIC_FRONT = """
<div class="ihub-card ihub-front">
  <span class="ihub-label">FRONT · ENGLISH</span>
  <div class="ihub-sentence">{{Front}}</div>
  <div class="ihub-audio">{{Audio}}</div>
</div>
"""

_DIDACTIC_BACK = """
<div class="ihub-card ihub-back">
  <span class="ihub-label">FRONT · ENGLISH</span>
  <div class="ihub-sentence">{{Front}}</div>
  <span class="ihub-label">BACK · PORTUGUÊS</span>
  <div class="ihub-sentence">{{Back}}</div>
  <div class="ihub-lesson">
    <section class="ihub-section">
      <span class="ihub-label">MINI LESSON · {{CardType}}</span>
      <span class="ihub-term">{{Focus}}</span>
      <span class="ihub-label">MEANING</span>
      <span class="ihub-meaning">{{Meaning}}</span>
    </section>
    <section class="ihub-section understand">
      <span class="ihub-label">HOW TO UNDERSTAND / USE</span>
      <p>{{Explanation}}</p>
    </section>
    <section class="ihub-section example">
      <span class="ihub-label">ANOTHER EXAMPLE</span>
      <strong>{{ExampleEn}}</strong>
      <span class="ihub-example-pt">{{ExamplePt}}</span>
    </section>
  </div>
  <div class="ihub-audio">{{Audio}}</div>
  <div class="ihub-context">
    <span class="ihub-label">CONTEXT FROM THE SCENE</span>
    {{ContextEn}}<p>{{ContextPt}}</p>
  </div>
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
                1607392320,
                "iHub Anki Didactic v2",
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

        deck = genanki.Deck(2059400110, deck_name)
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
                        guid=genanki.guid_for(
                            str(cue.cue_id), cue.text_sha256, cue.audio_sha256
                        ),
                    )
                )
                media.append(str(target))
            package = genanki.Package(deck)
            package.media_files = media
            package.write_to_file(str(output))
        return output
