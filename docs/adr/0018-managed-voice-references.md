# ADR 0018: referências de áudio gerenciadas para vozes locais

## Decisão

O operador envia WAV PCM, MP3 ou OGG de 1 a 30 segundos pela API.
MP3 e OGG são convertidos localmente via FFmpeg para WAV PCM mono 24 kHz/16 bits;
WAV válido é preservado sem conversão. A biblioteca valida formato,
taxa, canais e tamanho do WAV canônico, calcula SHA-256 desse conteúdo e guarda o arquivo como
`media_cache/voice_references/<sha256>.wav`. Perfis guardam apenas esse hash.
O worker confere o hash e resolve o caminho dentro da biblioteca antes de iniciar
o subprocesso Chatterbox. O runner também confere hash e diretório e rejeita
parâmetros de caminho enviados pelo usuário.

O hash do checkpoint Nano é calculado pelo servidor a partir de
`t3_nano_v1.safetensors`, descoberto no cache local Hugging Face ou indicado por
`NOVA_GENERATOR_CHATTERBOX_MODEL_FILE`. O formulário não solicita hashes.

## Consequências e recuperação

A entrada é limitada a 10 MiB. Falta de FFmpeg, áudio corrompido ou duração fora
de 1 a 30 segundos gera erro recuperável sem registrar a referência. O arquivo
original comprimido não é persistido; MP3/OGG que normalizam para o mesmo WAV
reutilizam o mesmo hash e podem ser usados em vários perfis sem duplicação. Um arquivo
alterado ou ausente impede nova síntese, preservando a identidade do perfil.
Restaure o WAV original com o mesmo conteúdo em `voice_references/`, ou crie
uma nova versão com outra referência. Se o checkpoint estiver ausente, configure
o caminho do modelo e reinicie o serviço.


## Compatibilidade do runtime Nano (18/10/2026)

A distribuição `chatterbox-tts==0.1.7` do **PyPI** implementa
`ChatterboxTurboTTS.from_pretrained(device)`, sem suporte ao parâmetro
`nano=True`. O upstream no GitHub acrescentou `nano=True` para selecionar o
checkpoint `t3_nano_v1.safetensors`, mas manteve o mesmo número de versão 0.1.7.
Portanto, checar apenas `chatterbox.__version__` ou conseguir importar o
pacote não garante compatibilidade.

O inicializador Windows instala Chatterbox a partir da revisão fixa
`resemble-ai/chatterbox@5de7a54aa4e5e2baadb0182dde554908b48b85c2`,
em ambiente `.venv-tts` isolado, e valida a assinatura de
`ChatterboxTurboTTS.from_pretrained`. O carimbo de instalação também incorpora
essa revisão. Se o usuário estiver com uma instalação PyPI antiga, executar
`INICIAR.bat` atualiza automaticamente o ambiente; Git é necessário para
instalar as dependências da distribuição em código-fonte.

O runner verifica a assinatura antes de carregar o modelo e rejeita
instalações sem suporte Nano, com mensagem de recuperação. **Jamais retirar
simplesmente `nano=True`**, pois isso carregaria o Turbo e mudaria
silenciosamente o modelo usado nos perfis.

Teste de regressão sem baixar checkpoints:
`python -m pytest tests/infrastructure/speech/test_chatterbox_nano_runner.py`.
O smoke test de síntese real continua dependendo do checkpoint Nano e
do ambiente local de TTS, fora do CI.
