# ADR 0027: unidades semânticas no word by word

## Status

Aceito.

## Contexto

Traduzir cada token isoladamente produz construções artificiais. Em **Can I help?**, concatenar
“posso” + “eu” + “ajudar” não representa a tradução natural **Posso ajudar?**. O projeto legado
resolvia isso associando palavras contíguas, mas o novo domínio precisava preservar proveniência e
desfazer a operação sem reconstruir timings.

## Decisão

Palavras contíguas podem formar uma unidade identificada por `semantic_group_id`. A primeira palavra
é `lead` e guarda a tradução natural completa em `pt`; as demais são `member` e não repetem nem
fragmentam essa tradução. Ao agrupar, cada palavra preserva sua tradução anterior em `pt_original`.
Ao desfazer, os valores individuais são restaurados.

O agrupamento não altera IDs, ordem ou timings. A interface destaca todos os membros, reproduz o
intervalo completo como uma unidade e permite ajustar seus limites externos. Sugestões automáticas
devem entender o cue inteiro antes de propor essas unidades; nunca devem produzir a tradução pela
concatenação de tokens.

## Consequências

- Expressões, collocations, phrasal verbs e estruturas gramaticais podem ter português natural.
- Exportadores podem ler a tradução no membro `lead` e relacionar os demais pelo identificador.
- Não há migration: os campos vivem na proveniência já versionada e palavras antigas continuam
  válidas sem grupo.
- O rollback é desfazer o grupo, restaurando `pt_original` sem tocar nos tempos.
