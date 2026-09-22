from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from nova_generator.domain.exports import ExportCue


class GenankiPackageWriter:
    """Writes an APKG whose audio members are the canonical cue WAV files unchanged."""

    def write(self, *, cues: list[ExportCue], output: Path, deck_name: str) -> Path:
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
        deck = genanki.Deck(2059400110, deck_name)
        with tempfile.TemporaryDirectory(prefix="nova_generator_anki_") as temporary:
            media: list[str] = []
            for cue in cues:
                filename = f"cue_{cue.order:04d}.wav"
                target = Path(temporary) / filename
                shutil.copyfile(cue.audio_path, target)
                deck.add_note(
                    genanki.Note(
                        model=model,
                        fields=[cue.approved_en, cue.approved_pt, f"[sound:{filename}]"],
                        guid=genanki.guid_for(str(cue.cue_id), cue.text_sha256, cue.audio_sha256),
                    )
                )
                media.append(str(target))
            package = genanki.Package(deck)
            package.media_files = media
            package.write_to_file(str(output))
        return output
