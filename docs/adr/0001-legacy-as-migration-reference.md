# ADR 0001: preservar o Generator atual como referência de migração

## Contexto

O sistema em `C:\generator` contém fluxos de produção já usados pelo iHub, porém está concentrado em módulos e páginas estáticas grandes. A reestruturação exige arquitetura modular sem perder comportamento aprovado.

## Decisão

O código-fonte e os testes do sistema atual ficam em `legacy/generator-base/`. Novos módulos são criados fora de `legacy/`. Cada migração começa identificando o comportamento, exportador, tela e teste legado envolvidos e termina com fixture ou teste de caracterização no código novo.

Ambientes, mídia baixada, projetos de usuário, cache, configurações locais, workspaces, backups e logs não entram no Git.

## Consequências

- O histórico de comportamento fica disponível para agentes e revisores.
- O legado não recebe funcionalidades novas.
- Uma divergência intencional exige ADR, critério de aceite e plano de compatibilidade ou migração.
- A remoção de qualquer parte do legado só ocorre após equivalência validada e rollback definido.
