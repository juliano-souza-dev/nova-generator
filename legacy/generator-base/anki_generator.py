from __future__ import annotations

import html
import json
import re
import shutil
import subprocess
import tempfile
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import genanki


MODEL_ID = 1773102031
MODEL_NAME = "English Immersion Mini Aula V3"

MODEL = genanki.Model(
    MODEL_ID,
    MODEL_NAME,
    fields=[
        {"name": "English"},
        {"name": "Portuguese"},
        {"name": "MiniLesson"},
        {"name": "Speaker"},
        {"name": "Audio"},
        {"name": "AudioLabel"},
        {"name": "CueRef"},
    ],
    templates=[
        {
            "name": "EN to PT",
            "qfmt": r"""
<div class="card-shell">
  {{#Audio}}
  <div class="audio-top">{{Audio}}</div>
  {{/Audio}}

  <div class="direction direction-en">EN → PT</div>

  <div class="sentence sentence-en">
    {{English}}
  </div>
</div>
""",
            "afmt": r"""
<div class="card-shell answer">
  <div class="direction direction-en">EN → PT</div>

  <div class="sentence sentence-en">
    {{English}}
  </div>

  <div class="divider"></div>

  <div class="sentence translation">
    {{Portuguese}}
  </div>

  {{MiniLesson}}

  {{#Speaker}}
  <div class="meta-line">
    Falante: {{Speaker}}
  </div>
  {{/Speaker}}

  {{#Audio}}
  <div class="audio-bottom">
    <span>{{AudioLabel}}</span>
    {{Audio}}
  </div>
  {{/Audio}}
</div>
""",
        },
        {
            "name": "PT to EN",
            "qfmt": r"""
<div class="card-shell">
  <div class="direction direction-pt">PT → EN</div>

  <div class="sentence translation">
    {{Portuguese}}
  </div>
</div>
""",
            "afmt": r"""
<div class="card-shell answer">
  <div class="direction direction-pt">PT → EN</div>

  <div class="sentence translation">
    {{Portuguese}}
  </div>

  <div class="divider"></div>

  <div class="sentence sentence-en">
    {{English}}
  </div>

  {{MiniLesson}}

  {{#Speaker}}
  <div class="meta-line">
    Falante: {{Speaker}}
  </div>
  {{/Speaker}}

  {{#Audio}}
  <div class="audio-bottom">
    <span>{{AudioLabel}}</span>
    {{Audio}}
  </div>
  {{/Audio}}
</div>
""",
        },
    ],
    css=r"""
:root {
  --bg: #fbf8f2;
  --text: #14202b;
  --muted: #6f7982;
  --line: #a7aaa5;
  --gold: #ffd86b;
  --gold-text: #864b00;
  --green: #0a7b45;
  --blue: #2563eb;
  --lesson-bg: #eaf3fb;
  --lesson-border: #2b78c5;
  --explain-bg: #f0f2f4;
  --explain-border: #d66a60;
}

.card {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: Inter, "Segoe UI", Arial, sans-serif;
  font-size: 22px;
  text-align: left;
}

.card-shell {
  max-width: 780px;
  margin: 0 auto;
  padding: 34px 28px 40px;
}

.audio-top {
  margin-bottom: 18px;
}

.direction {
  display: inline-block;
  margin-bottom: 22px;
  padding: 6px 10px;
  border-radius: 7px;
  font-size: 14px;
  font-weight: 900;
  letter-spacing: .03em;
}

.direction-en {
  background: #dff8e9;
  color: #08713f;
}

.direction-pt {
  background: #e7ebff;
  color: #3d4bc6;
}

.sentence {
  font-size: 29px;
  line-height: 1.37;
  font-weight: 800;
}

.translation {
  color: var(--green);
}

.focus-highlight {
  padding: 1px 5px 2px;
  border-radius: 5px;
  background: var(--gold);
  color: var(--gold-text);
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}

.divider {
  height: 1px;
  margin: 26px 0 20px;
  background: var(--line);
}

.mini-lesson {
  margin-top: 22px;
}

.mini-title {
  margin-bottom: 9px;
  color: #406070;
  font-size: 12px;
  font-weight: 950;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.lesson-concept {
  padding: 15px 17px;
  border-left: 5px solid var(--lesson-border);
  background: var(--lesson-bg);
}

.lesson-category {
  margin-bottom: 5px;
  color: #2d55a0;
  font-size: 12px;
  font-weight: 950;
  letter-spacing: .07em;
  text-transform: uppercase;
}

.lesson-focus {
  color: #142d56;
  font-size: 25px;
  line-height: 1.2;
  font-weight: 950;
}

.lesson-meaning {
  margin-top: 6px;
  color: #903800;
  font-size: 20px;
  line-height: 1.35;
  font-weight: 850;
}

.lesson-meaning-label,
.lesson-explanation-label {
  display: block;
  margin-bottom: 4px;
  font-size: 11px;
  font-weight: 950;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.lesson-explanation {
  margin-top: 12px;
  padding: 15px 17px;
  border-left: 4px solid var(--explain-border);
  background: var(--explain-bg);
  color: #25323f;
  font-size: 18px;
  line-height: 1.52;
}

.lesson-tip {
  margin-top: 10px;
  color: #5d6770;
  font-size: 14px;
  line-height: 1.45;
}

.lesson-example {
  display: grid;
  gap: 4px;
  margin-top: 12px;
  padding: 14px 17px;
  border-radius: 8px;
  background: #fff;
  color: #25323f;
  font-size: 17px;
}

.lesson-example span { color: #8a5a3c; font-size: 11px; font-weight: 950; text-transform: uppercase; }
.lesson-example b { font-size: 18px; }
.lesson-example small { color: #68727a; font-size: 15px; }

.nightMode .lesson-example,
.night_mode .lesson-example { background: #18232d; color: #f0f4f7; }

.meta-line {
  margin-top: 14px;
  color: var(--muted);
  font-size: 13px;
}

.audio-bottom {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 20px;
  color: #8a4b00;
  font-size: 15px;
}

.nightMode,
.night_mode {
  --bg: #111b25;
  --text: #f5f7f8;
  --muted: #a9b3bc;
  --line: #65717c;
  --green: #98f3d3;
  --lesson-bg: #21384a;
  --lesson-border: #62a8e8;
  --explain-bg: #202d37;
  --explain-border: #e08278;
}

.nightMode .lesson-focus,
.night_mode .lesson-focus {
  color: #f5f7f8;
}

.nightMode .lesson-category,
.night_mode .lesson-category {
  color: #9bc0ff;
}

.nightMode .lesson-meaning,
.night_mode .lesson-meaning {
  color: #ffd17a;
}

.nightMode .lesson-explanation,
.night_mode .lesson-explanation {
  color: #f0f4f7;
}

.nightMode .mini-title,
.night_mode .mini-title,
.nightMode .lesson-tip,
.night_mode .lesson-tip {
  color: #aebbc5;
}

@media (max-width: 560px) {
  .card-shell {
    padding: 24px 18px 31px;
  }

  .sentence {
    font-size: 25px;
  }

  .lesson-focus {
    font-size: 22px;
  }

  .lesson-meaning {
    font-size: 18px;
  }

  .lesson-explanation {
    font-size: 17px;
  }
}
""",
)


