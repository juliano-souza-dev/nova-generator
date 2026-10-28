"""Safe, deterministic ASS subtitle generation for vertical TikTok source clips."""

from __future__ import annotations

from nova_generator.domain.tiktok_media import MediaCaption, MediaCaptionStyle


def _ass_time(milliseconds: int) -> str:
    # ASS time resolution is centiseconds. Round to the nearest centisecond.
    total = (milliseconds + 5) // 10
    hours, rest = divmod(total, 360000)
    minutes, rest = divmod(rest, 6000)
    seconds, centiseconds = divmod(rest, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{centiseconds:02d}"


def _ass_color(value: str) -> str:
    return f"&H00{value[5:7]}{value[3:5]}{value[1:3]}&".upper()


def _literal(value: str) -> str:
    # ASS treats braces as override-tag delimiters; replacement with visually
    # close typographic braces ensures user-supplied text can never inject
    # rendering commands. The literal source remains intact in the snapshot.
    return (
        value.replace("\\", "＼")
        .replace("{", "｛")
        .replace("}", "｝")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", r"\N")
    )


def _highlighted(value: str, highlight: str, accent: str, base: str) -> str:
    if not highlight or highlight not in value:
        return _literal(value)
    prefix, suffix = value.split(highlight, 1)
    return (
        _literal(prefix)
        + rf"{{\c{accent}}}"
        + _literal(highlight)
        + rf"{{\c{base}}}"
        + _literal(suffix)
    )


def render_ass(captions: list[MediaCaption], style: MediaCaptionStyle) -> str:
    """Produce a 1080x1920 overlay preserving millisecond-based cue windows."""
    alignment = {"top": 8, "center": 5, "bottom": 2}[style.position]
    font_size = round((70 if style.template == "impact" else 58) * style.text_scale)
    margin_v = 225 if style.position != "center" else 0
    outline = 5 if style.template == "impact" else 3
    bold = -1 if style.template == "impact" else 0
    foreground = _ass_color(style.text_color)
    accent = "&H0000EFFF&" if style.template == "karaoke" else "&H0000D9FF&"
    translation = "&H00F4F4FA&"
    animation = {
        "none": "",
        "fade": r"{\fad(180,180)}",
        "pop": r"{\fscx(108)\fscy(108)\t(0,220,\fscx100\fscy100)}",
    }[style.animation]
    lines = [
        "[Script Info]",
        "Title: TikTok Media - Cut-relative captions",
        "ScriptType: v4.00+",
        "PlayResX: 1080",
        "PlayResY: 1920",
        "ScaledBorderAndShadow: yes",
        "WrapStyle: 0",
        "",
        "[V4+ Styles]",
        (
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding"
        ),
        (
            f"Style: Default,Arial,{font_size},{foreground},{accent},&H00202020&,"
            f"&H90000000&,{bold},0,0,0,100,100,0,0,1,{outline},1,"
            f"{alignment},70,70,{margin_v},1"
        ),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for caption in sorted(
        (item for item in captions if item.enabled), key=lambda item: item.start_ms
    ):
        english = _highlighted(caption.en, caption.highlight, accent, foreground)
        portuguese = _literal(caption.pt)
        text = animation + rf"{{\c{foreground}}}" + english + rf"\N{{\c{translation}}}" + portuguese
        if caption.note:
            text += rf"\N{{\fs{round(font_size * 0.7)}\c{accent}}}" + _literal(caption.note)
        lines.append(
            f"Dialogue: 0,{_ass_time(caption.start_ms)},{_ass_time(caption.end_ms)},"
            f"Default,,0,0,0,,{text}"
        )
    return "\n".join(lines) + "\n"
