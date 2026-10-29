# Cards independente · v1

Fluxo separado de Projetos, Editorial e Materiais.

## Entrada JSON
Aceita um objeto com `anki_cards` (resposta de materiais), `cards` (cards
preparados), `source.anki_prepared` (material-input) ou
`cues[].anki.items` (publicação IHUB). Os cards precisam conter todos os
campos didáticos de `DidacticAnkiCard`. A importação preserva `front_en`,
`back_pt`, `focus_text`, `meaning`, `marked_en`, `marked_pt`,
`explanation_pt`, `example_en`, `example_pt`, `card_type` e `tags`.

Para um JSON que contém somente source.scenes[].cues (ou cues[] com EN/PT),
POST /cards-only/generate solicita ao Groq um rascunho de mini-aulas,
**somente cards**. O serviço preserva o texto original e valida cada destaque.
O resultado é revisável na interface e pode então ser importado para exportação.
Essa geração requer Groq configurado e suporta até 20 falas por requisição.

O importador não inventa traduções ou lições, e reprova destaques fora do
texto, foco ausente do contexto e IDs repetidos. O JSON pode conter as sete
seções de materiais; elas são ignoradas nesta exportação.

## Fonte do card
É obrigatório indicar **um** dos tipos:
- YouTube: URL canônica guardada no JSON. O áudio não é falsamente atribuído
  a uma frase didática diferente da fonte. A URL depende do consumo por um
  cliente compatível.
- MP3 ou WAV enviado: o arquivo original, validado pelo ffprobe e hash,
  acompanha o ZIP em `audio/source.mp3` ou `audio/source.wav`.

O Anki gera um WAV canônico por card usando a voz selecionada e o texto exato
`front_en` (motor `SynthesizeSpeech` e cache local existente). Isso evita
usar o áudio original de outra frase como pronúncia da mini-aula.

## Exportação
A tarefa durável `cards-only.export` cria:
- `anki.apkg` usando `GenankiPackageWriter` e modelo `ihub-didactic-v3`;
- `cards.json` com `contract=nova-generator-cards-only/1.0`, metadados
  da fonte, conteúdo dos cards e os mesmos campos de `anki.items`
  publicados pelo generator no IHUB;
- `audio/anki_<id>.wav` para cada card;
- `audio/source.mp3|wav` apenas quando importado;
- `cards-only.zip` contendo esses itens, sem workbook, PDF, shadowing, reel
  ou qualquer outra parte do kit completo.

A exportação usa um snapshot isolado de dados, revisão por hash e publicação
atômica do manifesto depois de gerar o ZIP. IDs de jobs não são nomes
controlados por quem faz o upload.

**Observação de integração**: `cards.json` é um contrato cards-only. O
importador do IHUB precisa reconhecer esse novo envelope para importar
diretamente como cards isolados. Isto não altera, nem substitui, o formato
atual de `hub_final.json`.