@dataclass(frozen=True)
class StudyItem:
    key: str
    category: str
    focus: str
    meaning: str
    explanation: str
    highlight_en: str
    highlight_pt: str
    marked: str
    marked_pt: str
    example_en: str
    example_pt: str
    tags: tuple[str, ...]


@dataclass(frozen=True)
class Cue:
    order: int
    start: float
    end: float
    speaker: str
    en: str
    pt: str
    tags: tuple[str, ...]
    items: tuple[StudyItem, ...]


class StableNote(genanki.Note):
    @property
    def guid(self):
        seed = getattr(self, "_stable_seed", self.fields[0])
        return genanki.guid_for(seed)


def _value(data: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in data:
            return data[key]
    return default


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {
            "1", "true", "yes", "sim", "on"
        }
    return bool(value)


def _anki_tag(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"\s+", "-", value)
    value = re.sub(r"[^a-z0-9_\-]", "", value)
    return value


def _html_text(value: str) -> str:
    return html.escape(value.strip()).replace("\n", "<br>")


def _highlight_text(text: str, target: str) -> str:
    text = str(text or "").strip()
    target = str(target or "").strip()

    if not text:
        return ""

    if not target:
        return _html_text(text)

    match = re.search(
        re.escape(target),
        text,
        flags=re.IGNORECASE,
    )

    if not match:
        return _html_text(text)

    before = html.escape(text[:match.start()])
    selected = html.escape(text[match.start():match.end()])
    after = html.escape(text[match.end():])

    return (
        before
        + '<span class="focus-highlight">'
        + selected
        + "</span>"
        + after
    ).replace("\n", "<br>")


def _mini_lesson_html(
    item: StudyItem,
) -> str:
    category = _html_text(
        item.category or "CONTEÚDO"
    )

    focus = _html_text(
        item.focus or "Ponto de estudo"
    )

    meaning = _html_text(
        item.meaning or
        "Observe como este trecho funciona no contexto."
    )

    explanation = _html_text(
        item.explanation or
        "Estude este trecho como um bloco e observe "
        "como ele é usado naturalmente na frase."
    )

    example = ""
    if item.example_en:
        example = f"""
  <div class="lesson-example">
    <span>Outro exemplo</span>
    <b>{_html_text(item.example_en)}</b>
    <small>{_html_text(item.example_pt)}</small>
  </div>"""

    return f"""
<section class="mini-lesson">
  <div class="mini-title">
    MINI AULA
  </div>

  <div class="lesson-concept">
    <div class="lesson-category">
      {category}
    </div>

    <div class="lesson-focus">
      {focus}
    </div>

    <div class="lesson-meaning">
      <span class="lesson-meaning-label">
        Significado
      </span>
      {meaning}
    </div>
  </div>

  <div class="lesson-explanation">
    <span class="lesson-explanation-label">
      Como entender / usar
    </span>
    {explanation}
  </div>
  {example}
</section>
""".strip()



def _deck_id(deck_name: str) -> int:
    return 1_000_000_000 + (
        zlib.crc32(deck_name.encode("utf-8"))
        % 999_999_999
    )


def safe_filename(
    value: str,
    fallback: str = "anki_deck",
) -> str:
    value = value.strip()

    if not value:
        return fallback

    normalized = (
        value
        .encode("ascii", "ignore")
        .decode("ascii")
    )

    normalized = re.sub(
        r"[^A-Za-z0-9._-]+",
        "_",
        normalized,
    )

    normalized = re.sub(
        r"_+",
        "_",
        normalized,
    ).strip("._-")

    return normalized[:100] or fallback


def _normalise_tags(raw: Any) -> tuple[str, ...]:
    if isinstance(raw, str):
        raw = [raw]

    if not isinstance(raw, list):
        raw = []

    return tuple(
        tag
        for tag in (
            _anki_tag(str(value))
            for value in raw
        )
        if tag
    )


def _study_item_from_dict(
    data: dict[str, Any],
    default_note: str,
    default_tags: tuple[str, ...],
    index: int,
) -> StudyItem:
    category = str(
        _value(
            data,
            "type",
            "category",
            default="EXPRESSÃO",
        )
        or ""
    ).strip()

    focus = str(
        _value(
            data,
            "focus",
            "expression",
            "term",
            default="",
        )
        or ""
    ).strip()

    meaning = str(
        _value(
            data,
            "meaning",
            "definition",
            default="",
        )
        or ""
    ).strip()

    explanation = str(
        _value(
            data,
            "explanation",
            "note",
            default=default_note,
        )
        or ""
    ).strip()

    highlight_en = str(
        _value(
            data,
            "highlight_en",
            "highlightEn",
            default=focus,
        )
        or ""
    ).strip()

    highlight_pt = str(
        _value(
            data,
            "highlight_pt",
            "highlightPt",
            default="",
        )
        or ""
    ).strip()

    marked = str(_value(data, "marked", default=highlight_en) or "").strip()
    marked_pt = str(_value(data, "markedPT", "marked_pt", default=highlight_pt) or "").strip()
    example_en = str(_value(data, "example_en", "exampleEn", default="") or "").strip()
    example_pt = str(_value(data, "example_pt", "examplePt", default="") or "").strip()

    tags = tuple(
        dict.fromkeys(
            [
                *default_tags,
                *_normalise_tags(
                    data.get("tags", [])
                ),
            ]
        )
    )

    key = str(
        _value(
            data,
            "key",
            "id",
            default=f"item-{index}",
        )
        or f"item-{index}"
    ).strip()

    return StudyItem(
        key=key,
        category=category,
        focus=focus,
        meaning=meaning,
        explanation=explanation,
        highlight_en=highlight_en,
        highlight_pt=highlight_pt,
        marked=marked,
        marked_pt=marked_pt,
        example_en=example_en,
        example_pt=example_pt,
        tags=tags,
    )


def _cue_study_items(
    cue_data: dict[str, Any],
    selector_mode: bool,
) -> tuple[StudyItem, ...]:
    raw_anki = cue_data.get("anki", None)
    default_note = str(
        cue_data.get("note", "")
        or ""
    ).strip()

    default_tags = _normalise_tags(
        cue_data.get("tags", [])
    )

    if isinstance(raw_anki, dict):
        if (
            "include" in raw_anki
            and not _as_bool(
                raw_anki.get("include")
            )
        ):
            return ()

        raw_items = raw_anki.get("items")

        if isinstance(raw_items, list):
            items = []

            for index, item in enumerate(
                raw_items,
                start=1,
            ):
                if not isinstance(item, dict):
                    continue

                if (
                    "include" in item
                    and not _as_bool(
                        item.get("include")
                    )
                ):
                    continue

                items.append(
                    _study_item_from_dict(
                        item,
                        default_note,
                        default_tags,
                        index,
                    )
                )

            return tuple(items)

        return (
            _study_item_from_dict(
                raw_anki,
                default_note,
                default_tags,
                1,
            ),
        )

    if isinstance(raw_anki, bool):
        if not raw_anki:
            return ()

        return (
            _study_item_from_dict(
                {},
                default_note,
                default_tags,
                1,
            ),
        )

    if selector_mode:
        return ()

    # Compatibilidade com JSON antigo:
    # se nenhum cue tiver "anki", inclui todos.
    return (
        _study_item_from_dict(
            {},
            default_note,
            default_tags,
            1,
        ),
    )


def load_cues(
    json_path: str | Path,
) -> list[Cue]:
    path = Path(json_path)

    data = json.loads(
        path.read_text(
            encoding="utf-8-sig"
        )
    )

    if isinstance(data, list):
        raw_cues = data
    elif isinstance(data, dict):
        raw_cues = data.get("cues")
    else:
        raw_cues = None

    if (
        not isinstance(raw_cues, list)
        or not raw_cues
    ):
        raise ValueError(
            "O JSON precisa conter uma lista "
            "'cues' com pelo menos uma fala."
        )

    selector_mode = any(
        isinstance(item, dict)
        and "anki" in item
        for item in raw_cues
    )

    cues: list[Cue] = []
    seen_orders: set[int] = set()

    for index, item in enumerate(
        raw_cues,
        start=1,
    ):
        if not isinstance(item, dict):
            continue

        order_raw = _value(
            item,
            "order",
            "cue_order",
            "id",
            default=index,
        )

        try:
            order = int(order_raw)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"Cue #{index}: order/id inválido."
            ) from exc

        if order <= 0:
            raise ValueError(
                f"Cue #{index}: order/id "
                "precisa ser maior que zero."
            )

        if order in seen_orders:
            raise ValueError(
                f"Cue duplicado no JSON: {order}."
            )

        seen_orders.add(order)

        items = _cue_study_items(
            item,
            selector_mode,
        )

        if not items:
            continue

        try:
            start = float(
                _value(
                    item,
                    "start",
                    "start_time",
                )
            )

            end = float(
                _value(
                    item,
                    "end",
                    "end_time",
                )
            )
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"Cue {order}: start/end inválidos."
            ) from exc

        if start < 0 or end <= start:
            raise ValueError(
                f"Cue {order}: intervalo inválido "
                f"({start} → {end})."
            )

        en = str(
            _value(
                item,
                "en",
                "text_en",
                default="",
            )
            or ""
        ).strip()

        pt = str(
            _value(
                item,
                "pt",
                "text_pt",
                default="",
            )
            or ""
        ).strip()

        if not en:
            raise ValueError(
                f"Cue {order}: texto em inglês "
                "está vazio."
            )

        if not pt:
            raise ValueError(
                f"Cue {order}: tradução em "
                "português está vazia."
            )

        cues.append(
            Cue(
                order=order,
                start=start,
                end=end,
                speaker=str(
                    _value(
                        item,
                        "speaker",
                        "author",
                        default="",
                    )
                    or ""
                ).strip(),
                en=en,
                pt=pt,
                tags=_normalise_tags(
                    item.get("tags", [])
                ),
                items=items,
            )
        )

    if not cues:
        if selector_mode:
            raise ValueError(
                "Nenhum cue possui conteúdo Anki "
                "selecionado."
            )

        raise ValueError(
            "Nenhum cue válido foi encontrado."
        )

    return sorted(
        cues,
        key=lambda cue: cue.order,
    )


