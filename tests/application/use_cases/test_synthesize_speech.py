from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from nova_generator.application.ports.speech_synthesizer import PartialBatchSynthesisError
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



class BatchFakeSynthesizer:
    def __init__(self) -> None:
        self.calls = 0
        self.generated: list[str] = []

    def synthesize_many(self, *, profile, requests):
        self.calls += 1
        results = []
        for request in requests:
            text = request["text"]
            parameters = request["parameters"]
            output = Path(request["output"])
            output.write_bytes(b"RIFF fake chunk")
            self.generated.append(text)
            results.append(
                SynthesizedSpeech(
                    str(output),
                    sha256(text.encode("utf-8")).hexdigest(),
                    profile,
                    parameters,
                    900,
                    24000,
                    1,
                )
            )
        return results

    def synthesize(self, **_kwargs):
        raise AssertionError("The batch runner should be used for cache misses.")


def test_speech_chunks_are_cached_independently_by_text_language_and_profile(tmp_path) -> None:
    profile = VoiceProfile(
        uuid4(),
        "Voz bilíngue",
        1,
        "qwen3-tts-1.7b-voice-design",
        "a" * 64,
        parameters={"instruct": "Clear, natural, consistent voice."},
    ).snapshot()
    synthesizer = BatchFakeSynthesizer()
    cache = FileSpeechCache(tmp_path)
    use_case = SynthesizeSpeech(cache, synthesizer)
    chunks = [
        ("Good morning!", {"language": "English", "seed": 42}),
        ("Good morning!", {"language": "Portuguese", "seed": 42}),
        ("Good morning!", {"language": "English", "seed": 43}),
        ("Good morning!", {"language": "English", "seed": 42}),
    ]

    first = use_case.execute_many(segments=chunks, profile=profile)
    second = use_case.execute_many(segments=chunks, profile=profile)

    assert synthesizer.calls == 1
    assert synthesizer.generated == ["Good morning!"] * 3
    assert first[0].audio_path == first[3].audio_path
    assert first[0].audio_path != first[1].audio_path
    assert first[0].audio_path != first[2].audio_path
    assert second[0].audio_path == first[0].audio_path
    assert second[1].audio_path == first[1].audio_path
    assert cache.cache_key(
        text="Good morning!", profile=profile,
        parameters={"language": "English", "seed": 42},
    ) != cache.cache_key(
        text="Good morning!", profile=profile,
        parameters={"language": "Portuguese", "seed": 42},
    )



def test_successful_chunks_are_cached_when_a_batch_fails_midway(tmp_path) -> None:
    profile = VoiceProfile(
        uuid4(),
        "Voz bilíngue",
        1,
        "qwen3-tts-1.7b-voice-design",
        "a" * 64,
        parameters={"instruct": "Clear, natural, consistent voice."},
    ).snapshot()

    class ResumableBatchSynthesizer:
        def __init__(self) -> None:
            self.calls = 0
            self.generated: list[str] = []

        def synthesize_many(self, *, profile, requests):
            self.calls += 1
            if self.calls == 1:
                request = requests[0]
                output = Path(request["output"])
                output.write_bytes(b"RIFF first completed chunk")
                text = request["text"]
                speech = SynthesizedSpeech(
                    str(output),
                    sha256(text.encode("utf-8")).hexdigest(),
                    profile,
                    request["parameters"],
                    900,
                    24000,
                    1,
                )
                self.generated.append(text)
                raise PartialBatchSynthesisError("simulated second-chunk failure", [(0, speech)])

            results = []
            for request in requests:
                output = Path(request["output"])
                output.write_bytes(b"RIFF resumed chunk")
                text = request["text"]
                self.generated.append(text)
                results.append(
                    SynthesizedSpeech(
                        str(output),
                        sha256(text.encode("utf-8")).hexdigest(),
                        profile,
                        request["parameters"],
                        900,
                        24000,
                        1,
                    )
                )
            return results

    synthesizer = ResumableBatchSynthesizer()
    use_case = SynthesizeSpeech(FileSpeechCache(tmp_path), synthesizer)
    chunks = [
        ("First chunk.", {"language": "English", "seed": 42}),
        ("Second chunk.", {"language": "Portuguese", "seed": 42}),
    ]

    try:
        use_case.execute_many(segments=chunks, profile=profile)
    except PartialBatchSynthesisError:
        pass
    else:
        raise AssertionError("The first batch should report its simulated partial failure.")

    resumed = use_case.execute_many(segments=chunks, profile=profile)

    assert synthesizer.calls == 2
    assert synthesizer.generated == ["First chunk.", "Second chunk."]
    assert len(resumed) == 2
