from __future__ import annotations

import shutil
from html import escape
import tempfile
from pathlib import Path

from nova_generator.domain.exports import ExportCue


class GenankiPackageWriter:
    """Writes an APKG whose audio members are the canonical cue WAV files unchanged."""

    def write(
        self, *, cues: list[ExportCue], output: Path, deck_name: str,
        rich_cards: dict[str, dict] | None = None,
    ) -> Path:
        try:
            import genanki
        except ImportError as exc:  # pragma: no cover - depends on optional production dependency
            raise RuntimeError("Genanki é necessário para exportar o pacote Anki.") from exc
        output.parent.mkdir(parents=True, exist_ok=True)
        model = genanki.Model(
            1607392319,
            "Nova Generator Cue",
            fields=[{"name": "English"}, {"name": "Portuguese"}, {"name": "Audio"}],
            templates=[
                {
                    "name": "Cue",
                    "qfmt": "{{English}}<br>{{Audio}}",
                    "afmt": "{{FrontSide}}<hr id=answer>{{Portuguese}}",
                }
            ],
        )
        if rich_cards is not None:
            model = genanki.Model(
                1607392320,
                "Nova Generator - Aula Completa",
                fields=[
                    {"name": name}
                    for name in (
                        "English", "Portuguese", "Audio", "Focus", "Meaning",
                        "Explanation", "ExampleEN", "ExamplePT",
                    )
                ],
                templates=[{
                    "name": "Aula e revisão",
                    "qfmt": (
                        '<div class="en">{{English}}</div><div>{{Audio}}</div>'
                        '<div class="focus">{{Focus}}</div>'
                    ),
                    "afmt": (
                        "{{FrontSide}}<hr id=answer><div>{{Portuguese}}</div>"
                        "<p><b>Significado:</b> {{Meaning}}</p>"
                        "<p><b>Como entender e usar:</b> {{Explanation}}</p>"
                        "<p><b>Outro exemplo:</b> {{ExampleEN}}</p>"
                        "<p>{{ExamplePT}}</p>"
                    ),
                }],
                css=(
                    ".card {font-family:Arial,sans-serif;text-align:left;"
                    "font-size:19px;background:#f8fbff;color:#17253b;padding:18px;}"
                    ".en{font-weight:700;font-size:24px;margin-bottom:8px;}"
                    ".focus{color:#1b6488;margin-top:8px;font-weight:600;}"
                ),
            )
        deck = genanki.Deck(2059400110, deck_name)
        with tempfile.TemporaryDirectory(prefix="nova_generator_anki_") as temporary:
            media: list[str] = []
            for cue in cues:
                filename = f"cue_{cue.order:04d}.wav"
                target = Path(temporary) / filename
                shutil.copyfile(cue.audio_path, target)
                fields = [cue.approved_en, cue.approved_pt, f"[sound:{filename}]"]
                if rich_cards is not None:
                    card = rich_cards.get(str(cue.cue_id))
                    if card is None:
                        raise ValueError(f"Material didático ausente para card {cue.cue_id}.")
                    fields += [
                        escape(str(card.get("focus_text") or "")),
                        escape(str(card.get("meaning") or "")),
                        escape(str(card["explanation_pt"])),
                        escape(str(card.get("example_en") or "")),
                        escape(str(card.get("example_pt") or "")),
                    ]
                deck.add_note(
                    genanki.Note(
                        model=model,
                        fields=fields,
                        guid=genanki.guid_for(str(cue.cue_id), cue.text_sha256, cue.audio_sha256),
                    )
                )
                media.append(str(target))
            package = genanki.Package(deck)
            package.media_files = media
            package.write_to_file(str(output))
        return output
