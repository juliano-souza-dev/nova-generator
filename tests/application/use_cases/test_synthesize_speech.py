from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from nova_generator.application.use_cases.synthesize_speech import SynthesizeSpeech
from nova_generator.domain.voices import SynthesizedSpeech, VoiceProfile
from nova_generator.infrastructure.speech.file_speech_cache import FileSpeechCache


class FakeSynthesizer:
    def __init__(self) -> None:
        self.calls = 0

    def synthesize(self, *, text, profile, parameters, output):
        self.calls += 1
        Path(output).write_bytes(b"RIFF fake wav")
        return SynthesizedSpeech(
            str(output), sha256(text.encode()).hexdigest(), profile, parameters, 1234, 24000, 1
        )


def test_synthesis_cache_reuses_same_text_profile_and_parameters(tmp_path) -> None:
    profile = VoiceProfile(uuid4(), "Ana", 1, "chatterbox-nano", "a" * 64).snapshot()
    cache = FileSpeechCache(tmp_path)
    synthesizer = FakeSynthesizer()
    use_case = SynthesizeSpeech(cache, synthesizer)
    first = use_case.execute(text='Hello, "world"!', profile=profile, parameters={"seed": 1})
    second = use_case.execute(text='Hello, "world"!', profile=profile, parameters={"seed": 1})
    assert synthesizer.calls == 1
    assert first.audio_path == second.audio_path
    assert Path(second.audio_path).is_file()


def test_cache_key_changes_when_profile_version_changes(tmp_path) -> None:
    cache = FileSpeechCache(tmp_path)
    first = VoiceProfile(uuid4(), "Ana", 1, "nano", "a" * 64).snapshot()
    second = VoiceProfile(first.profile_id, "Ana", 2, "nano", "a" * 64).snapshot()
    assert cache.cache_key(text="Hi", profile=first, parameters={}) != cache.cache_key(
        text="Hi", profile=second, parameters={}
    )
