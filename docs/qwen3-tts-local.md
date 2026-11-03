# Narração natural com Qwen3-TTS 1.7B (local)

O Generator oferece dois tipos de voz Qwen3-TTS: **Criar por descrição**
(VoiceDesign, melhor para testar interpretações) e **Reproduzir voz de
referência** (Base, melhor para manter o mesmo timbre entre quadros).
O áudio é sintetizado no próprio computador; nenhum texto ou voz é enviado
a um serviço pago.

## 1. Preparar Python dedicado para Qwen

Mantenha Qwen e Chatterbox em ambientes separados, evitando conflitos de Torch.

### Windows / PowerShell

~~~powershell
py -3.12 -m venv .venv-qwen
.\.venv-qwen\Scripts\python.exe -m pip install --upgrade pip
.\.venv-qwen\Scripts\python.exe -m pip install qwen-tts soundfile
~~~

Instale uma versão de PyTorch compatível com sua GPU ou CPU, conforme as
instruções oficiais do PyTorch. O pacote qwen-tts também instala dependências.
Consulte: https://github.com/QwenLM/Qwen3-TTS

### Linux

~~~bash
python3.12 -m venv .venv-qwen
.venv-qwen/bin/python -m pip install --upgrade pip
.venv-qwen/bin/python -m pip install qwen-tts soundfile
~~~

## 2. Baixar os modelos antes de trabalhar offline

Instale a ferramenta de download no mesmo ambiente:

~~~powershell
.\.venv-qwen\Scripts\python.exe -m pip install "huggingface_hub[cli]"
~~~

Baixe **somente** a variante que deseja usar. Em um terminal com o comando
hf disponível:

~~~powershell
hf download Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign --local-dir models/qwen3-tts/Qwen3-TTS-12Hz-1.7B-VoiceDesign
hf download Qwen/Qwen3-TTS-12Hz-1.7B-Base --local-dir models/qwen3-tts/Qwen3-TTS-12Hz-1.7B-Base
hf download Qwen/Qwen3-TTS-Tokenizer-12Hz --local-dir models/qwen3-tts/Qwen3-TTS-Tokenizer-12Hz
~~~

O tokenizer pode ser requisitado pelo modelo. Antes de desconectar a internet,
confirme que suas dependências e seus pesos/tokenizer estão completos no cache
local. O worker **nunca** baixa pesos sob demanda.

## 3. Configurar e iniciar

No arquivo .env, ajuste:

~~~dotenv
NOVA_GENERATOR_QWEN_MODEL_ROOT=models/qwen3-tts
NOVA_GENERATOR_QWEN_TTS_PYTHON=C:/caminho/do/nova-generator/.venv-qwen/Scripts/python.exe
~~~

No Linux, configure o caminho equivalente .venv-qwen/bin/python. Reinicie o
worker após alterar o ambiente. A API pode seguir no ambiente principal.

Na **Biblioteca de vozes**:

1. Escolha **Criar voz por descrição**, ajuste o tom e gere a prévia em português.
2. Se quiser manter o mesmo timbre entre todos os quadros, escolha
   **Reproduzir voz de referência**, envie uma gravação autorizada de
   6 a 30 segundos e transcreva exatamente o que ela diz.
3. Aguarde a prévia, escute e selecione o perfil no TikTok Mídia para gerar a narração.

Os quadros podem ter roteiro de narração independente do texto de tela. O áudio
do perfil escolhido é gerado a partir desse roteiro, e o vídeo final conserva
a revisão e os WAVs congelados.

## Diagnóstico e recuperação

- **Modelo ausente**: confira as pastas de pesos e o config.json.
- **Módulo qwen_tts ausente**: use o Python do .venv-qwen no .env.
- **Memória insuficiente / execução lenta**: libere RAM/VRAM, reduza a
  quantidade de jobs concorrentes e aguarde o primeiro carregamento do modelo.
  O limite por chamada é 15 minutos; a CPU pode ser muito mais lenta que a GPU.
- **Pesos alterados**: crie uma nova versão da voz; perfis com hash antigo
  são rejeitados para não mudar silenciosamente uma narração já aprovada.
- **Falha de geração**: consulte o monitor de jobs, revise a referência e
  reexecute somente o job com erro; os WAVs exportados continuam no cache.
- **Rollback**: selecione uma voz Chatterbox existente; não é necessário
  converter nem apagar perfis ou exportações Qwen.
