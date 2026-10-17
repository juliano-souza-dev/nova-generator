# Plano de conclusão do Nova Generator

> Levantamento inicial em 17/10/2026, a partir do código, README, documentação de release e workflow GitHub Actions. Não substitui testes integrados com FFmpeg, modelos locais e iHub em um ambiente real.

## Critério de conclusão

O Nova Generator só pode ser considerado pronto quando **cada jornada de usuário funciona de ponta a ponta**, a suíte automática está verde, os artefatos exportados são aceitos pelo iHub e existe procedimento testado de instalação, backup e recuperação. A presença de código, rotas ou testes não comprova o funcionamento completo.

## Evidência inicial

- API FastAPI, SQLAlchemy/Alembic, worker persistente e módulos independentes estão presentes no repositório.
- Frontend possui rotas para Projetos, Mídia, Editorial, Vozes, Materiais, História e Jobs.
- Contratos versionados Generator–iHub, fixtures e documentação de rollback estão presentes.
- No workflow `Quality` de 17/10/2026 (run `39076956241`), o job de contratos passou; backend parou no Ruff; frontend parou no Prettier; Playwright teve 3 falhas em `timeline.spec.ts`. Pyright, pytest, lint, Vitest e build ficaram sem execução nesse run por falhas anteriores.
- O `npm ci` desse run reportou 4 avisos de vulnerabilidade (1 moderada, 1 alta, 2 críticas). É necessário conferir o resultado detalhado de `npm audit`, distinguir dependências de desenvolvimento/produção e corrigir sem upgrades cegos.

## Etapa 0 · Recuperar os gates (bloqueadora)

**Responsável:** 05 Integração e Release. **Revisores:** 01 Arquitetura, 02 Estúdio Editorial.

- [ ] Ruff, Pyright e pytest completos verdes.
- [ ] Prettier, ESLint, Vitest e build do frontend verdes.
- [ ] Playwright verde em desktop e jornada principal, com atenção especial à bancada editorial e ao scroll.
- [ ] `npm audit` triado por dependência, impacto, caminho de exploração e alternativa segura.
- [ ] Workflow `Quality` 100% verde no PR antes do merge.

**Aceite:** cada job da pipeline completa a execução com sucesso; correções de testes não escondem regressões do produto.

## Etapa 1 · Execução local reproduzível

**Responsável:** 01 Arquitetura e Plataforma. **Revisores:** 03 Mídia; 05 Integração.

- [ ] Testar `INICIAR.bat` em Windows 10/11 limpo (instalação, segunda execução e encerramento).
- [ ] Testar API, banco SQLite, migrações Alembic e worker com retomada de jobs após falha.
- [ ] Testar ausência de FFmpeg/FFprobe, modelo de TTS indisponível, falha de download e falta de internet, com mensagens recuperáveis.
- [ ] Validar backup/restauração conjunta de banco, arquivos de projeto e cache.
- [ ] Auditar logs e configuração local para não incluir credenciais nem dados editoriais sensíveis.

**Aceite:** instalação e recuperação executáveis por um operador seguindo somente `README.md` e `docs/operacao-local.md`.

## Etapa 2 · Jornada Mídia → Editorial

**Responsável:** 02 Estúdio Editorial. **Revisores:** 01 Arquitetura; 03 Mídia; 05 Integração.

- [ ] Criar projeto, resolver vídeo YouTube/cache, baixar e selecionar corte com FFmpeg/FFprobe reais.
- [ ] Transcrever com Faster-Whisper e carregar candidato ASR do projeto/cena certos.
- [ ] Tratar automaticamente EN, PT e word-by-word via Groq, com fallback externo validado por schema e hash.
- [ ] Revisar, salvar e aprovar cues, timings e unidades semânticas sem perda literal de Unicode.
- [ ] Reabrir/recarregar página e validar persistência de drafts, aprovações e mudanças.
- [ ] Validar timeline, atalhos, player, acessibilidade, overflow e navegação em 1366×768/1440×900 e mobile.

**Aceite:** pelo menos um projeto real percorre a jornada sem copiar IDs técnicos e sem aprovar silenciosamente sugestões de IA.

## Etapa 3 · Vozes, Materiais e Anki

**Responsável:** 03 Mídia e TTS Local. **Revisores:** 01 Arquitetura; 05 Integração.

- [ ] Criar perfil de voz e referência WAV; verificar hashes e reprodução do áudio canônico Chatterbox.
- [ ] Bloquear prévia/exportação de cue incompleto ou em rascunho, sem quebrar compatibilidade com conteúdo legado aprovado.
- [ ] Testar reprocessamento e idempotência dos jobs com uma falha de TTS e uma falha de FFmpeg.
- [ ] Validar APKG em leitor Anki, manifesto, reel, duração/sincronia e arquivos disponíveis.
- [ ] Publicar após upload manual do reel, validar ID do YouTube, gerar `hub_final.json` e recusar alterações após snapshot.

**Aceite:** pacote Anki reproduz áudios corretos e exportação é idêntica nos metadados de texto e sincronização; reprocessar não troca conteúdo publicado.

## Etapa 4 · Jornada História

**Responsável:** 04 Modo História. **Revisores:** 03 Mídia; 05 Integração.

- [ ] Importar ZIP válido com `story.json` e imagens e recusar fixtures inválidas com mensagens por campo/cue.
- [ ] Revisar EN/PT/highlights, perfis de voz, renderização e reprocessamento de cues.
- [ ] Gerar vídeo final, vincular ID do YouTube após publicação manual e exportar JSON público versionado.
- [ ] Validar render real com imagens, Unicode, áudio e legendas em sincronismo.

**Aceite:** pacote de História renderizado e aceito pelo consumidor iHub sem edição manual do JSON.

## Etapa 5 · Integração iHub e liberação

**Responsável:** 05 Integração e Release. **Revisores:** todas as frentes.

- [ ] Executar importação real do iHub com `hub_final.json` e conteúdo História, além do runner de fixtures do Generator.
- [ ] Provar compatibilidade retroativa e documentar limites de versionamento, migrations e rollback.
- [ ] Executar `scripts/rehearse_local_release.py` e arquivar evidências fora do Git.
- [ ] Preencher `docs/qualidade-e-release.md` com logs de teste, lista de artefatos, responsável e plano de recuperação.
- [ ] Fazer rodada de aceite manual no Windows com projeto completo, desde a criação até o consumo no iHub.

**Aceite:** CI verde, jornada real validada, contrato consumidor validado, backup/restauração ensaiados e checklist assinado.

## Regra de implementação

Cada mudança deve ter um agente responsável conforme `agentes/MAPA_DE_USO.md`, teste que demonstre o comportamento, documentação quando o contrato/processo mudar e pull request isolado. Não alterar `legacy/` como área ativa. A branch `main` deve receber apenas mudanças revisadas e verificadas.
