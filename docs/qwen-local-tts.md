# Qwen3-TTS local

O Nova Generator usa Qwen3-TTS local para síntese de voz. Nenhum áudio de
produção depende de uma API de voz externa.

## Modelos

- `qwen3-tts-1.7b-voice-design`: voz criada por descrição (`instruct`).
- `qwen3-tts-1.7b-base`: clonagem a partir de áudio de referência autorizado
  e de sua transcrição literal.

Os pesos vivem em `models/qwen3-tts/`, fora do Git. Uma instalação só é
considerada pronta quando o diretório do modelo contém `model.safetensors` na
raiz. Arquivos de metadados ou downloads parciais em `.cache/huggingface` não
são pesos utilizáveis.

## Idiomas e roteiro bilíngue

O Qwen recebe idioma explícito em toda síntese:

- materiais, cards Anki e histórias em inglês usam `English`;
- prévias em português usam `Portuguese`;
- a exportação TikTok permite escolher `Português (Brasil)` ou `English`, e a
  escolha é congelada no snapshot do job.

Para alternar idioma dentro da mesma narração TikTok, use exclusivamente
blocos marcados:

```text
[pt]Hoje vamos praticar uma expressão.[/pt]
[en]Can I help you?[/en]
[pt]Significa: posso ajudar?[/pt]
```

Cada bloco é sintetizado no idioma indicado e unido ao seguinte com 250 ms de
silêncio. Texto sem tags continua usando o idioma selecionado na tela. Não
misture texto fora dos blocos marcados: isso é recusado para evitar pronúncia
ambígua.

## Qualidade e consistência

VoiceDesign usa `do_sample=True`, conforme a recomendação do Qwen para
geração de voz. O cache inclui os parâmetros de idioma; portanto, sínteses em
português e inglês nunca compartilham o mesmo WAV por engano.

Para uma identidade vocal totalmente estável entre dezenas de cards, use o
Qwen Base com uma referência limpa e autorizada. O fluxo é: criar/aprovar uma
voz de referência e então clonar essa referência para cada texto. VoiceDesign
permanece adequado para criar e testar a identidade inicial.

## Operação e diagnóstico

O instalador do Qwen verifica os pesos depois de cada download. Se o modelo
Base estiver incompleto, os renders que o utilizam falharão de forma explícita
em vez de iniciar uma síntese quebrada. Use **Vozes → Preparar modelo** para
enfileirar novamente a preparação e acompanhe `qwen.setup` no Monitor de jobs.

O worker renova o lease enquanto Qwen sintetiza, pois a inferência em CPU pode
passar do intervalo normal de heartbeat.
