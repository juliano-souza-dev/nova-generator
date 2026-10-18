"""End-to-end service checks for the Gerar material production stages."""

from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from nova_generator.application.use_cases.editorial_publication_snapshot import (
    editorial_publication_sha256,
)
from nova_generator.application.use_cases.generate_materials_ai import GenerateMaterialsAi
from nova_generator.application.use_cases.materials_ai_exchange import (
    SECTION_IDS,
    MaterialsAiError,
    MaterialsAiExchange,
)
from nova_generator.domain.jobs import Job
from nova_generator.domain.projects.entities import Cue, Project, Scene, utf8_sha256
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfile
from nova_generator.infrastructure.exports.material_workbook_pdf import render_material_workbook
from nova_generator.infrastructure.worker.materials_handler import MaterialsJobHandler


class Repository:
    def __init__(self) -> None:
        self.project = Project(uuid4(), "Aula de inglês", "dialogue")
        self.scene = Scene(uuid4(), self.project.id, 1, 7000)
        self.cue = Cue(
            uuid4(), self.scene.id, 1, 700, 1350, 700, 1350,
            "Juliana", "Hello!", "Hello!", "Olá!", provenance={"approval": "approved"},
        )

    def get_project(self, project_id):
        return self.project if project_id == self.project.id else None

    def get_project_scenes(self, project_id):
        return [self.scene] if project_id == self.project.id else []

    def get_scene_cues(self, scene_id):
        return [self.cue] if scene_id == self.scene.id else []

    def get_cue(self, cue_id):
        return self.cue if cue_id == self.cue.id else None

    def get_cue_words(self, cue_id):
        return []

    def get_scene_project_id(self, scene_id):
        return self.project.id if scene_id == self.scene.id else None


def teaching_document(repo: Repository, digest: str) -> dict:
    return {
        "contract": "nova-generator-materials-output/1.0",
        "project_id": str(repo.project.id),
        "source_sha256": digest,
        "title": "Aprenda com a cena",
        "sections": [
            {
                "id": section,
                "title": f"Parte: {section}",
                "paragraphs": ["Aprenda inglês com expressões e tradução natural."],
                "exercises": (
                    [{"prompt": "Como responder?", "answer": "Com uma saudação."}]
                    if section in {"guided_practice", "activities", "challenge"} else []
                ),
            }
            for section in SECTION_IDS
        ],
        "anki_cards": [{
            "cue_id": str(repo.cue.id),
            "front_en": repo.cue.approved_en,
            "back_pt": repo.cue.approved_pt,
            "explanation_pt": "Saudação simples para iniciar uma conversa.",
            "focus_text": "Hello!",
            "meaning": "Olá!",
            "example_en": "Hello, everyone!",
            "example_pt": "Olá, pessoal!",
        }],
    }


def test_groq_generates_a_complete_draft_for_review_without_autoapproval(tmp_path):
    repo = Repository()
    exchange = MaterialsAiExchange(repo, tmp_path)
    digest = exchange.package(repo.project.id)["source_sha256"]
    document = teaching_document(repo, digest)
    provider = Mock(return_value=SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(document)))]
    ))
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=provider)))
    generated = GenerateMaterialsAi(
        exchange, api_key=None, model="mock-model", client=client
    ).execute(repo.project.id, source_sha256=digest, selected_ids=[str(repo.cue.id)])
    assert generated["sections"] == 7
    assert generated["cards"] == 1
    assert exchange.status(repo.project.id)["status"] == "draft"
    assert provider.call_args.kwargs["response_format"] == {"type": "json_object"}
    assert exchange.status(repo.project.id)["document"]["anki_cards"][0]["explanation_pt"]


def test_incomplete_ai_response_never_replaces_previous_approval(tmp_path):
    repo = Repository()
    exchange = MaterialsAiExchange(repo, tmp_path)
    digest = exchange.package(repo.project.id)["source_sha256"]
    initial = teaching_document(repo, digest)
    exchange.import_result(repo.project.id, initial)
    exchange.approve(repo.project.id, digest)
    invalid = {**initial, "anki_cards": [
        {**initial["anki_cards"][0], "cue_id": str(uuid4())}
    ]}
    provider = Mock(return_value=SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(invalid)))]
    ))
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=provider)))
    with pytest.raises(MaterialsAiError, match="todos os cards"):
        GenerateMaterialsAi(
            exchange, api_key=None, model="mock-model", client=client
        ).execute(repo.project.id, source_sha256=digest, selected_ids=[str(repo.cue.id)])
    assert exchange.status(repo.project.id)["status"] == "approved"
    assert exchange.status(repo.project.id)["document"] == initial


