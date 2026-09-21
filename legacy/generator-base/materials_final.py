from __future__ import annotations

import copy
import html
import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


Progress = Callable[[int, str], None]
INK = colors.HexColor("#1D2321")
MUTED = colors.HexColor("#5B6460")
TEAL = colors.HexColor("#2F6F62")
LINE = colors.HexColor("#E2E0D6")
SOFT = colors.HexColor("#F6F5F0")
WHITE = colors.white


def _ass_time(ms: int) -> str:
    value = max(0, int(ms)); hours, value = divmod(value, 3600000); minutes, value = divmod(value, 60000); seconds, value = divmod(value, 1000)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{value // 10:02d}"


def _ass_text(value: Any) -> str:
    return str(value or "").replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}").replace("\n", r"\N")


def _write_dual_scene_ass(canonical: dict[str, Any], block_start: int, block_end: int, path: Path) -> None:
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: WbW,Arial,52,&H00FFFFFF,&H00FFFFFF,&H00101010,&H99000000,-1,0,0,0,100,100,0,0,3,2,0,2,96,96,420,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events: list[str] = []
    for cue in canonical.get("cues") or []:
        if not isinstance(cue, dict): continue
        words = [word for word in (cue.get("words") or []) if isinstance(word, dict)]
        if not words: continue
        cue_start = max(block_start, int(cue.get("speech_start_ms") or 0)); cue_end = min(block_end, int(cue.get("speech_end_ms") or 0))
        if cue_end <= cue_start: continue
        boundaries = {cue_start, cue_end}
        for word in words:
            boundaries.add(max(cue_start, min(cue_end, int(word.get("start_ms") or 0))))
            boundaries.add(max(cue_start, min(cue_end, int(word.get("end_ms") or 0))))
        ordered = sorted(boundaries)
        for start, end in zip(ordered, ordered[1:]):
            if end <= start: continue
            midpoint = (start + end) // 2
            active = next((index for index, word in enumerate(words) if int(word.get("start_ms") or 0) <= midpoint < int(word.get("end_ms") or 0)), -1)
            rendered = []
            for index, item in enumerate(words):
                text = _ass_text(item.get("text"))
                rendered.append((r"{\c&H55E6AA&}" + text + r"{\c&HFFFFFF&}") if index == active else text)
            events.append(f"Dialogue: 0,{_ass_time(start-block_start)},{_ass_time(end-block_start)},WbW,,0,0,0,,{' '.join(rendered)}")
    path.write_text(header + "\n".join(events) + "\n", encoding="utf-8-sig")


