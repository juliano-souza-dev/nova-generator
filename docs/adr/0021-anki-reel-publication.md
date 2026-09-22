# ADR 0021: Publicação manual do reel Anki no iHub

## Decisão

Uma exportação de materiais concluída gera APKG, reel e manifesto congelado. Após o operador subir o reel ao YouTube, a API exige confirmação e URL/ID validado para criar `hub_final.json` em `projects/<project_id>/publications/<export_job_id>/`. O Generator não faz upload.

O documento contém `kit`, `project`, `cues` selecionadas em ordem, texto EN/PT aprovado literalmente, itens Anki e palavras com timing revisado. `ankiAudio` mantém a timeline do reel e o ID do vídeo manual, conforme o contrato Generator–iHub v1. O vídeo de origem do projeto continua em `kit.youtube` quando existir; assim, cues e palavras mantêm os tempos da fonte, enquanto cards Anki usam o reel. Uma produção sem vídeo de origem usa o reel também como vídeo do kit.

O payload fornece `cues[].start/end` em segundos porque o importador iHub dá prioridade a esses campos. Em imersão, são tempos absolutos da fonte; em música, são relativos a `kit.scene_start_ms`, que o iHub soma uma única vez. `words[].start_ms/end_ms` e os tempos originais de cada palavra seguem a mesma convenção. Os campos `*_ms` de cue acompanham essa coordenada, e `ankiAudio` permanece independente na timeline do reel. Isso evita a inferência ambígua de offset do importador quando um recorte começa depois de zero.

A API compara hashes de EN, PT, WAV, APKG, reel e snapshot de voz com a exportação antes de publicar. O job também congela uma impressão digital do projeto, cenas, cues, timings e palavras selecionadas. O worker confere essa impressão antes de exportar; o publicador a confere novamente antes de gerar `hub_final.json`. Se houver edição depois da seleção, é preciso criar outra exportação. Jobs antigos sem essa impressão devem ser exportados novamente para publicação. Uma exportação não pode ser vinculada a outro vídeo depois da primeira publicação; para corrigir o vínculo ou conteúdo, cria-se nova exportação. O arquivo é gravado por substituição atômica e a mesma requisição é idempotente.

## Recuperação

Se o upload ou ID estiver errado antes da publicação, corrija o campo e tente novamente. Se o ID já foi publicado, crie nova exportação e publique com o vídeo correto. Se texto, voz ou WAV mudou, reprocesse os cards e exporte novamente. O `hub_final.json` anterior fica disponível para auditoria na exportação original.
