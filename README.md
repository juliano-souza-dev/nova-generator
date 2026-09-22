# Nova Generator

Nova Generator é a reestruturação do sistema de produção de conteúdo para o iHub. A implementação nova será construída em módulos, preservando a compatibilidade dos fluxos que já funcionam.

## Base de referência

O código atual foi importado em `legacy/generator-base/`. Ele é uma **referência de comportamento e regras de negócio** para a migração; novos módulos não devem ser adicionados nele.

Não foram importados artefatos locais e gerados: ambientes Python, cache, projetos, workspace, backups, configurações locais e logs. Consulte `legacy/generator-base/README.md` e os testes existentes antes de migrar uma função.

## Como usar os agentes

Leia [`AGENTS.md`](AGENTS.md) e o [mapa de uso](agentes/MAPA_DE_USO.md). Cada tarefa deve indicar o agente responsável e os revisores apontados no mapa. Quando uma mudança afetar regras, contratos ou critérios de aceite de uma frente, atualize o respectivo arquivo em `agentes/` no mesmo commit.

## Estratégia de migração

1. Caracterizar o comportamento legado com testes e fixtures.
2. Criar a nova implementação fora de `legacy/`.
3. Migrar uma jornada vertical por vez, mantendo exportações compatíveis.
4. Só remover ou aposentar uma parte do legado após validação de equivalência e plano de rollback.

## Frontend do estúdio

O frontend independente está em `frontend/`; ele não usa arquivos do diretório `legacy/` em runtime.

```powershell
cd frontend
npm install
npm run dev
```

O Vite encaminha `/api` para `http://127.0.0.1:8000` no desenvolvimento. Use
`npm run build`, `npm run lint`, `npm run test` e `npm run test:e2e` para validar a aplicação.
