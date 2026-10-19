"""Create visually rich Anki cards using only approved editorial and pedagogical data."""

from __future__ import annotations

import re
import shutil
import tempfile
from html import escape
from pathlib import Path

from nova_generator.domain.exports import ExportCue

# New Anki note type so older three-field packages are never silently treated
# as if they had the same fields and card template.
_MODEL_ID = 1607392321
_FIELD_NAMES = (
    "English",
    "Portuguese",
    "Audio",
    "EnglishStyled",
    "PortugueseStyled",
    "CardType",
    "Focus",
    "Meaning",
    "Explanation",
    "ExampleEN",
    "ExamplePT",
)

_QUESTION = """
<div class="ih-card">
  <div class="ih-accent"></div>
  <div class="ih-en">{{EnglishStyled}}</div>
  {{#Audio}}<div class="ih-audio">{{Audio}}</div>{{/Audio}}
</div>
"""

_ANSWER = """
{{FrontSide}}
<div class="ih-card ih-answer">
  <div class="ih-divider"></div>
  <div class="ih-pt">{{PortugueseStyled}}</div>
  {{#Explanation}}
    <div class="ih-section-title">MINI AULA</div>
    {{#Focus}}
    <div class="ih-panel ih-structure">
      <div class="ih-panel-label">{{CardType}}</div>
      <div class="ih-focus">{{Focus}}</div>
      {{#Meaning}}
      <div class="ih-meaning-label">SIGNIFICADO</div>
      <div class="ih-meaning">{{Meaning}}</div>
      {{/Meaning}}
    </div>
    {{/Focus}}
    <div class="ih-panel ih-explanation">
      <div class="ih-panel-label">COMO ENTENDER / USAR</div>
      <div class="ih-explanation-text">{{Explanation}}</div>
    </div>
    {{#ExampleEN}}
    <div class="ih-panel ih-example">
      <div class="ih-panel-label">OUTRO EXEMPLO</div>
      <div class="ih-example-en">{{ExampleEN}}</div>
      {{#ExamplePT}}<div class="ih-example-pt">{{ExamplePT}}</div>{{/ExamplePT}}
    </div>
    {{/ExampleEN}}
  {{/Explanation}}
</div>
"""

_STYLE = """
.card {
  font-family: Arial, "Segoe UI", sans-serif;
  text-align: left;
  background: #faf8f2;
  color: #102a47;
  font-size: 17px;
  line-height: 1.45;
  margin: 0;
  padding: 26px 28px 34px;
}
.ih-card { max-width: 790px; margin: 0 auto; }
.ih-accent { width: 80px; height: 5px; border-radius: 3px; background: #d4f7e7;
             margin-bottom: 23px; }
.ih-en { font-size: clamp(23px, 5vw, 31px); font-weight: 800;
         line-height: 1.35; letter-spacing: -0.025em; color: #081f3d;
         overflow-wrap: anywhere; white-space: pre-wrap; }
.ih-pt { font-size: clamp(21px, 4.8vw, 29px); font-weight: 800;
         line-height: 1.38; letter-spacing: -0.02em; color: #087438;
         overflow-wrap: anywhere; white-space: pre-wrap; margin-bottom: 22px; }
.ih-mark { background: #ffdb78; color: #774000; border-radius: 5px;
           padding: 0.03em 0.12em; box-decoration-break: clone;
           -webkit-box-decoration-break: clone; }
.ih-audio { margin-top: 15px; min-height: 40px; }
.ih-audio .replay-button { vertical-align: middle; }
.ih-divider { border-top: 1px solid #abb4b3; margin: 26px 0 23px; }
.ih-section-title { font-size: 12px; letter-spacing: 0.17em; font-weight: 800;
                    color: #2c5b7e; margin: 19px 0 11px; }
.ih-panel { box-sizing: border-box; border-left: 5px solid #2b7bd6;
            padding: 17px 18px; margin: 0 0 12px;
            background: #e7f2fc; overflow-wrap: anywhere; }
.ih-panel-label { font-size: 11px; letter-spacing: 0.075em; font-weight: 800;
                  color: #1e4979; margin-bottom: 7px; text-transform: uppercase; }
.ih-focus { font-size: 22px; font-weight: 800; color: #122f58; margin: 3px 0 8px;
            white-space: pre-wrap; }
.ih-meaning-label { font-size: 11px; letter-spacing: 0.06em; font-weight: 800;
                    color: #ab4a08; margin: 10px 0 4px; }
.ih-meaning { font-size: 18px; line-height: 1.42; font-weight: 700;
              color: #994313; white-space: pre-wrap; }
.ih-explanation { background: #eef1f4; border-color: #e77165; }
.ih-explanation .ih-panel-label { color: #142f50; }
.ih-explanation-text { font-size: 17px; font-weight: 400; color: #192c43;
                       line-height: 1.5; white-space: pre-wrap; }
.ih-example { background: #eef8ee; border-color: #3b9b66; }
.ih-example-en { font-size: 17px; font-weight: 700; color: #173e39;
                 white-space: pre-wrap; }
.ih-example-pt { font-size: 16px; color: #22634b; white-space: pre-wrap;
                 margin-top: 6px; }
.nightMode.card, .nightMode .card { background: #152230; color: #e7edf6; }
.nightMode .ih-en { color: #f1f6fc; }
.nightMode .ih-pt { color: #78dea5; }
.nightMode .ih-divider { border-color: #536171; }
.nightMode .ih-panel { background: #223a52; }
.nightMode .ih-panel-label { color: #a3d5ff; }
.nightMode .ih-focus { color: #f1f6fc; }
.nightMode .ih-meaning { color: #ffd18e; }
.nightMode .ih-explanation { background: #303b4b; }
.nightMode .ih-explanation-text { color: #f0f2f6; }
.nightMode .ih-example { background: #1b4337; }
.nightMode .ih-example-en { color: #d3fae2; }
.nightMode .ih-example-pt { color: #b5dfc8; }
@media (max-width: 480px) {
  .card { padding: 18px 15px 26px; }
  .ih-panel { padding: 14px 13px; }
  .ih-focus { font-size: 20px; }
  .ih-meaning { font-size: 17px; }
}
"""


