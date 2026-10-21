"""Upgrade the Anki note template without re-synthesizing or re-rendering a reel."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from hashlib import sha256
from pathlib import Path
from typing import Callable
from uuid import UUID

from nova_generator.application.ports.editorial_project_repository import (
    EditorialProjectRepository,
)
from nova_generator.application.use_cases.materials_ai_exchange import (
    MaterialsAiError,
    MaterialsAiExchange,
)
from nova_generator.domain.exports import DIDACTIC_LAYOUT, ExportCue
from nova_generator.domain.jobs import Job
from nova_generator.domain.projects.entities import utf8_sha256
from nova_generator.domain.voices import VoiceProfileSnapshot
from nova_generator.infrastructure.exports.genanki_package_writer import GenankiPackageWriter
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache


class AnkiPackageRebuildError(ValueError):
    """A frozen export cannot be rebuilt without replacing its media."""


def _voice_snapshot(raw: object) -> VoiceProfileSnapshot:
    if not isinstance(raw, dict):
        raise AnkiPackageRebuildError("Snapshot de voz ausente.")
    try:
        voice = VoiceProfileSnapshot(
            profile_id=UUID(str(raw["profile_id"])),
            name=str(raw["name"]),
            version=int(raw["version"]),
            model_id=str(raw["model_id"]),
            model_sha256=str(raw["model_sha256"]),
            reference_audio_sha256=(
                str(raw["reference_audio_sha256"])
                if raw.get("reference_audio_sha256") else None
            ),
            parameters=dict(raw.get("parameters", {})),
        )
        if voice.sha256 != raw.get("snapshot_sha256"):
            raise AnkiPackageRebuildError("Snapshot de voz alterado.")
        return voice
    except (ValueError, TypeError, KeyError) as error:
        raise AnkiPackageRebuildError("Snapshot de voz inválido.") from error


def _hash(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def rebuild_didactic_apkg(
    *,
    project_id: UUID,
    job: Job,
    repository: EditorialProjectRepository,
    export_root: Path,
    project_root: Path,
    media_cache_root: Path,
    republish: Callable[[], None] | None = None,
) -> str:
    """Repackage the frozen 2.0 lesson into an independent v3 Anki note type.

    Preserves every WAV, the reel and its intervals, the original video link
    and the canonical cue text. The published JSON is refreshed if supplied.
    """
    if (
        job.status != "succeeded"
        or str(job.input.get("project_id")) != str(project_id)
        or job.input.get("mode") != "didactic"
    ):
        raise AnkiPackageRebuildError(
            "Selecione uma exportação Anki didática concluída."
        )
    cards = job.input.get("anki_cards")
    if not isinstance(cards, list) or not cards:
        raise AnkiPackageRebuildError("Esta exportação não contém mini-aulas preparadas.")
    export_dir = export_root / str(job.id)
    apkg_path = export_dir / "anki.apkg"
    reel_path = export_dir / "anki-reel.mp4"
    manifest_path = export_dir / "anki-audio-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (
            manifest.get("schema") != "nova-generator-anki-audio"
            or manifest.get("schema_version") != "1.0"
            or manifest.get("voice", {}).get("snapshot_sha256")
            != job.input.get("voice_snapshot", {}).get("snapshot_sha256")
            or manifest.get("apkg_sha256") != _hash(apkg_path)
            or manifest.get("reel_sha256") != _hash(reel_path)
            or len(manifest.get("cues", [])) != len(cards)
        ):
            raise AnkiPackageRebuildError("O APKG ou o reel diverge do manifesto original.")
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise AnkiPackageRebuildError("Exportação original incompleta ou inválida.") from error

    voice = _voice_snapshot(job.input.get("voice_snapshot"))
    cache = FileSpeechCache(media_cache_root)
    exchange = MaterialsAiExchange(repository, project_root)
    cues: list[ExportCue] = []
    for order, card in enumerate(cards, 1):
        try:
            card_id = UUID(str(card["card_id"]))
            source = repository.get_cue(UUID(str(card["cue_id"])))
            actual = exchange.find_anki_card(project_id, card_id)
        except (KeyError, ValueError, MaterialsAiError) as error:
            raise AnkiPackageRebuildError(
                "Card Anki indisponível; revise o material antes de exportar."
            ) from error
        if actual != card or source is None or (
            repository.get_scene_project_id(source.scene_id) != project_id
        ) or source.provenance.get("approval") == "draft":
            raise AnkiPackageRebuildError(
                "O card ou sua origem editorial mudou. Faça uma nova exportação didática."
            )
        if (
            source.approved_en != card["source_context_en"]
            or source.approved_pt != card["source_context_pt"]
            or job.input.get("text_hashes", {}).get(str(card_id))
            != utf8_sha256(card["front_en"])
            or job.input.get("pt_hashes", {}).get(str(card_id))
            != utf8_sha256(card["back_pt"])
        ):
            raise AnkiPackageRebuildError("O texto didático mudou após a exportação.")
        interval = manifest["cues"][order - 1]
        if (
            interval.get("cue_order") != order
            or interval.get("text_sha256") != utf8_sha256(card["front_en"])
            or interval.get("audio_sha256")
            != job.input.get("audio_hashes", {}).get(str(card_id))
        ):
            raise AnkiPackageRebuildError("O áudio do card diverge do reel publicado.")
        speech = cache.find(
            cache.cache_key(text=card["front_en"], profile=voice, parameters={})
        )
        if (
            speech is None
            or speech.profile.sha256 != voice.sha256
            or _hash(Path(speech.audio_path)) != interval["audio_sha256"]
        ):
            raise AnkiPackageRebuildError(
                f"WAV do card {card_id} não está disponível no cache original."
            )
        cues.append(ExportCue(
            card_id, order, card["front_en"], card["back_pt"],
            Path(speech.audio_path), speech.duration_ms,
            utf8_sha256(card["front_en"]), lesson=dict(card),
        ))

    project = repository.get_project(project_id)
    if project is None:
        raise AnkiPackageRebuildError("Projeto não encontrado.")
    with tempfile.TemporaryDirectory(dir=export_dir, prefix=".anki-v3-") as temp:
        staging = Path(temp)
        apkg_new = staging / "anki.apkg"
        GenankiPackageWriter().write(
            cues=cues, output=apkg_new, deck_name=project.title
        )
        if not apkg_new.is_file() or apkg_new.stat().st_size == 0:
            raise AnkiPackageRebuildError("Falha ao criar o APKG didático v3.")
        revised = dict(manifest)
        revised["card_layout"] = DIDACTIC_LAYOUT
        revised["apkg_sha256"] = _hash(apkg_new)
        new_manifest = staging / "anki-audio-manifest.json"
        new_manifest.write_text(
            json.dumps(revised, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        backup_apkg = staging / "previous.apkg"
        backup_manifest = staging / "previous-manifest.json"
        shutil.copy2(apkg_path, backup_apkg)
        shutil.copy2(manifest_path, backup_manifest)
        try:
            os.replace(apkg_new, apkg_path)
            os.replace(new_manifest, manifest_path)
            if republish is not None:
                republish()
        except Exception:
            # Do not leave an inconsistent export/manifest if republishing fails.
            os.replace(backup_apkg, apkg_path)
            os.replace(backup_manifest, manifest_path)
            raise
    return DIDACTIC_LAYOUT