def render_dual_scene_video(canonical: dict[str, Any], en_video: Path, pt_video: Path, output: Path) -> None:
    blocks = canonical.get("dualScene") if isinstance(canonical.get("dualScene"), list) else []
    if not blocks: raise RuntimeError("Dual Scene não contém blocos finalizados.")
    if not en_video.is_file() or not pt_video.is_file(): raise RuntimeError("Vídeos EN/PT do Dual Scene não foram encontrados.")
    if shutil.which("ffmpeg") is None: raise RuntimeError("FFmpeg não encontrado.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="generator_dual_") as temp_name:
        temp = Path(temp_name); parts: list[Path] = []; part_durations: list[float] = []
        for index, block in enumerate(blocks, start=1):
            en = block.get("en") if isinstance(block.get("en"), dict) else {}; pt = block.get("pt") if isinstance(block.get("pt"), dict) else {}
            for language, source, timing in (("en", en_video, en), ("pt", pt_video, pt)):
                start = int(timing.get("start_ms") or 0); end = int(timing.get("end_ms") or 0); duration = end - start
                if duration <= 0: raise RuntimeError(f"Bloco {index} {language.upper()} possui duração inválida.")
                part = temp / f"{index:03d}_{language}.mp4"
                filters = ["scale=1080:1920:force_original_aspect_ratio=increase", "crop=1080:1920", "setsar=1", "fps=30"]
                if language == "en":
                    ass = temp / f"{index:03d}.ass"; _write_dual_scene_ass(canonical, start, end, ass)
                    escaped = str(ass).replace("\\", "/").replace(":", r"\:").replace("'", r"\'")
                    filters.append(f"subtitles='{escaped}'")
                command = ["ffmpeg","-hide_banner","-loglevel","error","-y","-ss",f"{start/1000:.3f}","-i",str(source),"-t",f"{duration/1000:.3f}","-vf",",".join(filters),"-af","aresample=48000","-c:v","libx264","-preset","veryfast","-crf","20","-c:a","aac","-ar","48000","-ac","2","-movflags","+faststart",str(part)]
                completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
                if completed.returncode: raise RuntimeError(f"Falha ao renderizar bloco {index} {language.upper()}: {completed.stderr.strip()}")
                parts.append(part); part_durations.append(duration/1000)
        transition=.067
        command=["ffmpeg","-hide_banner","-loglevel","error","-y"]
        for part in parts: command.extend(["-i",str(part)])
        graph=[]; cumulative=part_durations[0]; video_label="0:v"; audio_label="0:a"
        for part_index in range(1,len(parts)):
            offset=max(0,cumulative-transition); next_video=f"v{part_index}"; next_audio=f"a{part_index}"
            graph.append(f"[{video_label}][{part_index}:v]xfade=transition=fadefast:duration={transition:.3f}:offset={offset:.3f}[{next_video}]")
            graph.append(f"[{audio_label}][{part_index}:a]acrossfade=d={transition:.3f}:c1=tri:c2=tri[{next_audio}]")
            video_label=next_video; audio_label=next_audio; cumulative+=part_durations[part_index]-transition
        command.extend(["-filter_complex",";".join(graph),"-map",f"[{video_label}]","-map",f"[{audio_label}]","-c:v","libx264","-preset","veryfast","-crf","20","-c:a","aac","-movflags","+faststart",str(output)])
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if completed.returncode: raise RuntimeError(f"Falha ao unir os blocos Dual Scene: {completed.stderr.strip()}")


def _media_duration_ms(path: Path) -> int:
    completed = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if completed.returncode: raise RuntimeError(f"Não foi possível ler a duração de {path.name}.")
    return max(1,round(float(completed.stdout.strip())*1000))


def render_music_video(canonical: dict[str, Any], source_video: Path, output: Path) -> None:
    from music_video import render_music_lyrics_video
    render_music_lyrics_video(canonical, source_video, output)


def _write_shadowing_ass(canonical: dict[str, Any], block: dict[str, Any], path: Path) -> None:
    """Build the bilingual listening captions and EN repeat card used by the preview."""
    start = int(block.get("start_ms") or 0)
    end = int(block.get("end_ms") or block.get("pause_at_ms") or 0)
    speech_duration = max(1, end - start)
    pause_duration = max(1, int(block.get("pause_duration_ms") or 0))
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: EN,Arial,54,&H00FFFFFF,&H00FFFFFF,&H00101010,&H99000000,-1,0,0,0,100,100,0,0,3,2,0,2,90,90,390,1
Style: PT,Arial,42,&H00E4C98C,&H00E4C98C,&H00101010,&H99000000,-1,0,0,0,100,100,0,0,3,2,0,2,90,90,315,1
Style: Repeat,Arial,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,110,110,0,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    cue_orders = {int(value) for value in (block.get("cue_orders") or [])}
    events: list[str] = []
    repeat_text: list[str] = []
    for cue in (canonical.get("cues") or []):
        if not isinstance(cue, dict):
            continue
        order = int(cue.get("order") or 0)
        cue_start = max(start, int(cue.get("speech_start_ms") or cue.get("subtitle_start_ms") or 0))
        cue_end = min(end, int(cue.get("speech_end_ms") or cue.get("subtitle_end_ms") or 0))
        if cue_end <= cue_start or (cue_orders and order not in cue_orders):
            continue
        en = _ass_text(cue.get("approved_en") or cue.get("original_en") or cue.get("en") or cue.get("text_en") or "")
        pt = _ass_text(cue.get("approved_pt") or cue.get("pt") or cue.get("text_pt") or cue.get("translation") or "")
        if en:
            events.append(f"Dialogue: 0,{_ass_time(cue_start-start)},{_ass_time(cue_end-start)},EN,,0,0,0,,{en}")
            repeat_text.append(en)
        if pt:
            events.append(f"Dialogue: 0,{_ass_time(cue_start-start)},{_ass_time(cue_end-start)},PT,,0,0,0,,{pt}")
    if repeat_text:
        events.append(f"Dialogue: 1,{_ass_time(speech_duration)},{_ass_time(speech_duration+pause_duration)},Repeat,,0,0,0,," + r"{\an5}" + r"\N".join(repeat_text))
    path.write_text(header + "\n".join(events) + "\n", encoding="utf-8-sig")


def render_shadowing_video(canonical: dict[str, Any], shadowing_plan: dict[str, Any], source_video: Path, output: Path) -> None:
    """Render included Shadowing blocks, their repeat pauses, and nothing outside them."""
    blocks = [block for block in (shadowing_plan.get("blocks") or []) if isinstance(block, dict)]
    if not blocks:
        raise RuntimeError("Shadowing não contém blocos finalizados.")
    if not source_video.is_file():
        raise RuntimeError("Vídeo fonte do Shadowing não foi encontrado.")
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("FFmpeg não encontrado.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="generator_shadowing_") as temp_name:
        temp = Path(temp_name)
        parts: list[Path] = []
        for index, block in enumerate(blocks, start=1):
            start = int(block.get("start_ms") or 0)
            end = int(block.get("end_ms") or block.get("pause_at_ms") or 0)
            speech_duration = end - start
            pause_duration = max(1, int(block.get("pause_duration_ms") or 0))
            if speech_duration <= 0:
                raise RuntimeError(f"Bloco {index} do Shadowing possui duração inválida.")
            speech_seconds = speech_duration / 1000
            pause_seconds = pause_duration / 1000
            total_seconds = speech_seconds + pause_seconds
            ass = temp / f"{index:03d}.ass"
            part = temp / f"{index:03d}.mp4"
            _write_shadowing_ass(canonical, block, ass)
            escaped = str(ass).replace("\\", "/").replace(":", r"\:").replace("'", r"\'")
            video_filter = (
                "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,"
                f"tpad=stop_mode=clone:stop_duration={pause_seconds:.3f},"
                f"drawbox=color=black@0.90:t=fill:enable='gte(t,{speech_seconds:.3f})',"
                f"subtitles='{escaped}'"
            )
            command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start/1000:.3f}", "-t", f"{speech_seconds:.3f}", "-i", str(source_video), "-vf", video_filter, "-af", f"aresample=48000,apad=pad_dur={pause_seconds:.3f}", "-map", "0:v:0", "-map", "0:a:0", "-t", f"{total_seconds:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(part)]
            completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
            if completed.returncode:
                raise RuntimeError(f"Falha ao renderizar bloco {index} do Shadowing: {completed.stderr.strip()}")
            parts.append(part)
        concat_file = temp / "parts.txt"
        concat_file.write_text("".join(f"file '{part.as_posix()}'\n" for part in parts), encoding="utf-8")
        completed = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", "-movflags", "+faststart", str(output)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if completed.returncode:
            raise RuntimeError(f"Falha ao unir os blocos do Shadowing: {completed.stderr.strip()}")


def _esc(value: Any) -> str:
    return html.escape(str(value or "")).replace("\n", "<br/>")


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "brand": ParagraphStyle("brand", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=16, leading=18, textColor=TEAL),
        "title": ParagraphStyle("title", parent=base["Title"], fontName="Helvetica-Bold", fontSize=27, leading=32, textColor=INK),
        "subtitle": ParagraphStyle("subtitle", parent=base["BodyText"], fontName="Helvetica", fontSize=12, leading=18, textColor=MUTED),
        "motto": ParagraphStyle("motto", parent=base["BodyText"], fontName="Helvetica-BoldOblique", fontSize=13, leading=19, textColor=TEAL),
        "h1": ParagraphStyle("h1", parent=base["Heading1"], fontName="Helvetica-Bold", fontSize=19, leading=23, textColor=TEAL, spaceBefore=8, spaceAfter=9),
        "h2": ParagraphStyle("h2", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=INK, spaceBefore=5, spaceAfter=5),
        "body": ParagraphStyle("body", parent=base["BodyText"], fontName="Helvetica", fontSize=10.7, leading=15.5, textColor=INK, spaceAfter=6),
        "small": ParagraphStyle("small", parent=base["BodyText"], fontName="Helvetica", fontSize=8.8, leading=12, textColor=MUTED, spaceAfter=4),
        "en": ParagraphStyle("en", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=11.3, leading=16, textColor=INK, spaceAfter=2),
        "pt": ParagraphStyle("pt", parent=base["BodyText"], fontName="Helvetica", fontSize=10, leading=14.5, textColor=MUTED, spaceAfter=3),
        "day": ParagraphStyle("day", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=INK, spaceBefore=6, spaceAfter=4),
    }


