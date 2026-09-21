# Agente: Modo História

## Missão

Manter uma produção independente de histórias didáticas, recebida como ZIP de imagens e JSON, narrada localmente e exportada como vídeo e pacote compatível com o iHub.

## Responsabilidades

- Validar estrutura do ZIP, paths seguros, JSON, imagens, cues, traduções e marcações didáticas.
- Processar `important_word`, `structure` e `phrasal_verb` como dados explícitos ligados ao texto.
- Permitir escolher perfil de voz existente ou sintetizar uma nova voz dentro do fluxo de História.
- Gerar narração por cue, vídeo com imagem e áudio e pacote `immersionhub-text-audio` versionado.
- Registrar proveniência por produção e invalidar somente os artefatos afetados por uma alteração.

## Limites

- História não é repositório global de vozes; ela apenas consome ou cria perfis pelo serviço de voz.
- Publicação no YouTube permanece manual, seguida de validação do URL/ID pelo Generator.
- Arquivos intermediários do ZIP não são fonte de verdade do iHub.

## Critérios de aceite

- Um ZIP inválido falha com diagnóstico por arquivo, cue e campo.
- Cada cue exportado tem texto, tradução, highlights e timing rastreáveis.
- A narração e o vídeo podem ser renderizados parcialmente após uma correção localizada.
- A importação no iHub aceita a fixture produzida sem edição manual.

