# ADR 0047: dependências e recursos locais fora do repositório

- Status: accepted
- Data: 2026-11-11
- Responsáveis: Arquitetura e Plataforma; Mídia e TTS Local

## Contexto

O inicializador criava ambientes Python em `.venv` e `.venv-tts`, enquanto
Qwen3-TTS usava por padrão `data/tts/qwen-venv` e os modelos Whisper, Chatterbox
e Qwen podiam ficar sob `models/`. Isso acopla recursos grandes ao checkout,
duplica instalações entre cópias do projeto e dificulta atualizar o código sem
interferir em dependências e pesos.

## Decisão

No Windows, o diretório global padrão será
`%LOCALAPPDATA%\NovaGenerator`. Em outros sistemas, será
`$XDG_DATA_HOME/NovaGenerator` ou `~/.local/share/NovaGenerator`.
`NOVA_GENERATOR_HOME` permite substituir a raiz.

- Ambientes Python do backend, Chatterbox e Qwen ficam em `environments/`.
- Modelos Whisper, Chatterbox e Qwen ficam em `models/`.
- Cache Hugging Face, PyTorch e pip ficam em `cache/`.
- Registro de instalação e hashes ficam em `registry/`.
- FFmpeg, FFprobe, SoX, Python e Node.js continuam instalados no sistema,
  preferencialmente detectados pelo PATH ou pelo gerenciador de pacotes do Windows.
- Dependências npm do frontend ficam em `environments/node/frontend-node_modules`;
  o checkout recebe apenas uma junction para manter a resolução de módulos do Node/Vite.
- Dados de projetos, banco, logs de execução e mídia produzida não são dependências
  e permanecem nos locais de dados configurados pelo aplicativo.

O inicializador migra diretórios antigos somente se o destino global não existir.
Se origem e destino coexistirem, não sobrescreve nem apaga nenhum dos dois.
As variáveis explícitas do usuário têm precedência sobre os padrões.

## Consequências

O checkout pode ser atualizado ou substituído sem reinstalar ambientes ou baixar
novamente os modelos. Diferentes cópias do Nova-Generator no mesmo usuário podem
reutilizar os mesmos recursos. Ambientes Python separados continuam sendo usados
quando há requisitos incompatíveis entre backend, Chatterbox e Qwen.

O inicializador mantém o lockfile no repositório como fonte de versões, mas instala
os pacotes npm no diretório global e cria uma junction em `frontend/node_modules`.
Ao atualizar o lockfile, instala a nova árvore antes de substituir a anterior e
restaura a cópia anterior se a instalação falhar.