def cut_audio(
    source_mp3: str | Path,
    cue: Cue,
    destination: str | Path,
    padding_ms: int = 100,
    speed_percent: int = 100,
) -> None:
    ffmpeg = shutil.which("ffmpeg")

    if not ffmpeg:
        raise RuntimeError(
            "FFmpeg não encontrado. Instale o "
            "FFmpeg e confirme que "
            "'ffmpeg -version' funciona no CMD."
        )

    source = Path(source_mp3)
    destination = Path(destination)

    padding = (
        max(0, int(padding_ms))
        / 1000.0
    )

    start = max(
        0.0,
        cue.start - padding,
    )

    end = cue.end + padding
    duration = end - start

    speed = max(
        50,
        min(200, int(speed_percent)),
    ) / 100.0

    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-ss",
        f"{start:.3f}",
        "-t",
        f"{duration:.3f}",
        "-vn",
    ]

    if abs(speed - 1.0) > 0.001:
        command.extend(
            [
                "-filter:a",
                f"atempo={speed:.3f}",
            ]
        )

    command.extend(
        [
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "3",
            str(destination),
        ]
    )

    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(
            "FFmpeg falhou ao recortar "
            f"o cue {cue.order}:\n"
            f"{result.stderr.strip()}"
        )

    if (
        not destination.exists()
        or destination.stat().st_size == 0
    ):
        raise RuntimeError(
            "O áudio do cue "
            f"{cue.order} não foi criado."
        )


