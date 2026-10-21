# Anki na primeira exportação externa · v1

O ZIP de exportação editorial inclui obrigatoriamente `anki/anki-ai-input.json` e `anki/anki-ai-prompt.md` e um modelo `anki/anki-ai-result-template.json`. A IA externa deve devolver `anki/anki-ai-result.json` **junto** com os JSONs editoriais preenchidos (`chunks/*-result.json`) na mesma resposta ZIP. O modelo de resultado é um guia, não um resultado válido enquanto não estiver preenchido.

**Contrato de saída obrigatório:** `nova-generator-anki-proposal/1.0`, com `scene_id`, `input_sha256` copiados literalmente e `anki_cards` com 1–50 cards selecionados por relevância pedagógica. Se a cena não tiver conteúdo útil, não inventar falas: registrar a limitação e solicitar revisão, em vez de falsificar IDs.

Cada card requer `cue_id`, `front_en`, `back_pt`, `card_type`, `focus_text`, `meaning`, `marked_en`, `marked_pt`, `explanation_pt`, `example_en`, `example_pt`, `tags`. Selecionar apenas falas úteis (phrasal verbs, expressões, construções e vocabulário contextual), não transformar cada palavra em card. A mini-aula em PT deve explicar o uso *na cena*, não apenas traduzir. Adicionar um exemplo novo EN/PT natural.

- `cue_id` deve apontar para a **cue existente na exportação inicial**, nunca inventada. Uma cue pode gerar no máximo um card nesta versão.
- `front_en` e `back_pt` precisam ser **literalmente iguais** a `approved_en` e `approved_pt` devolvidos no resultado editorial daquela mesma cue, incluindo espaços e pontuação. Sem recortar ou parafrasear a frente/verso.
- `focus_text` e `meaning` explicitam o foco da mini-aula. `marked_en` e `marked_pt` devem aparecer como substrings literais em `front_en` e `back_pt`, respectivamente. Destaques não são texto novo.
- `example_en` e `example_pt` formam um par e devem ilustrar o sentido da expressão em contexto diferente da cena.
- `card_type` identifica tipo pedagógico, p.ex. EXPRESSION, PHRASAL_VERB, QUESTION ou VOCABULARY. `tags` são rótulos curtos.
- Proibido inventar conteúdo de cenas, IDs, mídia, áudio, URLs, durações ou TTS. O arquivo prepara *conteúdo pedagógico*, não gera APKG nem reel.
- O conteúdo Anki é rascunho humano-editável e não pode sobrescrever texto editorial nem ser aprovado automaticamente. Após editar/mesclar cues, o sistema deve reconciliar o conteúdo pelo `cue_id` e exigir revisão quando a identidade ou a frase mudar.

A importação em lote pré-valida os chunks editoriais **e** o Anki, grava o material preliminar em `data/projects/<project_id>/materials/anki-prepared.json` e preserva a aprovação editorial separada. Os pacotes antigos sem Anki continuam legíveis; o novo formato é exigido quando o ZIP de retorno traz o `manifest.json` com `anki.required=true`.

Esse é um contrato específico para Anki e **não substitui** o contrato de workbook/PDF de sete seções `contracts/materials-ai/v1`. O Anki preparado deve ser reutilizado na etapa Materiais, sem pedir à IA que o reescreva. Não publicar card antes da revisão final.
