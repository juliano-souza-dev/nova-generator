# ADR 0004: persistência editorial com snapshots e hashes literais

**Status:** aceito em 2026-09-21

## Contexto

O legado guarda a jornada editorial em arquivos JSON por workspace. A nova base
precisa compartilhar projetos entre etapas sem perder acentos, Unicode,
pontuação, texto aprovado ou a origem de palavras e timings.

## Decisão

SQLite passa a guardar `projects`, `scenes`, `cues`, `word_timings` e
`editorial_revisions`. O domínio fica em `domain/projects`, separado de
SQLAlchemy e FastAPI. Cada campo editorial EN/PT é salvo como `Text` literal e
com seu SHA-256 UTF-8. Timings e payloads recebidos do legado ficam em colunas
próprias e em `provenance_json`.

Uma importação de JSON canônico do legado usa UUIDs determinísticos derivados
da chave de migração. Ela pode ser repetida e grava uma revisão inicial com
snapshots antes/depois e hashes, permitindo que uma futura interface implemente
reversão sem depender de arquivos de workspace.

## Consequências

- A migration `20260921_0002` possui downgrade para a plataforma inicial.
- Novas alterações editoriais devem criar `EditorialRevision`, nunca sobrescrever
  texto aprovado sem histórico.
- `projects/` de runtime continua ignorado; a exceção no `.gitignore` permite o
  pacote Python `src/nova_generator/domain/projects`.
