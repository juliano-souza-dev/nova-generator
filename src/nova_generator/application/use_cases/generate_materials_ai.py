"""Generate the seven-section teaching material without touching approved Editorial cues."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from nova_generator.application.use_cases.materials_ai_exchange import (
    MaterialsAiError,
    MaterialsAiExchange,
)


class GenerateMaterialsAi:
    def __init__(
        self, exchange: MaterialsAiExchange, *, api_key: str | None,
        model: str, client: Any | None = None,
    ) -> None:
        self.exchange = exchange
        self.model = model
        self._client = client
        self._api_key = api_key

    def execute(
        self, project_id: UUID, *, source_sha256: str, selected_ids: list[str]
    ) -> dict[str, Any]:
        package = self.exchange.package(project_id)
        if source_sha256 != package["source_sha256"]:
            raise MaterialsAiError(
                "O conteúdo aprovado mudou desde a solicitação. Gere novamente."
            )
        available = {
            cue["id"]
            for scene in package["source"]["scenes"]
            for cue in scene["cues"]
        }
        if not selected_ids or not set(selected_ids).issubset(available):
            raise MaterialsAiError("Seleção de cards inválida ou desatualizada.")
        client = self._client
        if client is None:
            if not self._api_key:
                raise MaterialsAiError(
                    "Groq não configurada. Configure a chave ou importe o JSON de IA externa."
                )
            try:
                from groq import Groq
            except ImportError as error:
                raise MaterialsAiError("Biblioteca Groq não instalada.") from error
            client = Groq(api_key=self._api_key, timeout=120, max_retries=0)

        package["selected_anki_cue_ids"] = selected_ids
        instructions = (
            "Produza integralmente o MATERIAL DIDÁTICO brasileiro em JSON. "
            "Use exatamente o contrato nova-generator-materials-output/1.0, "
            "project_id e source_sha256 recebidos. São obrigatórias sete seções, "
            "na ordem learning_path, vocabulary, structures, guided_practice, "
            "activities, challenge, review; cada seção precisa de título e "
            "parágrafos substanciais. guided_practice, activities e challenge "
            "precisam de exercícios com perguntas e respostas concretas. "
            "Crie exatamente um anki_card para cada ID selecionado em "
            "selected_anki_cue_ids, sem cards adicionais e sem repetir IDs. "
            "Copie literalmente front_en e back_pt dos cues aprovados, "
            "acrescente explanation_pt, focus_text, meaning, marked_en, marked_pt, "
            "example_en, example_pt e tags. Destaques devem ser substrings exatas "
            "das respectivas frases; exemplos são pares EN/PT. "
            "Não altere os cues, hashes, IDs, timings ou traduções. Somente JSON."
        )
        try:
            raw = client.chat.completions.create(
                model=self.model,
                temperature=0,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": instructions},
                    {"role": "user", "content": json.dumps(package, ensure_ascii=False)},
                ],
            )
            body = raw.choices[0].message.content
            if not isinstance(body, str) or not body.strip():
                raise MaterialsAiError("A Groq retornou uma resposta vazia.")
            document = json.loads(body)
        except MaterialsAiError:
            raise
        except (ValueError, TypeError, IndexError, KeyError) as error:
            raise MaterialsAiError(f"A Groq devolveu JSON inválido: {error}") from error
        except Exception as error:
            status = getattr(error, "status_code", None)
            if status == 429:
                raise MaterialsAiError(
                    "Limite da Groq atingido. Tente mais tarde ou utilize a IA externa."
                ) from error
            raise MaterialsAiError(
                "Falha ao gerar conteúdo na Groq. Utilize a IA externa ou tente novamente."
            ) from error
        parsed = self.exchange.import_result(project_id, document)
        actual = {card["cue_id"] for card in parsed["document"]["anki_cards"]}
        if actual != set(selected_ids) or len(parsed["document"]["anki_cards"]) != len(selected_ids):
            # Never leave an incomplete suggestion as the active draft.
            self.exchange._path(project_id, "external-draft.json").unlink(missing_ok=True)
            raise MaterialsAiError(
                "A IA não gerou todos os cards selecionados. Tente novamente ou use a IA externa."
            )
        return {
            "project_id": str(project_id),
            "source_sha256": source_sha256,
            "sections": len(parsed["document"]["sections"]),
            "cards": len(parsed["document"]["anki_cards"]),
            "status": "draft",
        }
