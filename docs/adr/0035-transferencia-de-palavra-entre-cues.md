# ADR 0035 — Transferência atômica de palavra entre cues vizinhas

## Status

Aceita.

## Contexto

Uma palavra reconhecida na cue seguinte pode pertencer editorialmente à anterior.
O fluxo de merge/split recriava cues e exigia reescrever material para corrigir
uma única fronteira. A waveform já permite ajustar IN/OUT em milissegundos.

## Decisão

- O ajuste local de IN/OUT pode atravessar o limite de uma cue. Quando, ao soltar
  o marcador, a palavra inicial/final fica inteiramente contida na cue vizinha,
  o editor solicita sua transferência em uma única operação.
- O backend verifica a adjacência, a posição da palavra na borda, o intervalo,
  a ordem cronológica, a ausência de sobreposição e a revisão esperada.
- A transação preserva o ID da palavra, seus tempos originais, a proveniência e
  os IDs das duas cues. Atualiza `cue_id`, ordem, timing revisado, texto inglês
  literal e os limites necessários. Um snapshot de revisão permite desfazer.
- As duas cues voltam a rascunho. Quando a tradução já existente da palavra
  coincide literalmente com a borda da frase PT, essa expressão pode acompanhar
  a transferência; caso contrário, preserva-se o texto sem reescrita especulativa.
  Em ambos os casos, os textos portugueses e as traduções por palavra exigem
  revisão contextual. A publicação depende da aprovação editorial posterior.
- Não se permite transferir a única palavra de uma cue, cruzar grupos semânticos
  ativos ou reconstruir silenciosamente texto que difira dos tokens persistidos.

## Critérios de aceite

- Arrastar os dois marcadores até a cue vizinha move a palavra sem split/merge.
- Arrastar apenas um marcador não dispara uma transferência prematura.
- Erros não alteram a base; a operação bem-sucedida aparece imediatamente no
  editor e é reversível pela revisão estrutural.
- As demais cues, IDs, tempos originais e pontuação persistida ficam intactos.
