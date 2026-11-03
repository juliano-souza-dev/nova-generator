# Narração natural: preparação automática

O Generator agora verifica a disponibilidade da voz Qwen3-TTS 1.7B ao iniciar.
Se o modelo ainda não estiver pronto, prepara os recursos automaticamente **em
segundo plano**, sem comandos de instalação no terminal.

## Como funciona

1. Inicie normalmente o Generator e o worker local.
2. O worker verifica se a voz expressiva padrão está pronta.
3. Se não estiver, cria um ambiente Python isolado dentro da pasta de dados,
   instala as dependências e baixa os pesos de voz e o tokenizer oficiais.
4. Na Biblioteca de vozes, o status muda de preparação para voz disponível.
   É possível continuar editando e exportando outras mídias enquanto baixa.
5. A voz por referência utiliza um segundo modelo. Ele será baixado
   automaticamente quando essa opção for selecionada pela primeira vez.

**É necessário acesso à internet apenas durante a primeira preparação ou
uma atualização.** A narração posterior funciona totalmente local, sem
serviços pagos de voz. A instalação pode consumir vários gigabytes de
disco e memória. O tempo depende da conexão e do hardware.

## Onde acompanhar

- **Biblioteca de vozes:** mostra em qual etapa está a preparação.
- **Monitor de jobs:** acompanha a tarefa durável de preparação de voz.
- Se a instalação falhar, a Biblioteca oferece a opção **Tentar novamente**.
- Se o Generator for fechado no meio, a preparação poderá ser retomada na
  próxima inicialização. Os arquivos de modelo já baixados são reaproveitados.

## Configuração avançada (opcional)

O local padrão dos modelos é models/qwen3-tts. O ambiente Python gerenciado
é criado em data/tts/qwen-venv. Esses locais podem ser alterados no arquivo
.env com:

~~~dotenv
NOVA_GENERATOR_QWEN_MODEL_ROOT=models/qwen3-tts
NOVA_GENERATOR_QWEN_VENV_ROOT=data/tts/qwen-venv
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
