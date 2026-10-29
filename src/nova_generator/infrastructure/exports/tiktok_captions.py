"""Safe, deterministic ASS subtitle generation for vertical TikTok source clips."""

from __future__ import annotations

import re

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


def _karaoke_words(value: str, duration_ms: int) -> str:
    """Reveal successive literal words over the cue window using ASS karaoke tags.

    Word durations are estimated from visible character counts because the
    TikTok caption contract currently records cue timing, not word timing.
    """
    words = re.findall(r"\s*\S+\s*", value)
    centiseconds = max(1, (duration_ms + 5) // 10)
    if not words or centiseconds < len(words):
        return _literal(value)
    weights = [max(1, len(word.strip())) for word in words]
    total_weight = sum(weights)
    consumed = 0
    result: list[str] = []
    cumulative_weight = 0
    for index, (word, weight) in enumerate(zip(words, weights, strict=True)):
        cumulative_weight += weight
        # Leave one centisecond for every remaining word.
        ideal_end = round(centiseconds * cumulative_weight / total_weight)
        end = min(centiseconds - (len(words) - index - 1), max(consumed + 1, ideal_end))
        result.append(rf"{{\kf{end - consumed}}}" + _literal(word))
        consumed = end
    return "".join(result)


def render_ass(captions: list[MediaCaption], style: MediaCaptionStyle, paper_theme: str | None = None) -> str:
    """Render video effects using ASS so the exported MP4 matches the editor."""
    template = style.template
    alignment = {"top": 8, "center": 5, "bottom": 2}[style.position]
    sizes = {"clean": 58, "impact": 70, "karaoke": 90,
             "handwriting": 82, "neon": 78, "popstar": 88, "cinema": 63}
    font_size = round(sizes[template] * style.text_scale)
    margin_v = 225 if style.position != "center" else 0
    outline = {"impact": 5, "neon": 6, "popstar": 5, "handwriting": 2}.get(template, 3)
    bold = -1 if template in {"impact", "karaoke", "neon", "popstar"} else 0
    font = ("Comic Sans MS" if template == "handwriting"
            else "Georgia" if template == "cinema" else "Arial")
    ink_color = "#233043" if paper_theme in {"cream", "kraft"} and style.text_color.upper() == "#FFFFFF" else style.text_color
    foreground = _ass_color(ink_color)
    accent = ("&H00FFE57D&" if template == "neon"
              else "&H0000C8FF&" if template in {"karaoke", "handwriting", "popstar"}
              else "&H0000D9FF&")
    outline_color = "&H00904738&" if template == "neon" else "&H00202020&"
    translation = "&H004C3829&" if paper_theme in {"cream", "kraft"} else "&H00F4F4FA&"
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
            f"Style: Default,{font},{font_size},{foreground},{accent},{outline_color},"
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
        start = _ass_time(caption.start_ms)
        end = _ass_time(caption.end_ms)
        duration = caption.end_ms - caption.start_ms
        event = f"Dialogue: 0,{start},{end},Default,,0,0,0,,"
        if template == "handwriting":
            # Smooth left-to-right clipping simulates pencil lettering.
            # ASS/libass substitutes the handwritten font when unavailable.
            reveal = max(100, min(3000, round(duration * 0.8)))
            y = {"top": 280, "center": 935, "bottom": 1575}[style.position]
            x_start, x_end = 90, 990
            drawing = (
                rf"{{\an5\pos(540,{y})\clip({x_start},0,{x_start},1920)"
                rf"\t(0,{reveal},\clip({x_start},0,{x_end},1920))}}"
                + _literal(caption.en)
            )
            lines.append(event + drawing)
            pencil = (
                rf"{{\an5\fs60\bord2\c{accent}"
                rf"\move({x_start},{y + 58},{x_end},{y + 58},0,{reveal})}}✎"
            )
            # Pencil stops when the written sentence has appeared.
            lines.append(f"Dialogue: 1,{start},{_ass_time(caption.start_ms + reveal)},"
                         f"Default,,0,0,0,,{pencil}")
            if caption.pt:
                lines.append(
                    event + rf"{{\an5\pos(540,{y + round(font_size * 1.25)})"
                    rf"\fs{round(font_size * 0.68)}\c{translation}}}"
                    + _literal(caption.pt)
                )
            if caption.note:
                lines.append(
                    event + rf"{{\an5\pos(540,{y + round(font_size * 2.05)})"
                    rf"\fs{round(font_size * 0.52)}\c{accent}}}"
                    + _literal(caption.note)
                )
            continue

        karaoke = template == "karaoke"
        english = (
            _karaoke_words(caption.en, duration) if karaoke
            else _highlighted(caption.en, caption.highlight, accent, foreground)
        )
        override = ""
        if template == "neon":
            override = rf"{{\blur4\bord6\3c{outline_color}\t(0,{max(1, duration // 2)},\fscx106\fscy106)\t({max(1, duration // 2)},{duration},\fscx100\fscy100)}}"
        elif template == "popstar":
            override = (rf"{{\frz-3\fscx118\fscy118\3c&H008200AE&"
                        rf"\t(0,260,\frz0\fscx100\fscy100)}}")
        elif template == "cinema":
            override = r"{\fsp2\fad(320,320)}"
        color_override = rf"{{\c{accent}\2c{foreground}}}" if karaoke else rf"{{\c{foreground}}}"
        text = animation + override + color_override + english
        if caption.pt:
            text += (
                rf"\N{{\fs{round(font_size * 0.68)}\c{translation}\2c{translation}}}"
                if karaoke or template == "popstar"
                else rf"\N{{\c{translation}}}"
            ) + _literal(caption.pt)
        if caption.note:
            text += rf"\N{{\fs{round(font_size * 0.7)}\c{accent}}}" + _literal(caption.note)
        lines.append(event + text)
    return "\n".join(lines) + "\n"