def _build_deck(
    cues: list[Cue],
    deck_title: str,
    variant_label: str,
    output_path: Path,
    audio_names: dict[int, str],
    media_files: list[str],
    audio_label: str,
    deck_collection: str,
) -> dict[str, Any]:
    container = str(deck_collection or "English Immersion").strip()
    variant = str(variant_label or "").strip()
    full_deck_name = f"{container}::{deck_title}"
    if variant:
        full_deck_name = f"{full_deck_name}::{variant}"

    deck = genanki.Deck(
        _deck_id(full_deck_name),
        full_deck_name,
    )

    note_count = 0

    for cue in cues:
        for item_index, item in enumerate(
            cue.items,
            start=1,
        ):
            tags = list(
                dict.fromkeys(
                    [
                        *cue.tags,
                        *item.tags,
                    ]
                )
            )

            category_tag = _anki_tag(
                item.category
            )

            if category_tag:
                tags.append(category_tag)

            audio_name = audio_names.get(
                cue.order,
                "",
            )

            audio_field = (
                f"[sound:{audio_name}]"
                if audio_name
                else ""
            )

            note = StableNote(
                model=MODEL,
                fields=[
                    _highlight_text(
                        cue.en,
                        item.marked or item.highlight_en,
                    ),
                    _highlight_text(
                        cue.pt,
                        item.marked_pt or item.highlight_pt,
                    ),
                    _mini_lesson_html(item),
                    "",
                    audio_field,
                    _html_text(
                        audio_label
                        if audio_field
                        else ""
                    ),
                    f"Cue {cue.order}",
                ],
                tags=list(
                    dict.fromkeys(tags)
                ),
            )

            note._stable_seed = (
                f"{full_deck_name}"
                f"|cue:{cue.order}"
                f"|item:{item.key or item_index}"
                f"|{cue.en}"
            )

            deck.add_note(note)
            note_count += 1

    package = genanki.Package(deck)
    package.media_files = media_files
    package.write_to_file(
        str(output_path)
    )

    if (
        not output_path.exists()
        or output_path.stat().st_size == 0
    ):
        raise RuntimeError(
            "O arquivo .apkg não foi gerado."
        )

    return {
        "deck": full_deck_name,
        "notes": note_count,
        "cards": note_count * 2,
        "output": str(output_path),
    }


