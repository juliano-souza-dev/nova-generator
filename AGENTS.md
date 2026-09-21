# Nova Generator: coordenação de agentes

Este repositório usa especialistas documentados em `agentes/`. Sistemas de IA devem ler `agentes/README.md` antes de iniciar uma tarefa e, em seguida, o arquivo do especialista aplicável.

## Regras comuns

- Trabalhar em fatias verticais, com critérios de aceite verificáveis.
- Não alterar um contrato Generator–iHub sem versão, fixture, compatibilidade e aprovação da integração.
- Texto editorial aprovado é literal: não normalizar, reconstruir ou perder Unicode, acentos ou pontuação.
- Toda operação longa deve ser retomável, observável e idempotente.
- Toda mudança estrutural precisa de um ADR em `docs/adr/`.
- Uma entrega só está pronta com testes pertinentes, logs úteis e instrução de recuperação quando houver job, mídia ou migration.

## Mapa e sincronização dos agentes portáteis

O mapa operacional está em `agentes/MAPA_DE_USO.md`. Ele relaciona cada tipo de mudança ao agente responsável, aos revisores obrigatórios e aos artefatos que precisam mudar juntos.

Cada agente que alterar código, contrato, schema, processo ou critério de qualidade deve, no mesmo conjunto de mudanças:

1. atualizar seu arquivo em `agentes/` quando a alteração mudar responsabilidade, limite, entrada, saída ou aceite;
2. atualizar `agentes/MAPA_DE_USO.md` se mudar o roteamento ou os revisores obrigatórios;
3. registrar uma ADR em `docs/adr/` quando a decisão for estrutural;
4. incluir no pull request a seção `Agentes portáteis atualizados`, apontando os arquivos alterados ou explicando por que não houve mudança.

Os arquivos em `agentes/` são a fonte de instruções reutilizável por qualquer sistema de IA. Código e documentação de produto devem sempre refletir as regras registradas neles.

## Roteamento

Use um agente principal por tarefa. Acione também o agente de integração e release quando a mudança tocar contratos, schema, exportação, importação ou publicação.
