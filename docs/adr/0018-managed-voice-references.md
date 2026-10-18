# ADR 0018: referências de áudio gerenciadas para vozes locais

## Decisão

O operador envia WAV PCM, MP3 ou OGG de 6 a 30 segundos pela API.
MP3 e OGG são convertidos localmente via FFmpeg para WAV PCM mono 24 kHz/16 bits;
WAV válido é preservado sem conversão. A biblioteca valida formato,
taxa, canais e tamanho do WAV canônico, calcula SHA-256 desse conteúdo e guarda o arquivo como
`media_cache/voice_references/<sha256>.wav`. Perfis guardam apenas esse hash.
O worker confere o hash e resolve o caminho dentro da biblioteca antes de iniciar
o subprocesso Chatterbox. O runner também confere hash e diretório e rejeita
parâmetros de caminho enviados pelo usuário.

O hash do checkpoint Turbo é calculado pelo servidor a partir de
`t3_turbo_v1.safetensors`, descoberto no cache local Hugging Face ou indicado por
`NOVA_GENERATOR_CHATTERBOX_MODEL_FILE`. O formulário não solicita hashes.

## Consequências e recuperação

A entrada é limitada a 10 MiB. Falta de FFmpeg, áudio corrompido ou duração fora
de 6 a 30 segundos gera erro recuperável sem registrar a referência. Referências antigas com menos de 6 segundos continuam identificáveis na biblioteca,
mas não podem ser usadas para criar uma voz ou uma nova prévia.
O arquivo original comprimido não é persistido; MP3/OGG que normalizam para o mesmo WAV
reutilizam o mesmo hash e podem ser usados em vários perfis sem duplicação. Um arquivo
alterado ou ausente impede nova síntese, preservando a identidade do perfil.
Restaure o WAV original com o mesmo conteúdo em `voice_references/`, ou crie
uma nova versão com outra referência. Se o checkpoint estiver ausente, configure
o caminho do modelo e reinicie o serviço.
