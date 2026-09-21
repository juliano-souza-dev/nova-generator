# ADR 0002: Contrato de entrada ZIP do modo História

**Status:** aceito em 2026-09-21

## Contexto

História é uma produção independente. O legado define um ZIP com `story.json`
e imagens, mas não fornece uma fronteira de domínio reutilizável para validar
esse conteúdo antes de extração, TTS ou renderização.

## Decisão

O domínio novo expõe `validate_story_package`, que recebe o ZIP sem extraí-lo e
aceita somente o contrato privado `generator-story` 1.0:

- um único `story.json` em UTF-8;
- imagens JPG, JPEG, PNG ou WebP em `images/`, declaradas por uma cue;
- no máximo 80 imagens, 20 MiB por imagem e 200 MiB descompactados;
- cues sequenciais a partir de 1, com `en`, `pt`, imagem e highlights;
- highlights literais, com tipo e ocorrência explícita no texto EN.

Paths absolutos, travessia de diretórios, symlinks, entradas duplicadas e
arquivos fora do contrato são rejeitados. EN/PT, pontuação e Unicode são
mantidos literalmente, sem normalização.

## Consequências

- A validação é testável sem FastAPI, SQLite, TTS, FFmpeg ou extração em disco.
- O chamador recebe diagnósticos por arquivo/cue/campo e só pode extrair depois
  de uma validação bem-sucedida.
- Limites de resolução de imagem e a extração em diretório de produção serão
  adicionados pelo adaptador de mídia quando Pillow/FFmpeg fizerem parte da
  fatia correspondente.
