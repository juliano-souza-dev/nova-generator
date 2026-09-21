# Nova Generator: coordenação de agentes

Este repositório usa especialistas documentados em `agentes/`. Sistemas de IA devem ler `agentes/README.md` antes de iniciar uma tarefa e, em seguida, o arquivo do especialista aplicável.

## Regras comuns

- Trabalhar em fatias verticais, com critérios de aceite verificáveis.
- Não alterar um contrato Generator–iHub sem versão, fixture, compatibilidade e aprovação da integração.
- Texto editorial aprovado é literal: não normalizar, reconstruir ou perder Unicode, acentos ou pontuação.
- Toda operação longa deve ser retomável, observável e idempotente.
- Toda mudança estrutural precisa de um ADR em `docs/adr/`.
- Uma entrega só está pronta com testes pertinentes, logs úteis e instrução de recuperação quando houver job, mídia ou migration.

## Roteamento

Use um agente principal por tarefa. Acione também o agente de integração e release quando a mudança tocar contratos, schema, exportação, importação ou publicação.

