from dataclasses import replace
from hashlib import sha256
from unittest.mock import Mock
from uuid import uuid4

import pytest

from nova_generator.application.use_cases.editorial_publication_snapshot import (
    editorial_publication_sha256,
)
from nova_generator.domain.jobs import Job
from nova_generator.domain.projects.entities import Cue, Project, Scene, utf8_sha256
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfile
from nova_generator.infrastructure.worker.materials_handler import MaterialsJobHandler


def test_worker_rejects_timing_edit_after_export_was_queued(tmp_path):
    project_id, scene_id, cue_id, job_id = (uuid4() for _ in range(4))
    project = Project(project_id, "Lesson", "dialogue")
    scene = Scene(scene_id, project_id, 1, 1000)
    cue = Cue(cue_id, scene_id, 1, 100, 700, 100, 700, "Ana", "Café?", "Café?", "Café!")
    voice = VoiceProfile(uuid4(), "Ana", 1, "nano", "a" * 64).snapshot()
    wav = tmp_path / "speech.wav"
    wav.write_bytes(b"canonical speech")
    audio_hash = sha256(wav.read_bytes()).hexdigest()
    repository = Mock()
    repository.get_project.return_value = project
    repository.get_project_scenes.return_value = [scene]
    repository.get_cue.return_value = replace(cue, speech_start_ms=150)
    repository.get_scene_project_id.return_value = project_id
    repository.get_cue_words.return_value = []
    cache = Mock()
    cache.find.return_value = SynthesizedSpeech(
        str(wav), cue.approved_en_sha256, voice, {}, 600, 24000, 1
    )
    exporter = Mock()
    handler = MaterialsJobHandler(repository, cache, Mock(), exporter, tmp_path / "exports")
    job = Job(
        job_id,
        "export_materials",
        "queued",
        {
            "project_id": str(project_id),
            "cue_ids": [str(cue_id)],
            "text_hashes": {str(cue_id): cue.approved_en_sha256},
            "pt_hashes": {str(cue_id): utf8_sha256(cue.approved_pt)},
            "audio_hashes": {str(cue_id): audio_hash},
            "editorial_sha256": editorial_publication_sha256(project, [scene], [(cue, [])]),
            "voice_snapshot": {
                "profile_id": str(voice.profile_id),
                "name": voice.name,
                "version": voice.version,
                "model_id": voice.model_id,
                "model_sha256": voice.model_sha256,
                "reference_audio_sha256": None,
                "parameters": voice.parameters,
                "snapshot_sha256": voice.sha256,
            },
        },
        None,
        1,
        3,
    )
    with pytest.raises(ValueError, match="editorial timing or words changed"):
        handler.export(job, Mock())
    exporter.execute.assert_not_called()
