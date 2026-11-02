# ADR 0039 — Legibilidade e revisão da exportação TikTok Media

## Problema observado

Um MP4 de 55 segundos podia mostrar uma frase cortada pelo efeito de lápis,
tradução já completa e a animação de inglês ainda vazia. Havia também
intervalos de até dez segundos apenas com fundo, apesar do áudio contínuo.
O operador não recebia alerta de cobertura antes de exportar.

## Decisão

1. O preset editorial `handwriting` continua válido nos projetos antigos, mas
   passa a exibir **a frase completa desde o início** com entrada suave, em vez
   de recortar caracteres ou desenhar um lápis sobre o texto. Não se modifica EN/PT.
2. O editor identifica lacunas de pelo menos 800 ms entre legendas ativas e
   permite saltar para conferi-las. Pausas continuam sem texto: nenhuma fala é
   inventada ou deslocada automaticamente.
3. A exportação de vídeo de origem recebe uma opção independente e retrocompatível
   `end_at_last_caption` (default `false` na API). Na UI ela é sugerida se houver
   cauda de pelo menos 800 ms. Como alternativa, `add_outro` acrescenta até
   3,5 s de cartão final IHUB no intervalo livre. O corte congelado segue íntegro;
   só o MP4 final muda de duração. A duração final consta no manifesto.
4. Acrescentar `aurora` como opção de fundo no contrato TikTok v1: um gradiente
   animado via FFmpeg `gradients` em substituição ao papel estático. O áudio
   original e o intervalo relativo de cada legenda permanecem intactos.
5. Melhorar a qualidade do MP4 H.264 para CRF 19 e AAC a 192 kb/s. O editor
   mantém a escolha explícita entre vídeo, fundo com áudio e silêncio.
6. A aba de revisão de texto permite importar um JSON do contrato existente
   `nova-generator-materials-output/1.0`, associar cartões Anki à fala por ID
   ou expressão e **pré-visualizar** o texto didático antes de aplicá-lo.
   Somente `highlight` e `note` mudam após confirmação; EN/PT e tempos ficam
   intocados. Explicações acima do limite de 300 caracteres são descartadas
   com contagem explícita para revisão manual.

## Compatibilidade e recuperação

- Não há mudança no contrato Generator–iHub ou nas aprovações editoriais.
- Projetos antigos carregam sem migração, inclusive os que usam `handwriting`.
- Clientes antigos que não enviam `end_at_last_caption` conservam a duração integral.
- Se `gradients` não estiver presente no FFmpeg local, o job informa erro;
  o operador pode escolher papel noturno e repetir a exportação sem perder o render anterior.

## Verificação

- `tests/test_tiktok_source_video.py`: exportação sem lápis, cenários de cauda
  mantida/encurtada, novo fundo e temporização literal.
- `frontend/src/features/tiktok-media/caption-coverage.test.ts`: lacunas, cauda
  e blocos desativados.
- Testes de interface do estúdio: estilos e fundo Aurora.

## Agentes portáteis atualizados

Sem alterações: mídia, UX e integração já contemplam legendas, fundos,
renderização e compatibilidade nas instruções existentes.
