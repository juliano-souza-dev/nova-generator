import pytest

from nova_generator.domain.media.youtube import InvalidYoutubeUrl, YoutubeVideo


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ?t=12",
        "https://www.youtube.com/shorts/dQw4w9WgXcQ",
        "youtube.com/embed/dQw4w9WgXcQ",
    ],
)
def test_equivalent_youtube_urls_share_a_stable_identity(url: str) -> None:
    video = YoutubeVideo.from_url(url)

    assert video.video_id == "dQw4w9WgXcQ"
    assert video.canonical_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


@pytest.mark.parametrize("url", ["https://example.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/no"])
def test_invalid_youtube_urls_are_rejected(url: str) -> None:
    with pytest.raises(InvalidYoutubeUrl):
        YoutubeVideo.from_url(url)
