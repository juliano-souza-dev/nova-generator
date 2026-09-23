# Nova Generator

Nova Generator é a reestruturação do sistema de produção de conteúdo para o iHub. A implementação nova será construída em módulos, preservando a compatibilidade dos fluxos que já funcionam.

## Iniciar no Windows

Dê duplo clique em **`INICIAR.bat`**, na raiz do projeto. Na primeira execução, o
inicializador prepara Python, backend/ASR, Chatterbox Nano, frontend e banco de dados. Depois,
inicia API, worker e interface e abre `http://127.0.0.1:5173` automaticamente. A instalação
inicial pode demorar por causa do PyTorch e do modelo de voz; as próximas execuções reutilizam
o ambiente.

Mantenha a janela **Nova Generator - Inicializador** aberta. Fechá-la encerra os serviços.
Se algo falhar, a janela mostra a causa e os detalhes ficam em `data/logs/`.

São necessários Windows 10/11 e conexão com a internet na primeira execução. Quando Python
3.12+, Node.js ou FFmpeg não estiverem presentes, o inicializador tenta instalá-los pelo
Winget. O modo manual abaixo continua disponível para desenvolvimento e diagnóstico.

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

## Execução manual para desenvolvimento

O procedimento desta seção é opcional e serve para desenvolvimento dos processos separados.

### Frontend do estúdio

O frontend independente está em `frontend/`; ele não usa arquivos do diretório `legacy/` em runtime.

```powershell
cd frontend
npm install
npm run dev
```

O Vite encaminha `/api` para `http://127.0.0.1:8000` no desenvolvimento. Use
`npm run build`, `npm run lint`, `npm run test` e `npm run test:e2e` para validar a aplicação.

Na rota **Materiais**, selecione um perfil de voz, prepare o WAV de cada card e exporte os
cards incluídos. Em outro terminal, execute `python -m nova_generator.worker` para processar
os jobs de áudio e exportação. O worker requer o ambiente local de Chatterbox, FFmpeg e FFprobe.
O APKG, manifesto e reel ficam disponíveis para download quando o job termina. Se um job
falhar, consulte o erro em **Jobs**, reprocesse o card afetado e inicie uma nova exportação.

Na rota **Mídia**, baixe ou reutilize a fonte YouTube verificada e escolha o intervalo de
corte. O worker gera o MP4 do projeto, waveform e transcrição candidata com Faster-Whisper
(`pip install -e ".[asr]"`). O resultado aparece na mesma tela e pode seguir para revisão
Editorial. Os jobs usam o mesmo worker local; em caso de falha, consulte **Jobs** e refaça
somente o download ou corte afetado.

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

Para criar uma voz distinta, envie um WAV PCM de 1 a 30 segundos na biblioteca
de vozes e selecione a referência no formulário. O servidor calcula os hashes
da referência e do checkpoint Nano; o operador não precisa informá-los. O
checkpoint `t3_nano_v1.safetensors` é procurado no cache Hugging Face ou pode
ser indicado por `NOVA_GENERATOR_CHATTERBOX_MODEL_FILE`. Referências ficam em
`media_cache/voice_references/` pelo hash do conteúdo. Se uma referência for
removida ou alterada, a síntese falha no job; restaure o WAV original ou escolha
outra referência em um novo perfil.

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
