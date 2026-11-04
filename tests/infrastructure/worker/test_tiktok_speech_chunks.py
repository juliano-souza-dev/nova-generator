from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from nova_generator.domain.tiktok_media import MediaSlide
from nova_generator.domain.voices import VoiceProfile
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache
from nova_generator.infrastructure.worker import tiktok_media_handler
from nova_generator.infrastructure.worker.tiktok_speech import (
    TikTokSpeechChunk,
    build_project_speech_chunks,
    split_at_sentence_boundaries,
)


def _voice():
    return VoiceProfile(
        uuid4(),
        "Voz bilíngue",
        1,
        "qwen3-tts-1.7b-voice-design",
        "a" * 64,
        parameters={"instruct": "Clear, natural, consistent voice."},
    ).snapshot()


def test_sentence_splitting_preserves_literal_text_and_order():
    text = "First sentence. Second sentence! Third sentence?"
    chunks = split_at_sentence_boundaries(text, max_characters=20)

    assert len(chunks) == 3
    assert "".join(chunks) == text
    assert all(len(chunk) <= 20 for chunk in chunks)


def test_slide_cue_fields_become_explicit_english_then_portuguese_chunks():
    slide = MediaSlide(
        en="Watch this! Keep listening.",
        pt="Olha isso! Continue ouvindo.",
        narration_text="[pt]Este campo antigo não deve substituir os cues.[/pt]",
    )

    chunks = build_project_speech_chunks([slide], _voice())

    assert [(chunk.language, chunk.text) for chunk in chunks] == [
        ("en", "Watch this! Keep listening."),
        ("pt", "Olha isso! Continue ouvindo."),
    ]
    assert chunks[0].parameters == {"language": "English", "seed": 42}
    assert chunks[1].parameters == {"language": "Portuguese", "seed": 42}


def test_legacy_unclosed_language_tag_does_not_block_old_project_render():
    slide = MediaSlide(narration_text="[pt]Texto antigo sem fechamento")

    chunks = build_project_speech_chunks([slide], _voice(), default_language="pt")

    assert len(chunks) == 1
    assert chunks[0].language == "pt"
    assert chunks[0].text == "Texto antigo sem fechamento"



def test_chunk_assembly_adds_punctuation_pause_normalizes_and_records_positions(
    monkeypatch, tmp_path
):
    profile = _voice()
    english_path = tmp_path / "english.wav"
    portuguese_path = tmp_path / "portuguese.wav"
    english_path.write_bytes(b"english chunk")
    portuguese_path.write_bytes(b"portuguese chunk")
    output = tmp_path / "assembled.wav"
    captured = {}

    def fake_ffmpeg(arguments):
        captured["arguments"] = arguments
        Path(arguments[-1]).write_bytes(b"normalized final audio")

    monkeypatch.setattr(tiktok_media_handler, "_run_ffmpeg", fake_ffmpeg)
    chunks = [
        (
            TikTokSpeechChunk(
                0, "slide-1", "en", "en", "Watch this!", {"language": "English", "seed": 42}
            ),
            SimpleNamespace(
                audio_path=str(english_path),
                duration_ms=1000,
                sample_rate=24000,
                channels=1,
                text_sha256=sha256(b"Watch this!").hexdigest(),
                profile=profile,
                parameters={"language": "English", "seed": 42},
            ),
        ),
        (
            TikTokSpeechChunk(
                0, "slide-1", "pt", "pt", "Olha isso.", {"language": "Portuguese", "seed": 42}
            ),
            SimpleNamespace(
                audio_path=str(portuguese_path),
                duration_ms=1000,
                sample_rate=24000,
                channels=1,
                text_sha256=sha256(b"Olha isso.").hexdigest(),
                profile=profile,
                parameters={"language": "Portuguese", "seed": 42},
            ),
        ),
    ]

    duration_ms, records, audio_sha256 = tiktok_media_handler._assemble_voice_chunks(
        chunks, output, slide_start_ms=5000
    )

    arguments = captured["arguments"]
    filter_graph = arguments[arguments.index("-filter_complex") + 1]
    assert "anullsrc" in filter_graph
    assert "atrim=duration=0.420" in filter_graph
    assert "loudnorm=I=-16:TP=-1.5:LRA=11" in filter_graph
    assert duration_ms == 2420
    assert records[0]["start_ms"] == 0
    assert records[0]["end_ms"] == 1000
    assert records[0]["pause_after_ms"] == 420
    assert records[1]["start_ms"] == 1420
    assert records[1]["timeline_start_ms"] == 6420
    assert records[1]["timeline_end_ms"] == 7420
    assert records[0]["cache_key"] == FileSpeechCache(tmp_path).cache_key(
        text="Watch this!",
        profile=profile,
        parameters={"language": "English", "seed": 42},
    )
    assert audio_sha256 == sha256(b"normalized final audio").hexdigest()



def test_slide_boundary_keeps_pause_when_the_next_slide_changes_language(monkeypatch, tmp_path):
    profile = _voice()
    source = tmp_path / "last-english-chunk.wav"
    source.write_bytes(b"english chunk")
    output = tmp_path / "slide-audio.wav"
    captured = {}

    def fake_ffmpeg(arguments):
        captured["arguments"] = arguments
        Path(arguments[-1]).write_bytes(b"assembled audio")

    monkeypatch.setattr(tiktok_media_handler, "_run_ffmpeg", fake_ffmpeg)
    chunk = TikTokSpeechChunk(
        0, "slide-1", "en", "en", "Watch this!", {"language": "English", "seed": 42}
    )
    rendered = SimpleNamespace(
        audio_path=str(source),
        duration_ms=1000,
        sample_rate=24000,
        channels=1,
        text_sha256=sha256(b"Watch this!").hexdigest(),
        profile=profile,
        parameters={"language": "English", "seed": 42},
    )

    duration_ms, records, _audio_sha256 = tiktok_media_handler._assemble_voice_chunks(
        [(chunk, rendered)],
        output,
        slide_start_ms=0,
        following_language="pt",
    )

    filter_graph = captured["arguments"][
        captured["arguments"].index("-filter_complex") + 1
    ]
    assert "atrim=duration=0.420" in filter_graph
    assert duration_ms == 1420
    assert records[0]["pause_after_ms"] == 420
