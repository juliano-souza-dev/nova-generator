# ADR 0045 — Preparação automática do Qwen3-TTS no início do Generator

## Contexto

A integração inicial do Qwen3-TTS 1.7B dependia de comandos manuais de
instalação. O proprietário determinou que o Generator detecte a ausência do
modelo ao iniciar e o prepare automaticamente, sem terminal.

## Decisão

- O worker local verifica o VoiceDesign 1.7B em toda inicialização.
- Se faltar, enfileira uma tarefa durável e idempotente enquanto a tarefa
  anterior ainda estiver ativa. Falhas são recuperáveis por nova tentativa.
- Um consumidor dedicado atende apenas à preparação de voz. Os jobs de
  transcrição, mídia, cards e exportação não aguardam downloads gigantes.
- Preparar um Python isolado na pasta de dados, instalar dependências por pip
  no ambiente isolado e baixar pesos oficiais via Hugging Face.
- Não usar shell e aceitar somente identificadores oficiais de modelo
  declarados no código: nunca executar caminhos ou pacotes arbitrários
  recebidos da interface.
- Baixar o modelo VoiceDesign na inicialização. O modelo Base é instalado
  na primeira seleção da opção de voz por referência, evitando downloads
  adicionais de vários gigabytes sem uso.
- Expor status em etapas na Biblioteca de vozes, permitir retomada,
  cancelamento do job e nova tentativa em caso de falha.
- Preservar pesos já presentes e verificar hash + tokenizer antes de permitir
  a primeira síntese. A narração propriamente dita continua offline.
- Respeitar o Python personalizado, sem modificá-lo silenciosamente; a
  preparação integral automática usa o ambiente gerenciado por padrão.

## Consequências

- O primeiro início requer internet, espaço em disco e tempo para baixar
  recursos volumosos. A aplicação continua responsiva durante o processo.
- A presença de pesos sem tokenizer e dependências não libera prematuramente
  a geração de voz.
- Falha ou falta de conectividade não deve impedir o uso das demais funções.
- Logs de preparação permanecem locais; a interface mostra apenas estágio
  e mensagens relevantes, sem expor comandos de infraestrutura.
- Sem alterações nos contratos externos iHub, no schema de mídia e nos
  WAVs aprovados. Os jobs existentes continuam tendo o mesmo formato.

## Aceite e recuperação

- Iniciar um worker novo sem Qwen enfileira a preparação automaticamente.
- Reiniciar enquanto uma tarefa estiver ativa não cria outra instalação.
- A primeira seleção de Base prepara apenas o modelo necessário.
- O status fica indisponível enquanto baixar recursos e disponível após
  validação completa.
- Cancelar interrompe o subprocesso, preservando downloads parciais; nova
  execução retoma de onde o gerenciador de pacotes permitir.
- A fila ordinária continua processando outros trabalhos em paralelo.
- Para recuperar, usar Tentar novamente ou reiniciar o worker.
