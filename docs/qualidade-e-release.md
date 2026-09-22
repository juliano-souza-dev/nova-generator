# Qualidade e release

Este documento define os gates para código novo do Nova Generator. O diretório
`legacy/` é referência de migração e não faz parte dos linters ou da análise de tipos.
Pyright roda em modo de baseline durante a migração; novos pacotes devem elevar a checagem para
`basic` quando suas anotações e dependências estiverem estabilizadas.

## Validação local

Execute a partir da raiz do repositório:

```powershell
python -m pip install -e ".[dev]"
python -m ruff check src tests
python -m pyright
python -m pytest
python -m nova_generator.infrastructure.integration.contract_runner
python -m pytest tests/contracts editorial_contracts/v1/tests
```

Para o frontend:

```powershell
cd frontend
npm ci
npm run format:check
npm run lint
npm run test
npm run build
npx playwright install chromium
npm run test:e2e
```

O workflow [`.github/workflows/quality.yml`](../.github/workflows/quality.yml) executa
os mesmos gates em pull requests e em commits na `main`.

## Checklist de release

Antes de liberar uma versão, o responsável por Integração e Release registra a evidência
de cada item abaixo na pull request ou nas notas de release.

### Banco e jobs

- [ ] Migration Alembic foi aplicada em uma cópia do banco de produção e o downgrade foi
  testado quando a migration for reversível.
- [ ] Há backup verificável do SQLite antes da migration e instrução para restaurá-lo.
- [ ] Jobs em andamento são compatíveis com a versão nova, ou foram drenados/cancelados e
  podem ser reprocessados de forma idempotente.

### Contratos e compatibilidade

- [ ] Schemas, fixture válida e fixture inválida foram atualizados para toda mudança pública.
- [ ] O runner de contratos e o importador do iHub aceitaram os exemplos válidos e recusaram
  os inválidos.
- [ ] A versão, janela de compatibilidade e estratégia de rollback constam de
  `contracts/generator-ihub/COMPATIBILIDADE_E_ROLLBACK.md` e das notas de release.

### Mídia e dados editoriais

- [ ] Uma produção real ou fixture representativa validou FFmpeg/FFprobe, duração, cue e
  sincronização de áudio/reel.
- [ ] Textos EN/PT aprovados, acentos, Unicode e pontuação foram comparados literalmente;
  não houve reconstrução de texto na exportação.
- [ ] Manifestos, hashes e artefatos necessários para reprocessar a exportação foram preservados.

### Observabilidade e rollback

- [ ] Logs JSON incluem `project_id`, `job_id` e `artifact_id` quando existirem, sem segredos.
- [ ] Há métrica ou consulta para falhas de job, exportação e importação do iHub.
- [ ] O responsável, o horário do deploy e o critério de aceite estão registrados.
- [ ] Para rollback: pausar novas exportações, restaurar banco se necessário, usar o último
  manifesto compatível e reexecutar fixtures antes de reabrir o fluxo.

## Responsabilidade

O agente **05 Integração e Release** mantém este processo. Mudanças que alterem esses
gates atualizam também `agentes/05-integracao-e-release.md` e `agentes/MAPA_DE_USO.md`.
