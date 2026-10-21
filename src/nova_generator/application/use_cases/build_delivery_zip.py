"""Build one verifiable offline delivery from an already completed Anki export.

No audio or editorial content is generated here; artifacts come from the exact
export job and validated publication. Files are streamed into a temporary ZIP.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile


class DeliveryError(ValueError):
    pass


@dataclass(frozen=True)
class DeliveryAsset:
    name: str
    source: Path
    expected_sha256: str | None = None


def verify_didactic_publication(
    cards: list[dict[str, Any]], document: dict[str, Any]
) -> None:
    """Prevent exporting an APKG/card snapshot unrelated to the iHub JSON."""
    snapshot = {f"anki-{card['card_id']}": card for card in cards}
    if len(snapshot) != len(cards):
        raise DeliveryError("Card IDs repetidos na exportação didática.")
    published_items = {
        item["key"]: item
        for cue in document.get("cues", [])
        for item in cue.get("anki", {}).get("items", [])
    }
    if set(snapshot) != set(published_items):
        raise DeliveryError("Os cards do iHub diferem dos cards congelados no APKG.")
    expected_pairs = {
        "focus": "front_en",
        "meaning": "back_pt",
        "focus_text": "focus_text",
        "explanation": "explanation_pt",
        "example_en": "example_en",
        "example_pt": "example_pt",
        "marked_en": "marked_en",
        "marked_pt": "marked_pt",
        "tags": "tags",
    }
    for key, card in snapshot.items():
        item = published_items[key]
        for output_field, card_field in expected_pairs.items():
            if item.get(output_field) != card[card_field]:
                raise DeliveryError(
                    f"Card {key}: {output_field} difere da exportação pedagógica."
                )
    timeline = document.get("ankiAudio", {}).get("cues", [])
    if len(timeline) != len(cards) or [
        row.get("card_key") for row in timeline
    ] != [f"anki-{card['card_id']}" for card in cards]:
        raise DeliveryError("Os intervalos de áudio não correspondem aos cards didáticos.")


def build_delivery_zip(
    destination: Path,
    *,
    project_id: str,
    job_id: str,
    assets: list[DeliveryAsset],
    didactic_cards: list[dict[str, Any]] | None = None,
) -> Path:
    """Stream checked files into a ZIP with a per-file checksum manifest."""
    if not assets:
        raise DeliveryError("Nenhum arquivo de entrega foi encontrado.")
    names = [asset.name for asset in assets]
    if len(set(names)) != len(names) or any(
        name.startswith("/") or ".." in Path(name).parts or "\\" in name
        for name in names
    ):
        raise DeliveryError("Nome de arquivo inválido ou repetido no kit de entrega.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    details: list[dict[str, Any]] = []
    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
        for asset in assets:
            if not asset.source.is_file() or asset.source.stat().st_size == 0:
                raise DeliveryError(f"Arquivo obrigatório indisponível: {asset.name}")
            digest = sha256()
            size = 0
            with asset.source.open("rb") as origin, archive.open(asset.name, "w") as output:
                while chunk := origin.read(1024 * 1024):
                    digest.update(chunk)
                    output.write(chunk)
                    size += len(chunk)
            actual = digest.hexdigest()
            if asset.expected_sha256 is not None and actual != asset.expected_sha256:
                raise DeliveryError(f"Arquivo alterado após exportação: {asset.name}")
            details.append({"file": asset.name, "sha256": actual, "bytes": size})

        if didactic_cards is not None:
            document = {
                "contract": "nova-generator-anki-delivery/1.0",
                "cards": didactic_cards,
            }
            data = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            name = "anki/anki-cards.json"
            archive.writestr(name, data)
            details.append({
                "file": name, "sha256": sha256(data).hexdigest(), "bytes": len(data),
            })

        readme = (
            "iHub English · Kit completo do Nova Generator\n\n"
            "hub_final.json: conteúdo que será importado pelo iHub.\n"
            "anki/anki.apkg: cards Anki com a frente, o verso e a mini-aula.\n"
            "anki/anki-reel.mp4: reel dos áudios já gerados.\n"
            "anki/anki-audio-manifest.json: intervalos e hashes do reel.\n"
            "audio/wav/: WAV individual de cada card, idêntico ao áudio exportado.\n"
            "anki/anki-cards.json: conteúdo pedagógico congelado (se disponível).\n"
            "shadowing/: planos aprovados disponíveis no momento da entrega.\n"
            "O ZIP não executa síntese, não reprocessa a mídia e não faz upload.\n"
        )
        archive.writestr("LEIA-ME.txt", readme)
        archive.writestr(
            "manifesto-entrega.json",
            json.dumps({
                "contract": "nova-generator-delivery/1.0",
                "project_id": project_id,
                "export_job_id": job_id,
                "files": details,
            }, ensure_ascii=False, indent=2) + "\n",
        )
    return destination
