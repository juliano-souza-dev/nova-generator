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

## Prévia de vozes locais

Instale `chatterbox-tts`, `torch` e `torchaudio` em um ambiente Python separado e
configure `NOVA_GENERATOR_TTS_PYTHON` com o executável desse ambiente. Com as
migrações aplicadas, rode `python -m nova_generator.worker` em paralelo à API.
O worker consome jobs de prévia, carrega Chatterbox Nano em subprocesso e salva
o WAV canônico no cache local. A biblioteca atualiza o estado da prévia e usa
esse mesmo WAV no player. Se o runtime ou os pesos faltarem, o job mostra a
falha no monitor de jobs. O SHA-256 informado ao criar o perfil identifica o
checkpoint local usado no snapshot; mantenha o mesmo valor para exportações
que devam preservar a identidade da voz.

## Modo História

Na área História, envie um ZIP com `story.json` e imagens. O validador informa o
arquivo, cue e campo a corrigir antes de criar a produção. Revise o texto EN/PT,
highlights e imagens, selecione um perfil de voz e inicie o render. Acompanhe o
job no monitor; o mesmo worker local produz o vídeo em
`media_cache/stories/<id>/render/story_final.mp4`. Depois de publicar o vídeo
manualmente no YouTube, informe o URL ou ID para gerar o JSON público. Uma
falha de render pode ser repetida no monitor; cues válidos são reutilizados.

## Qualidade e release

Os comandos locais, gates de CI e checklist de migrations, contratos, mídia, logs e rollback
estão em [`docs/qualidade-e-release.md`](docs/qualidade-e-release.md). O workflow de pull
request fica em [`.github/workflows/quality.yml`](.github/workflows/quality.yml).
