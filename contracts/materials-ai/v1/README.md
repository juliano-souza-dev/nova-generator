# Contrato de materiais da IA externa · 1.0

Este contrato representa **conteúdo pedagógico**, não somente as frases editadas. O fluxo da produção nova é:

1. Editorial concluído (nenhuma alteração nesta etapa).
2. Shadowing pré-produzido automaticamente a partir das cues aprovadas, prévia completa e aprovação explícita de cada cena.
3. `GET /api/projects/{project_id}/materials-ai/package` fornece JSON de entrada com texto EN/PT literal, palavras, grupos semânticos e blocos de Shadowing.
4. O operador envia esse arquivo a uma IA externa, que produz o JSON definido em `output.schema.json`.
5. `POST /api/projects/{project_id}/materials-ai/import` recebe o arquivo; servidor valida o contrato completo, o projeto, o snapshot e os cards.
6. `GET /api/projects/{project_id}/materials-ai/review` apresenta as sete seções com exercícios e os cards com explicações para avaliação humana.
7. `POST /api/projects/{project_id}/materials-ai/approval` registra a aprovação da versão revisada. A etapa seguinte trata TTS/Anki e exportação.

**Connected Speech foi aposentado.** Não aparece no fluxo obrigatório nem nas sete seções.

## Seções obrigatórias, nesta ordem

| ID | Conteúdo esperado |
| --- | --- |
| `learning_path` | Como estudar o material e objetivos de uso |
| `vocabulary` | Expressões, palavras e significados contextualizados |
| `structures` | Construções, padrões e exemplos da cena |
| `guided_practice` | Exercícios guiados, com respostas |
| `activities` | Atividades práticas, com respostas |
| `challenge` | Desafio de consolidação, com respostas |
| `review` | Síntese e pontos essenciais para revisão |

Cada seção tem um título e pelo menos um parágrafo. As seções de prática, atividades e desafio exigem exercícios com pergunta e resposta. Os cards Anki devem conter a cue referenciada, inglês e português **idênticos** ao material aprovado, explicação em PT e tags opcionais.

## Integridade e recuperação

- `source_sha256` é um hash determinístico da fonte aprovada incluindo os blocos de Shadowing e as traduções palavra a palavra.
- A importação só é aceita se o hash coincidir com a fonte atual. Mudanças editoriais exigem novo Shadowing e novo pacote. Não existe aprovação automática.
- A importação grava `data/projects/<project_id>/materials/external-draft.json`; a aprovação grava `approved.json`. Nova importação invalida aprovação anterior.
- Para Shadowing, cada cena aprovada é gravada em `data/projects/<project_id>/shadowing/<scene_id>.json`. A aplicação não modifica os cues editoriais.
- Todos os arquivos são locais e permanecem fora do Git. Os arquivos JSON devem ser incluídos no backup conjunto do projeto.
- Teste estrutural: `python -m pytest tests/contracts/test_materials_ai_contract.py`.
- Testes da máquina de estados: `python -m pytest tests/application/test_post_editorial_materials.py`.

**Estado de implementação:** geração e validação de dados, prévia de Shadowing e revisão dos materiais estão sendo entregues nesta etapa. A transformação desse novo conteúdo no PDF final e a associação dos cards enriquecidos com o exportador Anki existente exigem uma entrega posterior e teste integrado.
