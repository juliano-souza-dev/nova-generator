# ADR 0043 — Roteiro de narração independente por quadro

## Contexto

O TikTok Mídia sintetizava exclusivamente o texto EN (ou PT como fallback) durante a exportação. Esse texto é pensado para leitura na tela e não representa uma locução natural em português, com explicações, pausas e transições. A geração da narração depois da revisão visual precisa começar com uma fonte textual independente.

## Decisão

- Cada quadro pode armazenar `narration_text` opcional, preservado literalmente, até 2.000 caracteres.
- O texto exibido (EN/PT, destaque e nota) permanece intacto quando o roteiro muda.
- Na exportação em modo de voz, o sintetizador lê `narration_text` quando preenchido; os projetos anteriores continuam usando EN, ou PT como fallback.
- A duração do segmento continua sendo ampliada automaticamente quando a fala sintetizada precisa de mais tempo. O vídeo não comprime a voz para caber em uma duração arbitrária.
- Nenhuma alteração é feita nos contratos Generator–iHub; o novo campo é aditivo e opcional no contrato TikTok Media v1.

## Limites desta entrega

Esta fatia estabelece a separação entre roteiro falado e texto visual. Prévia de áudio por quadro, cache de takes aprovados, perfis expressivos e regeneração seletiva serão incrementos próprios, com jobs de TTS locais e testes de mídia. Até lá, a locução segue sendo gerada no render, como antes.

## Verificação

- Teste de serialização literal de roteiro, sem alterar EN/PT.
- Rejeição de roteiro acima do limite.
- A exportação antiga preserva seu fallback quando `narration_text` está vazio.

## Agentes portáteis atualizados

Sem alteração: a responsabilidade permanece com 03 Mídia e TTS Local e a compatibilidade com 05 Integração e Release.