def _doc(path: Path, title: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(path), pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=20 * mm, bottomMargin=20 * mm,
        title=title,
    )

    def footer(canvas, document):
        canvas.saveState()
        canvas.setStrokeColor(LINE)
        canvas.line(20 * mm, 14 * mm, 190 * mm, 14 * mm)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(20 * mm, 9 * mm, "ImmersionHub · Study Workbook")
        canvas.drawRightString(190 * mm, 9 * mm, str(document.page))
        canvas.restoreState()

    return doc, footer


def _cover(st: dict[str, ParagraphStyle], source_title: str, objective: str = "") -> list[Any]:
    brand = Table([
        [Paragraph("IH", ParagraphStyle("brandMark", parent=st["brand"], fontSize=19, leading=20, textColor=WHITE, alignment=1)),
         Paragraph("IMMERSIONHUB", st["brand"])],
    ], colWidths=[14 * mm, 58 * mm], rowHeights=[14 * mm])
    brand.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), TEAL),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (0, 0), 0), ("RIGHTPADDING", (0, 0), (0, 0), 0),
        ("TOPPADDING", (0, 0), (0, 0), 0), ("BOTTOMPADDING", (0, 0), (0, 0), 0),
        ("LEFTPADDING", (1, 0), (1, 0), 4 * mm),
    ]))
    return [
        Spacer(1, 18 * mm), brand, Spacer(1, 25 * mm),
        Paragraph("Immersion Workbook", st["title"]), Spacer(1, 5 * mm),
        Paragraph("One workbook. One study flow. Practice first.", st["subtitle"]),
        Spacer(1, 18 * mm),
        Paragraph(_esc(source_title or "Immersion Kit"), st["h2"]),
        *([Spacer(1, 5 * mm), _box(st, objective)] if objective else []),
        Spacer(1, 22 * mm),
        Paragraph("Less time preparing. More time actually practicing.", st["motto"]),
        Spacer(1, 4 * mm),
        Paragraph("Conteúdo pedagógico revisado antes da renderização final.", st["small"]),
        PageBreak(),
    ]


def _box(st: dict[str, ParagraphStyle], text: str) -> Table:
    table = Table([[Paragraph(_esc(text), st["body"])]], colWidths=[166 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SOFT),
        ("BOX", (0, 0), (-1, -1), .6, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 4 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3 * mm),
    ]))
    return table


def _section(st: dict[str, ParagraphStyle], number: int, title: str, subtitle: str = "") -> list[Any]:
    rows: list[Any] = [Paragraph(f"{number}. {_esc(title)}", st["h1"])]
    if subtitle:
        rows.append(Paragraph(_esc(subtitle), st["small"]))
    rows.append(Spacer(1, 2 * mm))
    return rows


def _render_final_challenge(st: dict[str, ParagraphStyle], value: Any) -> list[Any]:
    if isinstance(value, dict):
        rows: list[Any] = []
        prompt = str(value.get("prompt") or "").strip()
        if prompt:
            rows.append(Paragraph(_esc(prompt), st["body"]))
        connectors = value.get("connectors") if isinstance(value.get("connectors"), list) else []
        if connectors:
            rows.append(Paragraph("<b>Connectors:</b> " + _esc(" · ".join(str(x) for x in connectors)), st["body"]))
        tip = str(value.get("recordingTip") or value.get("recording_tip") or "").strip()
        if tip:
            rows.append(Paragraph("<b>Recording tip:</b> " + _esc(tip), st["body"]))
        return rows
    text = str(value or "").strip()
    return [Paragraph(_esc(text), st["body"])] if text else []