def generate_dual_apkg(
    mp3_path: str | Path,
    json_path: str | Path,
    deck_title: str,
    output_audio_path: str | Path,
    output_no_audio_path: str | Path,
    padding_ms: int = 100,
    speed_percent: int = 100,
    deck_collection: str = "English Immersion",
) -> dict[str, Any]:
    mp3_path = Path(mp3_path)
    json_path = Path(json_path)
    output_audio_path = Path(
        output_audio_path
    )
    output_no_audio_path = Path(
        output_no_audio_path
    )

    if not mp3_path.is_file():
        raise FileNotFoundError(
            "Arquivo MP3 não encontrado."
        )

    if not json_path.is_file():
        raise FileNotFoundError(
            "Arquivo JSON não encontrado."
        )

    deck_title = deck_title.strip()

    if not deck_title:
        raise ValueError(
            "Informe o nome do deck."
        )

    cues = load_cues(json_path)
    study_items = sum(len(cue.items) for cue in cues)
    if not 5 <= study_items <= 10:
        raise ValueError(
            f"O deck precisa possuir de 5 a 10 itens selecionados; foram encontrados {study_items}. "
            "Cada item gera dois cards."
        )

    output_audio_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    output_no_audio_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with tempfile.TemporaryDirectory(
        prefix="immersion_anki_v2_"
    ) as temp_name:
        temp_dir = Path(temp_name)

        max_order_width = max(
            2,
            len(
                str(
                    max(
                        cue.order
                        for cue in cues
                    )
                )
            ),
        )

        audio_names: dict[int, str] = {}
        media_files: list[str] = []

        for cue in cues:
            audio_name = (
                f"cue_"
                f"{cue.order:0{max_order_width}d}"
                ".mp3"
            )

            audio_path = (
                temp_dir / audio_name
            )

            cut_audio(
                mp3_path,
                cue,
                audio_path,
                padding_ms=padding_ms,
                speed_percent=speed_percent,
            )

            audio_names[
                cue.order
            ] = audio_name

            media_files.append(
                str(audio_path)
            )

        if speed_percent == 100:
            audio_label = "Cena completa:"
        else:
            audio_label = (
                "Áudio a "
                f"{speed_percent}%:"
            )

        audio_result = _build_deck(
            cues=cues,
            deck_title=deck_title,
            variant_label="COM ÁUDIO",
            output_path=output_audio_path,
            audio_names=audio_names,
            media_files=media_files,
            audio_label=audio_label,
            deck_collection=deck_collection,
        )

        no_audio_result = _build_deck(
            cues=cues,
            deck_title=deck_title,
            variant_label="SEM ÁUDIO",
            output_path=output_no_audio_path,
            audio_names={},
            media_files=[],
            audio_label="",
            deck_collection=deck_collection,
        )

    unique_audio_cues = len(cues)
    return {
        "audio": audio_result,
        "no_audio": no_audio_result,
        "selected_cues": len(cues),
        "study_items": study_items,
        "cards_each_deck": study_items * 2,
        "audio_clips": unique_audio_cues,
    }


