# ADR 0001: Backend modular e migração incremental do legado

**Status:** aceito em 2026-09-21

## Contexto

`legacy/generator-base` contém o comportamento atual, concentrado em scripts e uma aplicação FastAPI monolítica. Ele é referência de regras já observadas, mas não é o local para novas funcionalidades. A nova base precisa permitir que domínio, casos de uso, HTTP, banco, mídia e provedores externos evoluam sem dependências circulares.

## Decisão

O backend novo vive em `src/nova_generator` e segue estas fronteiras:

- `domain`: entidades e regras sem FastAPI, SQLAlchemy, filesystem ou SDKs;
- `application`: casos de uso e portas expressas por protocolos;
- `infrastructure`: adaptadores concretos, inicialmente SQLAlchemy/SQLite;
- `api`: rotas FastAPI, modelos de transporte e injeção de dependências;
- `core`: configuração transversal.

SQLite é o armazenamento inicial e somente Alembic altera seu schema. A primeira migration cria `jobs`, o mecanismo durável que receberá filas, locks e retomada sem amarrar os futuros casos de uso a um worker específico.

Uma capacidade é migrada do legado por fatia vertical: caracterizar o comportamento com testes ou fixtures, criar caso de uso e portas na base nova, adaptar infraestrutura, validar compatibilidade e só então retirar a rota antiga quando houver plano de transição aprovado.

## Consequências

- O legado não recebe funcionalidades novas.
- O endpoint `GET /api/health` confirma API e banco sem expor detalhes internos.
- Casos de uso podem ser testados com doubles, sem servidor ou SQLite.
- O banco local é criado por `alembic upgrade head`; `Base.metadata.create_all()` não é caminho suportado.
- A implementação da fila, cache de vídeo e mídia deve usar as fronteiras aqui estabelecidas e ganhar ADRs próprios quando as decisões forem irreversíveis.