def render_immersion_workbook(content: dict[str, Any], cards: list[dict[str, Any]], path: Path, source_title: str) -> None:
    """Render cover + exactly seven content blocks in the user-defined order."""
    st=_styles(); doc,footer=_doc(path,f"{source_title} - ImmersionHub Workbook")
    objective=str(content.get("kit_objective") or "").strip()
    story:list[Any]=_cover(st,source_title,objective)
    how_to=content.get("how_to_study") if isinstance(content.get("how_to_study"),dict) else {}
    diagnostic=content.get("day_5_diagnostic") if isinstance(content.get("day_5_diagnostic"),dict) else {}
    connected=content.get("connected_speech") if isinstance(content.get("connected_speech"),dict) else {}
    cs_practice=content.get("connected_speech_practice") if isinstance(content.get("connected_speech_practice"),dict) else {}
    structures=content.get("structures_from_scene") if isinstance(content.get("structures_from_scene"),dict) else {}
    activities=content.get("activities") if isinstance(content.get("activities"),dict) else {}
    finalization=content.get("finalization") if isinstance(content.get("finalization"),dict) else {}

    # 1. How To Study — always first after cover.
    story += _section(st,1,"How To Study","Fluxo prático do ImmersionHub.")
    intro=str(how_to.get("intro") or "").strip()
    if intro: story += [_box(st,intro),Spacer(1,4*mm)]
    for row in (how_to.get("days") or []):
        if not isinstance(row,dict): continue
        story.append(Paragraph(f"DIA {_esc(row.get('day'))} · {_esc(row.get('title'))}",st["day"]))
        for number,step in enumerate(row.get("steps") if isinstance(row.get("steps"),list) else [],1):
            story.append(Paragraph(f"<b>{number}.</b> {_esc(step)}",st["body"]))
        story.append(Spacer(1,3*mm))

    # 2. Day 5 — Diagnostic.
    story += [PageBreak()]
    story += _section(st,2,"Day 5 — Diagnostic","Meça o que você consegue fazer sem transformar o diagnóstico em outra aula.")
    if diagnostic.get("intro"): story.append(_box(st,str(diagnostic.get("intro"))))
    for index,row in enumerate(diagnostic.get("checks") if isinstance(diagnostic.get("checks"),list) else [],1):
        if not isinstance(row,dict): continue
        story.append(Paragraph(f"CHECK {index} · {_esc(row.get('title'))}",st["h2"]))
        story.append(Paragraph(_esc(row.get("instruction")),st["body"]))
        orders=row.get("cue_orders") if isinstance(row.get("cue_orders"),list) else []
        if orders: story.append(Paragraph("Cues: "+_esc(", ".join(str(v) for v in orders)),st["small"]))
        story.append(Paragraph("□ Consegui sem apoio",st["body"]))
        story.append(Paragraph(f"<b>Critério:</b> {_esc(row.get('success_criteria'))}",st["small"]))
    if diagnostic.get("self_assessment"):
        story += [Paragraph("Self-assessment",st["h2"]),_box(st,str(diagnostic.get("self_assessment")))]

    # 3. Connected Speech — explanation only.
    story += [PageBreak()]
    story += _section(st,3,"Connected Speech","Percepção do que realmente foi aprovado no áudio. Connected Speech é PDF-only.")
    cs_items=connected.get("items") if isinstance(connected.get("items"),list) else []
    if not cs_items:
        story.append(Paragraph("Nenhum fenômeno de Connected Speech foi aprovado para este kit.",st["body"]))
    for index,item in enumerate(cs_items,1):
        if not isinstance(item,dict): continue
        source=str(item.get("source_text") or item.get("cue_en") or "").strip(); heard=str(item.get("heard_as") or "").strip()
        story.append(Paragraph(f"CS {index} · {_esc(str(item.get('type') or '').upper())}",st["small"]))
        if source: story += [Paragraph("SOURCE",st["h2"]),Paragraph(_esc(source),st["en"])]
        if heard: story.append(_box(st,"HEAR IT AS: "+heard))
        if item.get("explanation_pt"): story.append(Paragraph(_esc(item.get("explanation_pt")),st["body"]))
        if item.get("learner_note"): story.append(Paragraph(_esc(item.get("learner_note")),st["body"]))
        if source:
            url="https://youglish.com/pronounce/"+quote(source,safe="")+"/english"
            story.append(Paragraph(f'<link href="{url}" color="#2F6F62"><u>Ouvir mais exemplos no YouGlish</u></link>',st["body"]))
        story.append(Spacer(1,5*mm))

    # 4. Connected Speech — Practice — practice only.
    story += [PageBreak()]
    story += _section(st,4,"Connected Speech — Practice","Listen → Notice → Repeat. Volte ao áudio original no final de cada drill.")
    practice_by_seq={int(row.get("sequence_order") or 0):row for row in (cs_practice.get("items") or []) if isinstance(row,dict)}
    cs_by_seq={int(row.get("sequence_order") or 0):row for row in cs_items if isinstance(row,dict)}
    if not practice_by_seq:
        story.append(Paragraph("Sem prática de Connected Speech para este kit.",st["body"]))
    for index,seq in enumerate(sorted(practice_by_seq),1):
        row=practice_by_seq[seq]; source=cs_by_seq.get(seq,{})
        story.append(Paragraph(f"PRACTICE {index}",st["h2"]))
        if source.get("source_text"): story.append(Paragraph(_esc(source.get("source_text")),st["en"]))
        for label in ("LISTEN","NOTICE","REPEAT"):
            story.append(Paragraph(label,st["small"]))
            if label=="LISTEN": story.append(Paragraph("Ouça uma vez sem repetir.",st["body"]))
            elif label=="NOTICE": story.append(Paragraph(_esc(source.get("heard_as") or source.get("explanation_pt") or "Perceba a mudança no fluxo da fala."),st["body"]))
            else:
                for n,step in enumerate(row.get("drill_steps") if isinstance(row.get("drill_steps"),list) else [],1):
                    story.append(Paragraph(f"<b>{n}.</b> {_esc(step)}",st["body"]))
        if row.get("practice_tip"): story.append(Paragraph(f"<b>Dica:</b> {_esc(row.get('practice_tip'))}",st["body"]))
        story.append(Paragraph("□ Repeti com o áudio original",st["body"]))
        story.append(Spacer(1,5*mm))

    # 5. Structures From This Scene.
    story += [PageBreak()]
    story += _section(st,5,"Structures From This Scene","Estruturas realmente presentes na cena, seguidas de novos contextos e Make It Yours.")
    for index,item in enumerate(structures.get("items") if isinstance(structures.get("items"),list) else [],1):
        if not isinstance(item,dict): continue
        story.append(Paragraph(_esc(item.get("title") or f"Structure {index}"),st["h2"]))
        if item.get("pattern"): story.append(_box(st,str(item.get("pattern"))))
        if item.get("explanation_pt"): story.append(Paragraph(_esc(item.get("explanation_pt")),st["body"]))
        orders=item.get("cue_orders") if isinstance(item.get("cue_orders"),list) else []
        if orders: story.append(Paragraph("From this scene · cues "+_esc(", ".join(str(v) for v in orders)),st["small"]))
        contexts=item.get("new_contexts") if isinstance(item.get("new_contexts"),list) else []
        if contexts: story.append(Paragraph("New contexts",st["h2"]))
        for ctx in contexts:
            if not isinstance(ctx,dict): continue
            story.append(Paragraph(_esc(ctx.get("en")),st["en"])); story.append(Paragraph(_esc(ctx.get("pt")),st["pt"]))
        if item.get("make_it_yours"):
            story += [Paragraph("Make It Yours",st["h2"]),_box(st,str(item.get("make_it_yours")))]
        story.append(Spacer(1,5*mm))

    # 6. Activities — exact activity set requested.
    story += [PageBreak()]
    story += _section(st,6,"Activities","Faça primeiro; consulte o self-check somente depois.")
    if activities.get("intro"): story.append(Paragraph(_esc(activities.get("intro")),st["body"]))
    answers=[]
    groups=[
        ("Listening Reconstruction","listening_reconstruction","answer"),
        ("Connected Speech Hunt","connected_speech_hunt","answer"),
        ("Vocabulary Recall · Linha a Linha","vocabulary_recall","answer"),
    ]
    for label,key,answer_key in groups:
        rows=activities.get(key) if isinstance(activities.get(key),list) else []
        if not rows: continue
        story.append(Paragraph(label,st["h2"]))
        for index,row in enumerate(rows,1):
            if not isinstance(row,dict): continue
            story.append(Paragraph(f"<b>{index}.</b> {_esc(row.get('prompt'))}",st["body"]))
            answers.append((label,index,str(row.get(answer_key) or "")))
    transfers=activities.get("structure_transfer") if isinstance(activities.get("structure_transfer"),list) else []
    if transfers: story.append(Paragraph("Structure Transfer",st["h2"]))
    for index,row in enumerate(transfers,1):
        if not isinstance(row,dict): continue
        story.append(Paragraph(f"<b>{index}.</b> {_esc(row.get('prompt'))}",st["body"]))
        story.append(Paragraph("Escreva 2–3 frases originais:",st["small"]))
        story += [Paragraph("1. ______________________________________________",st["body"]),Paragraph("2. ______________________________________________",st["body"]),Paragraph("3. ______________________________________________",st["body"])]
        answers.append(("Structure Transfer",index," | ".join(str(v) for v in (row.get("model_answers") or []))))
    shadow=activities.get("shadowing_challenge") if isinstance(activities.get("shadowing_challenge"),dict) else {}
    if shadow:
        story += [Paragraph("Shadowing Challenge",st["h2"]),Paragraph(_esc(shadow.get("prompt")),st["body"]),Paragraph(f"<b>Meta:</b> {_esc(shadow.get('success_criteria'))}",st["small"])]
    final=activities.get("final_listening") if isinstance(activities.get("final_listening"),dict) else {}
    if final:
        story += [Paragraph("Final Listening · sem legendas",st["h2"]),Paragraph(_esc(final.get("prompt")),st["body"]),Paragraph("Registro de compreensão",st["small"]),_box(st,str(final.get("comprehension_record")))]
    if answers:
        story += [PageBreak(),Paragraph("Activities · Self-check",st["h1"])]
        for label,index,answer in answers:
            story.append(Paragraph(f"<b>{_esc(label)} {index}:</b> {_esc(answer)}",st["body"]))

    # 7. Finalization — last block, no new lesson content.
    story += [PageBreak()]
    story += _section(st,7,"Finalization","Feche o ciclo e deixe claro o que precisa continuar em revisão.")
    if finalization.get("title"): story.append(Paragraph(_esc(finalization.get("title")),st["h2"]))
    for item in finalization.get("checklist") if isinstance(finalization.get("checklist"),list) else []:
        story.append(Paragraph("□ "+_esc(item),st["body"]))
    if finalization.get("reflection_prompt"):
        story += [Paragraph("Reflection",st["h2"]),_box(st,str(finalization.get("reflection_prompt")))]
    if finalization.get("next_review"):
        story += [Paragraph("Next review",st["h2"]),Paragraph(_esc(finalization.get("next_review")),st["body"])]

    doc.build(story,onFirstPage=footer,onLaterPages=footer)


