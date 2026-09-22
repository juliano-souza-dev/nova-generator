# Validação integrada da issue #20

Em 22/09/2026, o product owner informou **“considere validada”** para a
validação real solicitada. Este aceite de produto é registrado separadamente
das verificações técnicas abaixo. Nenhum fluxo legado deve ser aposentado só
com base no ensaio local.

## Ensaio local reproduzível

Instale FFmpeg/FFprobe, Chatterbox Nano, Faster-Whisper e Genanki no Python
usado pelo comando. Tenha o checkpoint `t3_nano_v1.safetensors` no cache local.
Da raiz do repositório, execute:

```powershell
python scripts/rehearse_local_release.py --model-file CAMINHO/PARA/t3_nano_v1.safetensors
```

O comando gera uma fala local pelo Chatterbox, usa FFmpeg para compor uma fonte
MP4 de teste, corta a fonte por projeto, pré-calcula a waveform, obtém um
candidato de transcrição por Faster-Whisper, exporta APKG e reel MP4 e verifica
que o WAV incorporado ao Anki tem o mesmo SHA-256 do WAV canônico registrado no
manifesto do reel. O comando também lê o banco interno do APKG e compara os
campos EN/PT com os literais aprovados, incluindo acentos e pontuação. Os
arquivos e o relatório ficam em
`data/release-issue20/`, fora do Git. O texto de teste mantém literalmente
aspas, vírgulas, pontos e acentos em EN/PT; o ASR é apenas candidato e não
reescreve o texto aprovado.

Na execução local de 22/09/2026, o ensaio produziu um candidato ASR, 50
buckets de waveform, APKG e reel com intervalo de 0 a 3200 ms. O WAV canônico
e o membro de mídia do APKG tiveram SHA-256
`7aec48af5543cef2e4f94dd60ebac0012827cc09f24e472f352740d8cc02ee1d`.
O manifesto do reel registrou esse mesmo hash. Consulte o relatório local para
os caminhos completos e os hashes da nova execução.

O runner de contratos aceitou os exemplos válidos e rejeitou os inválidos:

```powershell
python -m nova_generator.infrastructure.integration.contract_runner
python -m pytest tests/contracts editorial_contracts/v1/tests
```

## Banco, rollback e recuperação

Uma base SQLite descartável recebeu `alembic upgrade head`,
`alembic downgrade -1` e novo `alembic upgrade head` sem erro. A restauração
operacional exige backup consistente do SQLite, `media_cache/` e
`data/projects/` com API/worker parados, conforme
[`operacao-local.md`](operacao-local.md). Antes de usar um banco real, faça
backup, confirme que os jobs ativos foram drenados e ensaie as mesmas migrações
em cópia do banco.

## Limites da evidência

O ensaio usa uma fonte MP4 sintética. Ele não prova download de uma URL do
YouTube, revisão humana de cues na interface, publicação manual do reel,
importação efetiva pelo site iHub nem equivalência visual com uma produção
legada. A publicação continua manual por design. Para uma liberação de produção,
registre URL/ID de vídeo autorizado, hashes dos artefatos, resultado do
importador iHub, logs do job e comparação editorial com o legado. Se algum
destes falhar, mantenha o legado operacional e restaure o snapshot anterior.