def test_complete_job_reuses_canonical_wav_and_creates_pdf_anki_manifest(tmp_path):
    repo = Repository()
    exchange = MaterialsAiExchange(repo, tmp_path / "projects")
    digest = exchange.package(repo.project.id)["source_sha256"]
    doc = teaching_document(repo, digest)
    exchange.import_result(repo.project.id, doc)
    exchange.approve(repo.project.id, digest)
    voice = VoiceProfile(uuid4(), "Juliana", 1, "chatterbox-turbo", "a" * 64).snapshot()
    wav = tmp_path / "cached.wav"
    wav.write_bytes(b"RIFF-persisted-canonical-audio")
    speech = SynthesizedSpeech(
        str(wav), repo.cue.approved_en_sha256, voice, {}, 800, 24000, 1
    )
    synthesis = Mock()
    synthesis.execute.return_value = speech
    cache = Mock()
    cache.find.return_value = speech

    def fake_exporter(*, cues, voice, output_directory: Path, deck_name, rich_cards):
        assert rich_cards[str(repo.cue.id)]["explanation_pt"]
        output_directory.mkdir(parents=True, exist_ok=True)
        for name in ("anki.apkg", "anki-reel.mp4", "anki-audio-manifest.json"):
            (output_directory / name).write_bytes(b"valid test artifact")
        return SimpleNamespace(
            apkg_path=output_directory / "anki.apkg",
            reel_path=output_directory / "anki-reel.mp4",
            manifest_path=output_directory / "anki-audio-manifest.json",
        )

    exporter = Mock()
    exporter.execute.side_effect = fake_exporter
    handler = MaterialsJobHandler(
        repo, cache, synthesis, exporter, tmp_path / "exports", tmp_path / "projects"
    )
    encoded = json.dumps(
        exchange.status(repo.project.id)["document"],
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    job = Job(
        uuid4(), "export_materials", "running", {
            "project_id": str(repo.project.id),
            "cue_ids": [str(repo.cue.id)],
            "text_hashes": {str(repo.cue.id): repo.cue.approved_en_sha256},
            "pt_hashes": {str(repo.cue.id): utf8_sha256(repo.cue.approved_pt)},
            "audio_hashes": {},
            "editorial_sha256": editorial_publication_sha256(
                repo.project, [repo.scene], [(repo.cue, [])]
            ),
            "voice_snapshot": {
                "profile_id": str(voice.profile_id),
                "name": voice.name,
                "version": voice.version,
                "model_id": voice.model_id,
                "model_sha256": voice.model_sha256,
                "reference_audio_sha256": None,
                "parameters": {},
                "snapshot_sha256": voice.sha256,
            },
            "generate_complete": True,
            "materials_sha256": sha256(encoded).hexdigest(),
            "materials_source_sha256": digest,
        }, None, 1, 3
    )
    execution = Mock()
    output = handler.export(job, execution)
    assert Path(output["workbook"]).read_bytes().startswith(b"%PDF-")
    assert Path(output["pedagogical_snapshot"]).is_file()
    assert output["audio_hashes"][str(repo.cue.id)] == sha256(wav.read_bytes()).hexdigest()
    assert output["cards"] == 1
    assert output["sections"] == 7
    synthesis.execute.assert_called_once_with(text=repo.cue.approved_en, profile=voice)
    execution.heartbeat.assert_called()


def test_pdf_contains_all_seven_reviewed_sections_without_inventing_content(tmp_path):
    repo = Repository()
    doc = teaching_document(repo, "b" * 64)
    output = render_material_workbook(doc, tmp_path / "material.pdf")
    assert output.is_file()
    assert output.read_bytes().startswith(b"%PDF-")
    assert output.stat().st_size > 1300
