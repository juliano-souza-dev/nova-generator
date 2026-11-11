# Narração natural: preparação antes da inicialização

O inicializador prepara e valida os recursos locais de voz **antes de iniciar a API,
o worker ou a interface**. A ausência do Qwen3-TTS não deve mais aparecer como
falha tardia quando você tenta criar uma voz.

## O que é verificado

1. O ambiente Python isolado do Qwen3-TTS e as bibliotecas `qwen-tts`, `torch`,
   `soundfile` e `huggingface_hub`.
2. O modelo **Qwen3-TTS-12Hz-1.7B-VoiceDesign**, usado para criar vozes por descrição.
3. O modelo **Qwen3-TTS-12Hz-1.7B-Base**, usado para voz por referência.
4. Os arquivos de configuração, pesos `.safetensors` e diretório do tokenizer de
   cada modelo.
5. O ambiente Chatterbox, seus pacotes e o checkpoint local, além dos requisitos
   gerais de backend, ASR, FFmpeg/FFprobe, SoX, Node.js e frontend.

O inicializador só libera a etapa que inicia os serviços quando todas essas
verificações terminam com sucesso. Se houver falha, ele mostra a etapa que não
foi concluída e encerra sem iniciar API, worker ou interface. Depois de corrigir
a causa, basta executar `INICIAR.bat` novamente. Downloads já concluídos são
reaproveitados.

## Primeira execução

A primeira preparação pode demorar e consumir vários gigabytes de disco,
principalmente pelos pesos dos dois modelos Qwen e pelo PyTorch. É necessária
conexão com a internet. As próximas inicializações verificam os recursos locais
e não baixam novamente modelos completos que já estejam íntegros.

Para validar sem abrir os serviços, execute:

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1 -CheckOnly
~~~

Os logs gerais ficam em `data/logs/`. O registro da instalação Qwen fica em
`%LOCALAPPDATA%/NovaGenerator/models/qwen3-tts/_setup/` (ou no diretório definido por
`NOVA_GENERATOR_QWEN_MODEL_ROOT`).

## Configuração avançada (opcional)

Por padrão, os modelos e o ambiente Python ficam fora do repositório, em
%LOCALAPPDATA%/NovaGenerator/models/qwen3-tts e
%LOCALAPPDATA%/NovaGenerator/environments/qwen. O inicializador migra os diretórios
legados para esses locais somente quando o destino ainda não existe. Você pode
personalizar os caminhos no arquivo .env com:

~~~dotenv
NOVA_GENERATOR_QWEN_MODEL_ROOT=C:\NovaGeneratorData\models\qwen3-tts
NOVA_GENERATOR_QWEN_VENV_ROOT=C:\NovaGeneratorData\environments\qwen
~~~

Não é necessário configurar um Python separado nem instalar pacotes manualmente.
Se NOVA_GENERATOR_QWEN_TTS_PYTHON estiver definido, o sistema respeita esse
Python personalizado e não modifica suas dependências: remova essa configuração
para permitir a preparação totalmente automática.

## Quando a narração estiver pronta

Na Biblioteca de vozes:

1. **Criar por descrição:** ajuste como a voz interpreta a aula. Não é preciso
   enviar uma gravação.
2. **Reproduzir voz de referência:** envie uma gravação autorizada de 6 a
   30 segundos e a transcrição fiel. Esse modo ajuda a conservar o timbre
   ao longo dos quadros.
3. Ouça a prévia em português e selecione o perfil no TikTok Mídia.

## Diagnóstico e recuperação

- **Sem conexão:** a preparação falha com aviso. Reestabeleça a internet e
  escolha Tentar novamente, sem apagar os arquivos já baixados.
- **Espaço insuficiente:** libere espaço no disco e tente novamente.
- **Pacotes incompatíveis:** o registro da instalação fica na subpasta _setup
  dos modelos. O sistema nunca instala no Python principal por padrão.
- **Processamento lento:** modelos 1.7B podem levar minutos para carregar ou
  gerar áudio em CPU. A velocidade depende da RAM e GPU disponíveis.
- **Mudança de pesos:** crie uma nova versão do perfil para preservar os
  snapshots de voz já aprovados.
- **Rollback:** utilize um perfil Chatterbox antigo. Nenhum áudio aprovado
  precisa ser descartado.

Fontes oficiais: https://github.com/QwenLM/Qwen3-TTS

## Narração em português e inglês no mesmo vídeo

Não é necessário instalar outros modelos. No TikTok Media, abra o quadro e utilize **Narração deste quadro**. Para alternar a pronúncia por idioma, escreva por exemplo:

~~~text
[pt]Hoje vamos entender a diferença entre see e watch.[/pt]
[en]I watch movies on weekends.[/en]
[pt]Perceba que watch envolve acompanhar uma ação.[/pt]
~~~

Use **Montar narração em português + inglês** para preencher automaticamente um rascunho a partir dos textos do quadro. A ordem dos trechos pode ser editada livremente. Escolha um perfil Qwen3-TTS na Biblioteca de Vozes; a voz de referência continua sendo a mesma em ambos os idiomas quando o perfil Base é usado. O sistema insere 300 ms de pausa entre trechos e produz um WAV contínuo, que acompanha o vídeo.

Se um rascunho já tiver marcações internas, o Qwen também reconhece trechos aninhados, como `[pt]Você pode dizer [en]watch this[/en] em inglês.[/pt]`, dividindo a fala por idioma sem ler as marcações. Prefira blocos separados ao escrever do zero; tags vazias, trocadas ou incompletas continuam inválidas.

Textos sem marcação usam o idioma selecionado para o job. Se houver mistura de texto fora das tags, o job exibe um erro para correção sem alterar sua produção. Perfis Chatterbox permanecem disponíveis para roteiros sem essas marcações, pois não oferecem a mesma escolha de idioma.

A qualidade da pronúncia e o timbre dependem do perfil e da gravação de referência; não são garantidos pelo formato do roteiro. Em CPUs antigas, alternar vários trechos pode aumentar o tempo de geração.
