# ADR 0044 — Qwen3-TTS 1.7B local para narração

## Contexto

A narração Chatterbox Turbo dos quadros TikTok Mídia pode soar artificial.
O proprietário decidiu usar Qwen3-TTS 1.7B local para obter interpretação
conversacional em português, sem chamadas pagas de geração de voz.

## Decisão

- Adicionar dois mecanismos locais ao catálogo de perfis versionados:
  **VoiceDesign 1.7B** (instrução expressiva, sem gravação) e **Base 1.7B**
  (referência autorizada + transcrição literal para conservar timbre).
- Cada mecanismo usa pesos locais, Python configurável e execução isolada do worker.
  A aplicação, Anki e renderizadores não carregam pesos nem dependências CUDA.
- Identificar o checkpoint por hash das configurações e pesos; rejeitar síntese
  caso o arquivo local tenha mudado após criação do perfil.
- Manter Chatterbox Turbo e Nano existentes inalterados, com despacho pelo ID.
- Gerar um WAV canônico por texto e snapshot de voz, reaproveitando cache,
  jobs, tempos de mídia e exportações existentes.
- Preservar a nova escolha apenas como configuração de voz; não mudar o contrato
  Generator–iHub nem os artefatos JSON e ZIP.
- Manter execução offline no subprocesso; pesos são baixados previamente
  pelo operador. Os perfis novos fazem prévia em português.
- O subprocesso tem timeout maior (15 minutos) para permitir CPUs mais lentas.

## Limites e consequências

- O carregamento inicial de 1.7B e cada nova invocação do subprocesso podem
  levar tempo, principalmente em CPU; futuras otimizações podem manter o
  processo residente para vários quadros.
- O VoiceDesign **não garante timbre idêntico** entre várias chamadas; para
  constância entre quadros, o perfil Base com uma gravação autorizada e sua
  transcrição é o percurso recomendado.
- Um perfil antigo de Chatterbox continua renderizável com o mesmo modelo.
- Nenhum áudio é sobrescrito pela troca de seleção de modelo; hashes e
  versões isolam o cache.
- A API aceita campos aditivos de modelo/parametrização já existentes. Não
  há migration, alteração no schema externo ou no consumidor iHub.

## Aceite

- Modelos instalados são identificados por hash determinístico e status por ID.
- A biblioteca cria perfis sem referência no VoiceDesign e exige áudio +
  transcrição no Base; rejeita modelo não suportado e arquivos manipulados.
- Worker despacha os dois motores e deixa perfis Chatterbox funcionais.
- Prévia e renderização usam texto literal e cache WAV, sem chamadas de rede.
- O rollback desativa novos perfis Qwen e seleciona uma voz Chatterbox existente,
  preservando as versões e as exportações anteriores.
