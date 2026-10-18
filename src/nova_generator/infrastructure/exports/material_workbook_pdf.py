"""Portable PDF renderer for the seven reviewed pedagogical sections."""

from __future__ import annotations

from html import escape
from pathlib import Path
from typing import Any


def render_material_workbook(document: dict[str, Any], output: Path) -> Path:
    """Render only approved AI content; never invent pedagogical sections."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_CENTER
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import cm
        from reportlab.platypus import (
            KeepTogether, Paragraph, SimpleDocTemplate, Spacer,
        )
    except ImportError as error:
        raise RuntimeError(
            "O gerador de PDF não está instalado. Reinicie o Nova Generator para "
            "preparar as dependências automaticamente."
        ) from error

    output.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    heading = ParagraphStyle(
        "WorkbookHeading", parent=styles["Heading1"],
        fontSize=17, leading=22, textColor=colors.HexColor("#16345A"),
        spaceBefore=16, spaceAfter=8,
    )
    small_heading = ParagraphStyle(
        "WorkbookMinor", parent=styles["Heading3"],
        fontSize=11, leading=16, textColor=colors.HexColor("#25639B"),
        spaceBefore=10, spaceAfter=4,
    )
    title = ParagraphStyle(
        "WorkbookTitle", parent=styles["Title"],
        fontSize=24, leading=30, textColor=colors.HexColor("#16345A"),
        alignment=TA_CENTER, spaceAfter=15,
    )
    body = ParagraphStyle(
        "WorkbookBody", parent=styles["BodyText"],
        fontSize=10, leading=15, spaceAfter=7,
    )
    answer = ParagraphStyle(
        "WorkbookAnswer", parent=body,
        textColor=colors.HexColor("#225D46"), leftIndent=12,
    )
    story: list[Any] = [
        Paragraph(escape(str(document["title"])), title),
        Paragraph("Material de estudo e revisão · Nova Generator", body),
        Spacer(1, 0.5 * cm),
    ]
    for section in document["sections"]:
        story.append(Paragraph(escape(section["title"]), heading))
        for paragraph in section["paragraphs"]:
            story.append(Paragraph(escape(str(paragraph)), body))
        for index, exercise in enumerate(section["exercises"], start=1):
            story.append(
                KeepTogether([
                    Paragraph(
                        f"<b>Atividade {index}.</b> {escape(exercise['prompt'])}", body
                    ),
                    Paragraph(
                        f"<b>Resposta:</b> {escape(exercise['answer'])}", answer
                    ),
                ])
            )
    story.append(Paragraph("Cards Anki · Explicações", heading))
    for index, card in enumerate(document["anki_cards"], start=1):
        items = [
            Paragraph(f"<b>{index}. {escape(card['front_en'])}</b>", small_heading),
            Paragraph(escape(card["back_pt"]), body),
            Paragraph(escape(card["explanation_pt"]), body),
        ]
        if card.get("focus_text"):
            items.append(
                Paragraph(
                    f"<b>Expressão:</b> {escape(card['focus_text'])}", body
                )
            )
        if card.get("meaning"):
            items.append(Paragraph(f"<b>Sentido:</b> {escape(card['meaning'])}", body))
        if card.get("example_en"):
            items.extend([
                Paragraph(f"<b>Exemplo:</b> {escape(card['example_en'])}", body),
                Paragraph(escape(card["example_pt"]), body),
            ])
        story.extend([KeepTogether(items), Spacer(1, 0.18 * cm)])
    pdf = SimpleDocTemplate(
        str(output), pagesize=(21 * cm, 29.7 * cm),
        topMargin=1.8 * cm, bottomMargin=1.8 * cm,
        rightMargin=1.9 * cm, leftMargin=1.9 * cm,
        title=str(document["title"]),
    )
    pdf.build(story)
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("Não foi possível produzir o PDF pedagógico.")
    return output
