# Contrato de segmentação editorial externa 1.5

A versão `nova-generator-editorial-suggestions/1.5` aceita todas as regras de
revisão lexical, traduções e unidades semânticas da versão 1.4. A lista de
`suggestions` continua contendo uma entrada por cue **de origem**.

## Alteração

Cada suggestion admite `speaker_turns`, lista opcional inicialmente vazia.
Quando houver mudança de interlocutor, devem ser enviados pelo menos dois
objetos na ordem do áudio:

```json
{
  "speaker_turns": [
    {"word_ids": ["id-1","id-2"], "speaker": "speaker_1", "approved_pt": "Sou eu, Liam!", "confidence": "medium"},
    {"word_ids": ["id-3","id-4"], "speaker": "speaker_2", "approved_pt": "Liam, desça!", "confidence": "high"}
  ]
}
```

O exemplo usa identificadores ilustrativos. Os identificadores reais são os
`word_id` do input do mesmo bloco. Nenhuma palavra pode faltar, repetir-se,
cruzar grupos ou trocar de ordem. Os turnos devem particionar integralmente a
cue original. O texto em português de cada turno é obrigatório e deve ser natural;
o campo geral `approved_pt` continua obrigatório para validação da suggestion.

Os IDs das palavras e seus timestamps **não são recriados**. O primeiro segmento
começa no início original da cue e o último termina no final original; as
fronteiras internas são os `start_ms` e `end_ms` das palavras pertinentes.
Intervalos de silêncio são preservados, sem sobreposição. IDs de cue novos são
determinísticos por cue original, hash do input e índice do turno. A substituição
da cena e a revisão editorial acontecem em uma única atualização atômica.

`confidence` aceita `high`, `medium` ou `uncertain`. Quando o ZIP não inclui
áudio, a IA deve reconhecer a incerteza da diarização: nomes podem ser
mencionados sem indicar quem está falando. Sem evidência suficiente, não dividir;
usar `speaker_turns: []` e explicar em `notes`.

A importação de resultados 1.3 e 1.4 continua disponível. Novos pacotes
exportados em blocos usam 1.5. Importações antigas não podem dividir cues.

## Reprocessamento da mídia

`POST /projects/{project_id}/media/refresh-source?confirm_reset=true`
força novo download e inspeção da fonte, mantendo a cópia verificada anterior
até a instalação atômica da nova.

`POST /projects/{project_id}/media/reprocess` com o intervalo de corte e
`confirm_reset: true` enfileira nova transcrição. As duas operações zeram as
cues editoriais provenientes do ASR depois de enfileirar o job. Nenhum projeto,
cena independente, vídeo global ou trabalho de outros projetos é excluído.

A revisão editorial deve acontecer novamente após a nova transcrição. Os
artefatos exportados/publicados anteriormente **não são despublicados** por
essas operações, e precisam ser regenerados antes de republicação.
