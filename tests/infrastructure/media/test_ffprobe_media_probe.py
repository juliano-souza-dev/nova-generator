import pytest

from nova_generator.infrastructure.media.ffprobe_media_probe import FfprobeMediaProbe


def test_ffprobe_payload_extracts_duration_and_codecs() -> None:
    result = FfprobeMediaProbe._inspection_from_payload(
        {
            "format": {"duration": "12.345"},
            "streams": [
                {"codec_type": "video", "codec_name": "h264"},
                {"codec_type": "audio", "codec_name": "aac"},
            ],
        }
    )

    assert result.duration_ms == 12345
    assert result.video_codec == "h264"
    assert result.audio_codec == "aac"


def test_ffprobe_payload_without_video_is_rejected() -> None:
    with pytest.raises(ValueError, match="vídeo"):
        FfprobeMediaProbe._inspection_from_payload(
            {"format": {"duration": "1"}, "streams": []}
        )
