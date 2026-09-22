# ADR 0009: revisão de História antes do render

## Decisão

O upload multipart valida o ZIP integralmente antes de criar uma produção. O ZIP aprovado é guardado em `media_cache/stories/<id>/package.zip`, e a API retorna cues, traduções, highlights e imagens para revisão. O worker recebe um snapshot versionado da voz no input do job, materializa somente imagens validadas e grava vídeo e manifesto em `render/`. A publicação manual exige vídeo e manifesto presentes, valida o ID do YouTube e o contrato público antes de gravar `publication.json`.

## Motivo

O operador precisa corrigir erros por campo sem consumir TTS ou vídeo, revisar textos literais e repetir um job após falha sem perder o pacote aprovado. O snapshot no job impede que uma nova versão de voz altere o som de um render já enfileirado.

## Recuperação

Um ZIP inválido não cria produção. Após corrigir o arquivo, envie novamente. Para falhas de render, consulte o monitor de jobs e repita o job; o pipeline reutiliza cues cujos hashes e artefatos ainda são válidos. Se a publicação falhar, confira o manifesto e informe novamente o URL ou ID do YouTube.
