# ADR 0038 — Substituição integral do editorial pelo ZIP do proprietário

## Status

Aceita pelo proprietário em 30/10/2026.

## Contexto

O fluxo ordinário compara o retorno com o estado atual da cena e bloqueia
pacotes completos que o proprietário deseja usar para regenerar as cues.

## Decisão

- Um ZIP com manifesto, cues, palavras e todos os resultados editoriais
  internamente consistentes pode substituir integralmente a cena, sem depender
  de hash, quantidade de cues ou IDs da cena atual.
- O resultado Anki é opcional nessa operação: quando presente, é validado e
  atualizado; quando ausente, não bloqueia as cues nem sobrescreve o Anki anterior.
- Traduções vazias de palavras não bloqueiam a substituição e permanecem
  pendentes (sem tradução inventada). Inglês, tradução da cue, identidades,
  ordem e tempos das palavras continuam sendo validados. A importação ordinária
  conserva a exigência de traduções individuais preenchidas.
- O modo de substituição é uma operação explícita do importador de ZIP; arquivos
  JSON e os contratos de importação ordinária mantêm seu comportamento.
- O banco valida toda a nova cena antes da troca e grava uma única revisão
  auditável, preservando o projeto, a mídia e o corte.
- Pacotes incompletos ou inválidos não alteram a cena; reenvios idênticos são
  idempotentes e conflitos de escrita simultânea são comunicados.

## Recuperação

O histórico de revisões do editorial conserva o snapshot anterior, permitindo
restaurar as cues. A mídia e o recorte não são substituídos.