def _highlight_literal(text: str, marked: str) -> str:
    """Highlight a literal editorial phrase; never treat AI content as HTML."""
    if not marked.strip():
        return escape(text)
    match = re.search(re.escape(marked.strip()), text, flags=re.IGNORECASE)
    if match is None:
        return escape(text)
    return (
        escape(text[: match.start()])
        + '<span class="ih-mark">'
        + escape(text[match.start() : match.end()])
        + "</span>"
        + escape(text[match.end() :])
    )


def _note_fields(cue: ExportCue, rich: dict | None, audio: str) -> list[str]:
    if rich is not None:
        # No pedagogical rewrite: rich fields must describe this approved cue.
        if (
            rich.get("front_en", cue.approved_en) != cue.approved_en
            or rich.get("back_pt", cue.approved_pt) != cue.approved_pt
        ):
            raise ValueError(f"Anki card {cue.order} does not match approved editorial text.")

    card = rich or {}
    focus = str(card.get("focus_text") or "")
    explanation = str(card.get("explanation_pt") or "")
    return [
        escape(cue.approved_en),
        escape(cue.approved_pt),
        audio,
        _highlight_literal(cue.approved_en, str(card.get("marked_en") or "")),
        _highlight_literal(cue.approved_pt, str(card.get("marked_pt") or "")),
        escape(str(card.get("card_type") or ("FOCO" if focus else ""))),
        escape(focus),
        escape(str(card.get("meaning") or "")),
        escape(explanation),
        escape(str(card.get("example_en") or "")),
        escape(str(card.get("example_pt") or "")),
    ]


class GenankiPackageWriter:
    """Export contextual Anki cards while preserving canonical WAV audio."""

    def write(
        self,
        *,
        cues: list[ExportCue],
        output: Path,
        deck_name: str,
        include_audio: bool = True,
        rich_cards: dict[str, dict] | None = None,
    ) -> Path:
        try:
            import genanki
        except ImportError as exc:  # pragma: no cover - optional in constrained installs
            raise RuntimeError("Genanki é necessário para exportar o pacote Anki.") from exc

        output.parent.mkdir(parents=True, exist_ok=True)
        model = genanki.Model(
            _MODEL_ID,
            "Nova Generator - Aula Contextual v2",
            fields=[{"name": name} for name in _FIELD_NAMES],
            templates=[{"name": "Aula e revisão", "qfmt": _QUESTION, "afmt": _ANSWER}],
            css=_STYLE,
        )
        deck = genanki.Deck(2059400110, deck_name)
        with tempfile.TemporaryDirectory(prefix="nova_generator_anki_") as temporary:
            media: list[str] = []
            for cue in cues:
                filename = f"cue_{cue.order:04d}.wav"
                target = Path(temporary) / filename
                rich = None if rich_cards is None else rich_cards.get(str(cue.cue_id))
                if rich_cards is not None and not isinstance(rich, dict):
                    raise ValueError(f"Anki card {cue.order} is missing approved mini lesson.")
                deck.add_note(
                    genanki.Note(
                        model=model,
                        fields=_note_fields(
                            cue,
                            rich,
                            f"[sound:{filename}]" if include_audio else "",
                        ),
                        guid=genanki.guid_for(
                            str(cue.cue_id), cue.text_sha256, cue.audio_sha256
                        ),
                    )
                )
                if include_audio:
                    shutil.copyfile(cue.audio_path, target)
                    media.append(str(target))
            package = genanki.Package(deck)
            package.media_files = media
            package.write_to_file(str(output))
        return output
