# ADR 0008 — Ingestão produz candidatos editoriais imutáveis

## Contexto

O ASR pode errar texto, segmentação e tempo. Cues aprovados preservam texto literal,
pontuação, acentos e traduções, portanto não podem ser substituídos por uma nova rodada
de Whisper.

## Decisão

O corte da fonte fica no diretório do projeto; a fonte global do YouTube nunca é alterada.
FFmpeg gera picos de waveform pré-calculados. Faster-Whisper/CTranslate2 roda em um
worker persistente e retorna `TranscriptCandidate`, separado de `Cue` e `WordTiming`.
Uma ação editorial explícita é necessária para aplicar qualquer sugestão.

## Consequências

Falhas e novas execuções de ASR não corrompem material aprovado. A interface pode comparar
candidato e revisão aprovada sem reconstruir ou normalizar o texto.
