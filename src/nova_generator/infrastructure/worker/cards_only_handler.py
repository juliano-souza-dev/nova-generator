"""Cards-only durable worker: reuse the exact iHub didactic Anki model."""
from __future__ import annotations

import json
import os
import shutil
from hashlib import sha256
from uuid import UUID
from zipfile import ZipFile, ZIP_DEFLATED

from nova_generator.application.use_cases.cards_only import hub_item, normalize_cards
from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.core.settings import get_settings
from nova_generator.domain.exports import ExportCue
from nova_generator.domain.jobs import Job
from nova_generator.infrastructure.exports.genanki_package_writer import GenankiPackageWriter
from nova_generator.infrastructure.worker.persistent_worker import JobExecution
from nova_generator.infrastructure.worker.tiktok_media_handler import _voice_snapshot


def make_cards_only_handler(speech: SynthesizeSpeech):
    writer = GenankiPackageWriter()

    def handle(job: Job, execution: JobExecution) -> dict:
        export_id = UUID(str(job.input["export_id"]))
        folder = get_settings().media_cache_root / "cards-only" / str(export_id)
        source_bytes = (folder / "input.json").read_bytes()
        if sha256(source_bytes).hexdigest() != job.input["input_sha256"]:
            raise ValueError("O JSON importado foi alterado depois de enfileirar a exportação.")
        snapshot = json.loads(source_bytes)
        title, cards = normalize_cards(snapshot)
        voice = _voice_snapshot(job.input["voice_snapshot"])

        youtube = job.input.get("youtube_url")
        extension = job.input.get("audio_extension")
        if bool(youtube) == bool(extension):
            raise ValueError("A origem deve ser YouTube ou áudio enviado.")
        source = {"type": "youtube", "url": youtube} if youtube else {
            "type": "audio", "file": f"audio/source{extension}"
        }
        uploaded = folder / f"source{extension}" if extension else None
        if uploaded is not None and (
            not uploaded.is_file() or
            sha256(uploaded.read_bytes()).hexdigest() != job.input["audio_sha256"]
        ):
            raise ValueError("O áudio enviado foi alterado depois da importação.")

        audio_folder = folder / "audio"
        audio_folder.mkdir(exist_ok=True)
        cues = []
        output_cards = []
        hub_cues = []
        by_source: dict[str, dict] = {}
        for order, card in enumerate(cards, 1):
            execution.raise_if_cancelled()
            # Always pronounce the new pedagogical front_en, never a different
            # recording of the original source context.
            speech_result = speech.execute(text=card["front_en"], profile=voice)
            card_id = UUID(card["card_id"])
            audio_path = audio_folder / f"anki_{card_id}.wav"
            shutil.copyfile(speech_result.audio_path, audio_path)
            if not audio_path.is_file() or audio_path.stat().st_size == 0:
                raise ValueError(f"Áudio vazio para o card {card_id}.")
            cues.append(ExportCue(
                cue_id=card_id, order=order,
                approved_en=card["front_en"], approved_pt=card["back_pt"],
                audio_path=audio_path, duration_ms=speech_result.duration_ms,
                text_sha256=sha256(card["front_en"].encode("utf-8")).hexdigest(),
                lesson=card,
            ))
            output_cards.append({
                **card, "audio": {
                    "type": "wav", "file": f"audio/anki_{card_id}.wav",
                    "duration_ms": speech_result.duration_ms,
                },
            })
            source_id = card["cue_id"]
            row = by_source.get(source_id)
            if row is None:
                row = {
                    "order": len(hub_cues) + 1, "cue_id": source_id,
                    "approved_en": card["source_context_en"],
                    "final_en": card["source_context_en"],
                    "pt": card["source_context_pt"],
                    "anki": {"include": True, "items": []},
                }
                hub_cues.append(row)
                by_source[source_id] = row
            elif (row["final_en"], row["pt"]) != (
                card["source_context_en"], card["source_context_pt"]
            ):
                raise ValueError(f"Contexto inconsistente no mesmo cue_id {source_id}.")
            row["anki"]["items"].append(hub_item(card))
            execution.heartbeat()

        apkg = writer.write(cues=cues, output=folder / "anki.apkg", deck_name=title)
        document = {
            "contract": "nova-generator-cards-only/1.0",
            "title": title,
            "source": source,
            "anki_layout": "ihub-didactic-v3",
            "cards": output_cards,
            "cues": hub_cues,
        }
        output_json = folder / "cards.json"
        output_json.write_text(
            json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        files = [(apkg, "anki.apkg"), (output_json, "cards.json")]
        files.extend((cue.audio_path, f"audio/{cue.audio_path.name}") for cue in cues)
        if uploaded is not None:
            files.append((uploaded, f"audio/source{extension}"))
        names = [name for _, name in files]
        if len(names) != len(set(names)):
            raise ValueError("O pacote contém arquivos com nomes repetidos.")
        staging = folder / "cards-only.tmp.zip"
        destination = folder / "cards-only.zip"
        with ZipFile(staging, "w", compression=ZIP_DEFLATED) as archive:
            for path, name in files:
                execution.raise_if_cancelled()
                archive.write(path, arcname=name)
        os.replace(staging, destination)
        manifest = {
            "contract": "nova-generator-cards-only-export/1.0",
            "export_id": str(export_id), "job_id": str(job.id),
            "cards": len(cards),
            "files": [{
                "path": name, "sha256": sha256(path.read_bytes()).hexdigest()
            } for path, name in files],
            "zip_sha256": sha256(destination.read_bytes()).hexdigest(),
        }
        temp = folder / "manifest.tmp"
        temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, folder / "manifest.json")
        return {
            "export_id": str(export_id),
            "card_count": len(cards),
            "bundle_url": f"/api/cards-only/exports/{export_id}/bundle",
            "cards_json_url": f"/api/cards-only/exports/{export_id}/cards.json",
            "apkg_url": f"/api/cards-only/exports/{export_id}/anki.apkg",
        }
    return handle
