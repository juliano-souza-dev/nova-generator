# ADR 0018: referências WAV gerenciadas para vozes locais

## Decisão

O operador envia um WAV PCM de 1 a 30 segundos pela API. O servidor valida formato,
taxa, canais e tamanho, calcula SHA-256 e guarda o arquivo como
`media_cache/voice_references/<sha256>.wav`. Perfis guardam apenas esse hash.
O worker confere o hash e resolve o caminho dentro da biblioteca antes de iniciar
o subprocesso Chatterbox. O runner também confere hash e diretório e rejeita
parâmetros de caminho enviados pelo usuário.

O hash do checkpoint Nano é calculado pelo servidor a partir de
`t3_nano_v1.safetensors`, descoberto no cache local Hugging Face ou indicado por
`NOVA_GENERATOR_CHATTERBOX_MODEL_FILE`. O formulário não solicita hashes.

## Consequências e recuperação

O mesmo WAV pode ser reutilizado em vários perfis sem duplicação. Um arquivo
alterado ou ausente impede nova síntese, preservando a identidade do perfil.
Restaure o WAV original com o mesmo conteúdo em `voice_references/`, ou crie
uma nova versão com outra referência. Se o checkpoint estiver ausente, configure
o caminho do modelo e reinicie o serviço.
