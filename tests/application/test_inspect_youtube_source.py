from nova_generator.application.use_cases.inspect_youtube_source import InspectYoutubeSource
from nova_generator.domain.media.youtube import YoutubeVideo


class CountingInspector:
    def __init__(self) -> None:
        self.calls = 0

    def inspect(self, video: YoutubeVideo):  # type: ignore[no-untyped-def]
        self.calls += 1
        return type(
            "Metadata",
            (),
            {"video": video, "title": "Literal: café?", "channel": "Canal"},
        )()


def test_inspection_is_reused_for_equivalent_urls_during_creation() -> None:
    inspector = CountingInspector()
    use_case = InspectYoutubeSource(inspector)

    first = use_case.execute("https://youtu.be/dQw4w9WgXcQ")
    second = use_case.execute("https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    assert first is second
    assert first.title == "Literal: café?"
    assert inspector.calls == 1