def generate_no_audio_apkg(
    json_path: str | Path,
    deck_title: str,
    output_path: str | Path,
    deck_collection: str = "English Immersion",
) -> dict[str, Any]:
    """Generate the lightweight Anki deck without requiring an MP3."""
    json_path = Path(json_path)
    output_path = Path(output_path)

    if not json_path.is_file():
        raise FileNotFoundError(
            "Arquivo JSON não encontrado."
        )

    deck_title = deck_title.strip()

    if not deck_title:
        raise ValueError(
            "Informe o nome do deck."
        )

    cues = load_cues(json_path)

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    result = _build_deck(
        cues=cues,
        deck_title=deck_title,
        variant_label="SEM ÁUDIO",
        output_path=output_path,
        audio_names={},
        media_files=[],
        audio_label="",
        deck_collection=deck_collection,
    )

    study_items = sum(
        len(cue.items)
        for cue in cues
    )

    return {
        "no_audio": result,
        "selected_cues": len(cues),
        "study_items": study_items,
        "cards": study_items * 2,
    }



def generate_apkg_from_cue_audio(
    cue_audio_dir: str | Path,
    json_path: str | Path,
    deck_title: str,
    output_path: str | Path,
    deck_collection: str = "English Immersion",
    variant_label: str = "COM ÁUDIO",
    voice_name: str = "",
) -> dict[str, Any]:
    """Generate one external Anki deck using pre-generated synthetic audio per cue.

    The audio files must be named cue_XXX.wav (or cue_XX.wav) and are used as-is.
    No audio is extracted from the source scene.
    """
    cue_audio_dir = Path(cue_audio_dir)
    json_path = Path(json_path)
    output_path = Path(output_path)
    if not cue_audio_dir.is_dir():
        raise FileNotFoundError("Pasta de áudio TTS dos cues não encontrada.")
    if not json_path.is_file():
        raise FileNotFoundError("Arquivo JSON não encontrado.")
    deck_title = deck_title.strip()
    if not deck_title:
        raise ValueError("Informe o nome do deck.")

    cues = load_cues(json_path)
    study_items = sum(len(cue.items) for cue in cues)
    if study_items <= 0:
        raise ValueError("Nenhum item Anki selecionado foi encontrado.")

    audio_names: dict[int, str] = {}
    media_files: list[str] = []
    for cue in cues:
        candidates = [
            cue_audio_dir / f"cue_{cue.order:04d}.wav",
            cue_audio_dir / f"cue_{cue.order:03d}.wav",
            cue_audio_dir / f"cue_{cue.order:02d}.wav",
            cue_audio_dir / f"cue_{cue.order}.wav",
        ]
        source = next((path for path in candidates if path.is_file() and path.stat().st_size > 0), None)
        if source is None:
            raise FileNotFoundError(f"Áudio TTS obrigatório não encontrado para o cue {cue.order}.")
        audio_names[cue.order] = source.name
        media_files.append(str(source))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    result = _build_deck(
        cues=cues,
        deck_title=deck_title,
        variant_label=str(variant_label or "COM ÁUDIO").strip(),
        output_path=output_path,
        audio_names=audio_names,
        media_files=media_files,
        audio_label=f"Voz {voice_name}:" if str(voice_name).strip() else "Voz sintética:",
        deck_collection=deck_collection,
    )
    return {
        "deck": result,
        "selected_cues": len(cues),
        "study_items": study_items,
        "cards": int(result.get("cards") or 0),
        "audio_clips": len(audio_names),
        "audio_source": "groq_tts",
        "original_scene_audio_used": False,
    }
