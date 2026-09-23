# ADR 0026: separar salvamento editorial de aprovação

## Status

Aceito.

## Contexto

A rota de edição do texto marcava todo candidato ASR como aprovado. Na interface, isso fazia o
botão **Salvar alterações** aprovar o cue silenciosamente e impedia salvar um rascunho enquanto a
tradução ainda estava vazia. Materiais e publicação também podiam consumir texto completo que o
editor havia retornado ao estado de rascunho.

## Decisão

O comando de texto recebe `approve`, com valor padrão `true` para preservar os clientes existentes.
A estação editorial envia o valor explicitamente: `false` ao salvar e `true` ao aprovar. Aprovação
continua exigindo EN e PT preenchidos; rascunhos preservam literalmente o Unicode recebido e podem
estar incompletos.

Qualquer edição salva com `approve=false` define `provenance.approval` como `draft`. Uma aprovação
define `approved`. A listagem de materiais, o worker e a publicação rejeitam apenas o estado
explicitamente `draft`; cues legados sem esse campo continuam compatíveis.

## Consequências

- Salvar e aprovar passam a ser ações distintas e auditadas como `edit_draft_text` e
  `edit_approved_text`.
- Alterar um cue já aprovado e salvá-lo como rascunho o retira dos materiais até nova aprovação.
- Não há migration: o estado permanece no JSON de proveniência existente.
- O rollback consiste em omitir `approve` no cliente e remover os gates de `draft`; o valor padrão
  mantém o comportamento anterior durante uma transição.