def _anki_source(canonical: dict[str, Any], cards: list[dict[str, Any]], path: Path) -> None:
    by_order: dict[int, list[dict[str, Any]]] = {}
    for raw in cards:
        if not isinstance(raw, dict): continue
        try: order = int(raw.get("cue_order") or 0)
        except (TypeError, ValueError): continue
        if order > 0: by_order.setdefault(order, []).append(dict(raw))
    cues = []
    for cue in canonical.get("cues") or []:
        if not isinstance(cue, dict): continue
        order = int(cue.get("order") or 0); items = by_order.get(order) or []
        if not items: continue
        cues.append({
            "order": order,
            "start": int(cue.get("speech_start_ms") or 0) / 1000.0,
            "end": int(cue.get("speech_end_ms") or 0) / 1000.0,
            "speaker": "",
            "en": str(cue.get("approved_en") or cue.get("original_en") or ""),
            "pt": str(cue.get("pt") or ""),
            "anki": {"include": True, "items": items},
        })
    path.write_text(json.dumps({"cues": cues}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")



def _clean_final_words(words: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    previous_start: int | None = None
    if not isinstance(words, list):
        return result
    for raw in words:
        if not isinstance(raw, dict):
            continue
        item = copy.deepcopy(raw)
        try:
            start_ms = int(item.get("start_ms"))
            end_ms = int(item.get("end_ms"))
        except (TypeError, ValueError):
            start_ms = end_ms = -1
        if start_ms >= 0 and end_ms >= start_ms:
            # Keep the approved lexical order. Some aligners return overlapping
            # word starts in reverse order; the HUB contract requires monotonic
            # start_ms values even when the audible ranges overlap.
            # The HUB importer requires a deterministic chronological order.
            # Equal starts are ambiguous there, so keep lexical order with the
            # smallest possible correction (1 ms) when ranges overlap/reverse.
            minimum_start = previous_start + 1 if previous_start is not None else start_ms
            normalized_start = max(start_ms, minimum_start)
            item["start_ms"] = normalized_start
            item["end_ms"] = max(end_ms, normalized_start + 1)
            previous_start = normalized_start
        # Campo de undo/editor: nunca deve sair no JSON publicado para o HUB.
        item.pop("pt_group_original_pt", None)
        group = str(item.get("pt_group") or "").strip()
        role = str(item.get("pt_group_role") or "").strip()
        if not group:
            item.pop("pt_group", None)
            item.pop("pt_group_role", None)
        elif role == "member":
            item["pt"] = None
        result.append(item)
    return result


def _hub_material_manifest(pdfs: dict[str, Any], has_cards: bool) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    if "immersion_workbook" in pdfs:
        items.append({"label": "ImmersionHub Workbook", "type": "PDF", "fileName": "01_immersionhub_workbook.pdf"})
    if has_cards:
        items.extend([
            {"label": "Anki sem áudio", "type": "APKG", "fileName": "02_anki_sem_audio.apkg"},
            {"label": "Anki · Diana", "type": "APKG", "fileName": "03_anki_diana.apkg"},
            {"label": "Anki · Hannah", "type": "APKG", "fileName": "04_anki_hannah.apkg"},
            {"label": "Anki · Troy", "type": "APKG", "fileName": "05_anki_troy.apkg"},
            {"label": "Anki · Austin", "type": "APKG", "fileName": "06_anki_austin.apkg"},
        ])
    return items


def _expand_transport_cue_to_words(cue: dict[str, Any]) -> None:
    """Make the HUB cue contain its WbW timing without altering any word."""
    words = [word for word in (cue.get("words") or []) if isinstance(word, dict)]
    timed: list[tuple[int, int]] = []
    for word in words:
        try:
            start = int(word.get("start_ms"))
            end = int(word.get("end_ms"))
        except (TypeError, ValueError):
            continue
        if start >= 0 and end > start:
            timed.append((start, end))
    if not timed:
        return
    word_start = min(start for start, _end in timed)
    word_end = max(end for _start, end in timed)
    try:
        cue_start = int(cue.get("speech_start_ms"))
    except (TypeError, ValueError):
        cue_start = word_start
    try:
        cue_end = int(cue.get("speech_end_ms"))
    except (TypeError, ValueError):
        cue_end = word_end
    cue["speech_start_ms"] = min(cue_start, word_start)
    cue["speech_end_ms"] = max(cue_end, word_end)


def _practice_token(value: Any) -> str:
    """Normalize display punctuation without changing lexical word order."""
    return "".join(re.findall(r"[\w]+", str(value or "").casefold(), flags=re.UNICODE))


def _align_wbw_practices_to_current_words(
    practices: list[Any], cues: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Anchor AI-authored practice metadata to the human-reviewed WbW timing.

    Practice timestamps are suggestions from the early one-pass response. Cue and
    word timing can subsequently be edited, so the final transport must derive
    the range from the current words that spell the approved expression.
    """
    cue_map = {int(cue.get("order") or 0): cue for cue in cues if isinstance(cue, dict)}
    aligned: list[dict[str, Any]] = []
    for raw in practices:
        if not isinstance(raw, dict):
            continue
        item = copy.deepcopy(raw)
        cue = cue_map.get(int(item.get("cue_order") or 0))
        words = [word for word in ((cue or {}).get("words") or []) if isinstance(word, dict)]
        target = [_practice_token(token) for token in re.findall(r"[\w’']+", str(item.get("expression_en") or ""), flags=re.UNICODE)]
        target = [token for token in target if token]
        lexical = [_practice_token(word.get("text")) for word in words]
        match: tuple[int, int] | None = None
        if target:
            width = len(target)
            for start in range(0, len(lexical) - width + 1):
                if lexical[start:start + width] == target:
                    match = (start, start + width - 1)
                    break
        if match is not None:
            first, last = words[match[0]], words[match[1]]
            item["start_ms"] = int(first.get("start_ms") or 0)
            item["end_ms"] = int(last.get("end_ms") or 0)
        aligned.append(item)
    return aligned


def build_hub_final_json(
    canonical: dict[str, Any],
    approved: dict[str, Any],
    shadowing_plan: dict[str, Any],
    *,
    source_title: str,
) -> dict[str, Any]:
    """Build the transport JSON consumed by the current ImmersionHub Admin importer.

    The canonical timings/text remain authoritative. Human-approved material cards
    are attached to their source cues. Connected Speech is deliberately excluded
    from HUB playback in the current product decision; it remains a PDF-only
    material.
    """
    project = canonical.get("project") if isinstance(canonical.get("project"), dict) else {}
    pdfs = approved.get("pdf_content") if isinstance(approved.get("pdf_content"), dict) else {}
    cards = ((approved.get("anki") or {}).get("items") or []) if isinstance(approved.get("anki"), dict) else []

    cards_by_cue: dict[int, list[dict[str, Any]]] = {}
    for raw in cards:
        if not isinstance(raw, dict):
            continue
        try:
            cue_order = int(raw.get("cue_order") or 0)
        except (TypeError, ValueError):
            continue
        if cue_order <= 0:
            continue
        card = copy.deepcopy(raw)
        card.pop("cue_order", None)
        cards_by_cue.setdefault(cue_order, []).append(card)

    cues: list[dict[str, Any]] = []
    for raw in canonical.get("cues") or []:
        if not isinstance(raw, dict):
            continue
        cue = copy.deepcopy(raw)
        try:
            order = int(cue.get("order") or 0)
        except (TypeError, ValueError):
            order = 0
        if "words" in cue:
            cue["words"] = _clean_final_words(cue.get("words"))
        if isinstance(cue.get("words"), list) and cue.get("words"):
            _expand_transport_cue_to_words(cue)
        # HUB transport contract: Word by Word is aligned to the speech interval.
        # The HUB importer prefers subtitle_* when both timing pairs exist, so a
        # subtitle boundary that is slightly tighter than speech_* can reject an
        # otherwise valid final word. For cues with WbW, publish only speech_* as
        # the cue timing authority. The canonical internal document is untouched.
        if isinstance(cue.get("words"), list) and cue.get("words"):
            cue.pop("subtitle_start_ms", None)
            cue.pop("subtitle_end_ms", None)
        cue["final_en"] = str(cue.get("approved_en") or cue.get("original_en") or "").strip()
        items = cards_by_cue.get(order) or []
        cue["anki"] = {"include": bool(items), "items": items}
        cues.append(cue)

    scene_start = int(project.get("source_video_start_ms") if project.get("source_video_start_ms") is not None else project.get("scene_start_ms") or 0)
    scene_end = int(project.get("source_video_end_ms") if project.get("source_video_end_ms") is not None else project.get("scene_end_ms") or 0)
    scene_duration = max(0, scene_end - scene_start)
    content_type = str(project.get("content_type") or "dialogue").strip() or "dialogue"
    kit: dict[str, Any] = {
        "contentType": content_type,
        "title": str(source_title or "Immersion Kit").strip() or "Immersion Kit",
        "youtube": str(project.get("youtube") or "").strip(),
        "scene_start_ms": scene_start,
        "scene_end_ms": scene_end,
        "scene_duration_ms": scene_duration,
    }
    result: dict[str, Any] = {
        "version": 3,
        "source_snapshot_id": str(canonical.get("snapshot_id") or ""),
        "generator": {"project": copy.deepcopy(project), "media_window": copy.deepcopy(canonical.get("generator_media_window"))},
        "kit": kit,
        "cues": cues,
        # Connected Speech is not a HUB playback stage; Music also skips the CS Generator stages.
        "connectedSpeech": [],
        "study": copy.deepcopy(canonical.get("study") or {}),
        "materials": _hub_material_manifest(pdfs, bool(cards)),
        "wbw_practices": _align_wbw_practices_to_current_words(
            list(canonical.get("wbw_practices") or []), cues,
        ),
    }
    result["shadowingConfig"] = copy.deepcopy(canonical.get("shadowingConfig") or {})
    result["shadowingPractice"] = copy.deepcopy(shadowing_plan or {})
    if content_type != "music" and canonical.get("dualScene"):
        result["dualScene"] = copy.deepcopy(canonical.get("dualScene"))
    if content_type == "music":
        if canonical.get("music"):
            result["music"] = copy.deepcopy(canonical.get("music"))
        else:
            orders = [int(cue.get("order") or 0) for cue in cues if int(cue.get("order") or 0) > 0]
            if orders:
                result["music"] = {
                    "sections": [{
                        "order": 1,
                        "type": "other",
                        "label": "Selected excerpt",
                        "cueStartOrder": orders[0],
                        "cueEndOrder": orders[-1],
                        "cueOrders": orders,
                    }]
                }
    return result


def _validate_hub_final_json(payload: dict[str, Any]) -> None:
    kit = payload.get("kit") if isinstance(payload.get("kit"), dict) else {}
    if not str(kit.get("title") or "").strip():
        raise RuntimeError("JSON final do HUB sem kit.title.")
    cues = payload.get("cues") if isinstance(payload.get("cues"), list) else []
    if not cues:
        raise RuntimeError("JSON final do HUB sem cues[].")
    seen: set[int] = set()
    duration = int(kit.get("scene_duration_ms") or 0)
    if str(kit.get("contentType") or "") == "music":
        if duration < 30000:
            raise RuntimeError(f"JSON final Music exige scene_duration_ms de pelo menos 30000; recebeu {duration}.")
        scene_start = int(kit.get("scene_start_ms") or 0)
        scene_end = int(kit.get("scene_end_ms") or 0)
        if scene_start < 0 or scene_end <= scene_start or scene_end - scene_start != duration:
            raise RuntimeError("JSON final Music possui janela scene_start_ms/scene_end_ms inválida.")
    for raw in cues:
        if not isinstance(raw, dict):
            raise RuntimeError("JSON final do HUB contém cue inválido.")
        order = int(raw.get("order") or 0)
        words = raw.get("words") if isinstance(raw.get("words"), list) else []
        has_wbw = bool(words)
        if has_wbw:
            # Must match the timing authority exported for WbW cues.
            try:
                start = int(raw.get("speech_start_ms"))
                end = int(raw.get("speech_end_ms"))
            except (TypeError, ValueError):
                raise RuntimeError(f"JSON final do HUB: cue {order} com WbW sem speech_start_ms/speech_end_ms válidos.")
        else:
            start = int(raw.get("subtitle_start_ms") if raw.get("subtitle_start_ms") is not None else raw.get("speech_start_ms") or 0)
            end = int(raw.get("subtitle_end_ms") if raw.get("subtitle_end_ms") is not None else raw.get("speech_end_ms") or 0)
        if order <= 0 or order in seen:
            raise RuntimeError(f"JSON final do HUB: order inválido/duplicado ({order}).")
        if end <= start or start < 0:
            raise RuntimeError(f"JSON final do HUB: timing inválido no cue {order} ({start}–{end} ms).")
        if not str(raw.get("final_en") or raw.get("approved_en") or raw.get("original_en") or "").strip():
            raise RuntimeError(f"JSON final do HUB: cue {order} sem inglês.")
        if has_wbw:
            # A word may legitimately extend a reviewed cue. The builder expands
            # speech_* to contain WbW; never reject or clamp the word for that.
            previous_word_start: int | None = None
            for position, word in enumerate(words, start=1):
                if not isinstance(word, dict):
                    raise RuntimeError(f"JSON final do HUB: cue {order}, word {position} inválida.")
                try:
                    word_start = int(word.get("start_ms"))
                    word_end = int(word.get("end_ms"))
                except (TypeError, ValueError):
                    text = str(word.get("text") or "").strip()
                    raise RuntimeError(
                        f'JSON final do HUB: cue {order} · word {position} "{text}" sem start_ms/end_ms válidos.'
                    )
                if word_end <= word_start or word_start < 0:
                    text = str(word.get("text") or "").strip()
                    raise RuntimeError(
                        f'JSON final do HUB: cue {order} · word {position} "{text}" com timing inválido '
                        f'({word_start}–{word_end} ms).'
                    )
                if previous_word_start is not None and word_start <= previous_word_start:
                    raise RuntimeError(
                        f"JSON final do HUB: words da cue {order} precisam ter start_ms estritamente crescente."
                    )
                previous_word_start = word_start
        seen.add(order)
    practice = payload.get("shadowingPractice")
    dual_scene = payload.get("dualScene") if isinstance(payload.get("dualScene"), list) else []
    if dual_scene:
        for position, block in enumerate(dual_scene, start=1):
            if not isinstance(block, dict) or not isinstance(block.get("en"), dict) or not isinstance(block.get("pt"), dict):
                raise RuntimeError(f"JSON final do HUB: bloco Dual Scene {position} inválido.")
    elif str(kit.get("contentType") or "") == "music" and isinstance(practice, dict) and practice.get("enabled") is False and practice.get("blocks") == []:
        pass
    elif not isinstance(practice, dict) or practice.get("enabled") is not True or not isinstance(practice.get("blocks"), list):
        raise RuntimeError("JSON final do HUB sem shadowingPractice aprovado.")
    if str(kit.get("contentType") or "") == "music":
        music = payload.get("music") if isinstance(payload.get("music"), dict) else {}
        sections = music.get("sections") if isinstance(music.get("sections"), list) else []
        if not sections:
            raise RuntimeError("JSON final Music sem music.sections.")
    if payload.get("connectedSpeech") != []:
        raise RuntimeError("Connected Speech deve permanecer vazio no JSON do HUB; o CS atual é PDF-only.")
    cue_map = {int(cue.get("order") or 0): cue for cue in cues if isinstance(cue, dict)}
    practices = payload.get("wbw_practices")
    if not isinstance(practices, list):
        raise RuntimeError("JSON final do HUB sem wbw_practices[].")
    for position, item in enumerate(practices, start=1):
        if not isinstance(item, dict):
            raise RuntimeError(f"wbw_practices[{position}] inválido.")
        cue = cue_map.get(int(item.get("cue_order") or 0))
        if not cue:
            raise RuntimeError(f"wbw_practices[{position}] aponta para cue_order inexistente.")
        start_ms, end_ms = int(item.get("start_ms") or 0), int(item.get("end_ms") or 0)
        cue_start = int(cue.get("speech_start_ms") or cue.get("subtitle_start_ms") or 0)
        cue_end = int(cue.get("speech_end_ms") or cue.get("subtitle_end_ms") or 0)
        if not (cue_start <= start_ms < end_ms <= cue_end):
            raise RuntimeError(f"wbw_practices[{position}] está fora do intervalo da cue.")

def generate_final_materials(
    canonical: dict[str, Any],
    approved: dict[str, Any],
    *,
    shadowing_plan: dict[str, Any],
    tts_dir: Path,
    tts_voice_dirs: dict[str, Path] | None = None,
    output_dir: Path,
    source_title: str,
    dual_scene_en_video: Path | None = None,
    dual_scene_pt_video: Path | None = None,
    music_source_video: Path | None = None,
    tiktok_options: dict[str, Any] | None = None,
    tiktok_background: Path | None = None,
    shadowing_source_video: Path | None = None,
    progress: Progress | None = None,
    retry_only: set[str] | None = None,
) -> dict[str, Any]:
    """Render final artifacts without discarding successful work when one task fails.

    `retry_only` contains task ids from a previous partial run. When provided, only
    those tasks are regenerated; already successful files are reused from disk.
    The bundle is always rebuilt so it reflects every artifact currently available.
    """
    def emit(percent: int, message: str) -> None:
        if progress:
            progress(max(0, min(100, int(percent))), message)

    output_dir.mkdir(parents=True, exist_ok=True)
    if retry_only is None:
        shutil.rmtree(output_dir, ignore_errors=True)
        output_dir.mkdir(parents=True, exist_ok=True)

    selected = None if retry_only is None else {str(value) for value in retry_only}
    pdfs = approved.get("pdf_content") if isinstance(approved.get("pdf_content"), dict) else {}
    cards = ((approved.get("anki") or {}).get("items") or []) if isinstance(approved.get("anki"), dict) else []
    artifacts: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []

    def wants(task_id: str) -> bool:
        return selected is None or task_id in selected

    def remember_artifact(kind: str, group: str, path: Path) -> None:
        if not path.is_file():
            return
        artifacts.append({
            "kind": kind,
            "group": group,
            "name": path.name,
            "path": str(path),
            "size": path.stat().st_size,
        })

    def fail(task_id: str, label: str, exc: Exception) -> None:
        failures.append({"id": task_id, "label": label, "error": str(exc)})
        emit(96, f"ERRO em {label}: {exc} — continuando com os demais artefatos…")

    source_json = output_dir / "anki_reviewed_source.json"
    if cards:
        try:
            _anki_source(canonical, cards, source_json)
        except Exception as exc:
            # Both Anki variants depend on this technical source.
            if wants("anki.no_audio"):
                fail("anki.no_audio", "Anki sem áudio", exc)
            if wants("anki.with_tts"):
                fail("anki.with_tts", "Anki com TTS", exc)
        else:
            if wants("anki.no_audio"):
                no_audio = output_dir / "02_anki_sem_audio.apkg"
                try:
                    emit(55, "Preparando Anki aprovado…")
                    try:
                        from anki_generator import generate_no_audio_apkg
                    except ModuleNotFoundError as exc:
                        raise RuntimeError("Dependência genanki ausente. Execute install.bat/install.sh desta versão antes da geração final.") from exc
                    generate_no_audio_apkg(source_json, source_title or "Immersion Kit", no_audio)
                except Exception as exc:
                    no_audio.unlink(missing_ok=True)
                    fail("anki.no_audio", "02_anki_sem_audio.apkg", exc)
            remember_artifact("apkg", "anki", output_dir / "02_anki_sem_audio.apkg")

            voice_specs = (
                ("diana", "Diana", "03_anki_diana.apkg"),
                ("hannah", "Hannah", "04_anki_hannah.apkg"),
                ("troy", "Troy", "05_anki_troy.apkg"),
                ("austin", "Austin", "06_anki_austin.apkg"),
            )
            voice_dirs = tts_voice_dirs or {voice: Path(tts_dir) / voice for voice, _label, _filename in voice_specs}
            for voice, voice_label, filename in voice_specs:
                task_id = f"anki.voice.{voice}"
                output_path = output_dir / filename
                if wants("anki.with_tts") or wants(task_id):
                    try:
                        emit(66, f"Gerando Anki com a voz {voice_label}…")
                        try:
                            from anki_generator import generate_apkg_from_cue_audio
                        except ModuleNotFoundError as exc:
                            raise RuntimeError("Dependência genanki ausente. Execute install.bat/install.sh desta versão antes da geração final.") from exc
                        generate_apkg_from_cue_audio(
                            voice_dirs[voice], source_json, source_title or "Immersion Kit", output_path,
                            variant_label=f"VOZ {voice_label.upper()}", voice_name=voice_label,
                        )
                    except Exception as exc:
                        output_path.unlink(missing_ok=True)
                        fail(task_id, filename, exc)
                remember_artifact("apkg", "anki", output_path)

    hub_json = output_dir / "hub_final.json"
    if wants("hub_json"):
        try:
            emit(86, "Montando JSON final para o HUB…")
            hub_payload = build_hub_final_json(canonical, approved, shadowing_plan, source_title=source_title)
            _validate_hub_final_json(hub_payload)
            hub_json.write_text(json.dumps(hub_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except Exception as exc:
            hub_json.unlink(missing_ok=True)
            fail("hub_json", "hub_final.json", exc)
    remember_artifact("hub_json", "hub", hub_json)

    # Video production now belongs to the integrated editor, not material generation.
    # Shadowing/Dual Scene metadata remain in the Hub JSON above.

    # Package whatever is valid. On retry it is rebuilt even though it is not a
    # failed task itself, because its contents depend on the retried artifacts.
    bundle = output_dir / "materials_final.zip"
    try:
        emit(92, "Empacotando materiais disponíveis…")
        with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for item in artifacts:
                path = Path(item["path"])
                if path.is_file():
                    archive.write(path, arcname=path.name)
    except Exception as exc:
        bundle.unlink(missing_ok=True)
        fail("bundle", "materials_final.zip", exc)
    remember_artifact("zip", "package", bundle)

    successful_pdfs = sum(1 for item in artifacts if item.get("kind") == "pdf")
    successful_apkg = sum(1 for item in artifacts if item.get("kind") == "apkg")
    if failures:
        emit(100, f"Geração concluída com {len(failures)} erro(s). Os arquivos válidos já estão disponíveis.")
    else:
        emit(100, f"Geração final concluída: {len(artifacts)} artefato(s) disponível(is).")
    return {
        "artifacts": artifacts,
        "failures": failures,
        "pdf_count": successful_pdfs,
        "anki_cards": len(cards),
        "apkg_count": successful_apkg,
        "bundle": str(bundle) if bundle.is_file() else "",
        "hub_json": str(hub_json) if hub_json.is_file() else "",
    }
