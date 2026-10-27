# ADR 0036 — TikTok Mídia como estúdio isolado de conteúdo vertical

## Contexto

O Generator possui edição editorial, download/corte/ASR, perfis de voz com cache Chatterbox e workers persistentes para FFmpeg. Conteúdo para redes sociais tem tempo, layout, aprovação e destino distintos do pacote iHub.

## Decisão

Criar `/tiktok-media` com projetos próprios no diretório configurado `media_cache_root/tiktok-media/<uuid>`, modelo `nova-tiktok-media/1`, número de revisão otimista e escrita atômica. Nenhuma tabela, cue aprovada, contrato Generator–iHub ou projeto preexistente é alterado.

A UI edita quadros no canvas em 1080×1920, que é a mesma implementação usada na imagem exportada. Os estilos iniciais cobrem abertura, aula, exemplo, desafio e letra/tradução. O projeto pode importar cópias de cues já revisadas das APIs Editorial existentes (sem modificá-las); recortes, inspeção, download e transcrição continuam na área Mídia. A troca de projeto exige salvar primeiro. A interface salva automaticamente e expõe Ctrl+S.

Carrossel: exportação de imagens PNG dentro de ZIP. Vídeo: após salvar uma revisão, o browser envia PNGs rasterizados e a API congela um snapshot imutável (revisão, hash de cada imagem e, se houver, áudio/voz). O worker persistente `tiktok.render` reutiliza `SynthesizeSpeech` e o cache local de voz para narração; vídeos com música fornecida são montados no FFmpeg. A conversão produz MP4 H.264/AAC, manifesto com hashes, duração real e revisão. Falhas de render ou voz não modificam projetos nem revisões anteriores. A publicação no TikTok é manual.

IA: Groq opcional sugere roteiro em JSON, com validação e revisão humana. Sem Groq, é possível importar JSON de IA externa. Sugestão não vira conteúdo aprovado automaticamente. Não há dedução de licença de músicas/trechos de terceiros.

## Segurança e limites da primeira fatia

- Máximo de 30 quadros, 1–20 s por quadro e PNGs de até 8 MiB; áudio MP3/WAV/OGG até 50 MiB, verificado com FFprobe.
- O projeto e as imagens de cada render ficam congelados por UUID e SHA-256. O worker valida antes de renderizar e publica o manifesto por troca atômica.
- A renderização usa imagens geradas pela UI, não executa HTML de terceiros. Prompt e JSON de IA externa são apenas dados.
- Os controles avançados de recorte e ASR permanecem nos módulos existentes, acessíveis pela interface; timeline multicamada, keyframes, vídeo de fundo e karaoke palavra-a-palavra são expansões posteriores.
- Não alterar `hub_final.json` nem `immersionhub-text-audio`.

## Recuperação

Se o render falhar, conferir o job em **Jobs**, corrigir áudio/voz/quadro e iniciar nova exportação. Um job pode ser retentado com o mesmo snapshot pelo worker. Se uma gravação retornar 409, recarregar a versão persistida antes de continuar. O render anterior permanece sob seu ID; nenhuma exportação substitui o MP4 de outra revisão.

## Verificação

Modelo e revisões: `tests/test_tiktok_media.py`. JSON externo: `frontend/src/features/tiktok-media/tiktok-api.test.ts`. Gates existentes de Pytest, Ruff, Pyright, TypeScript, Vitest, lint, Prettier e build continuam obrigatórios.
