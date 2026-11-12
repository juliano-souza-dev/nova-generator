# Arquitetura do Nova Generator

## Princípios

O Nova Generator é um monólito desktop modular. A modularização organiza o código por capacidades do produto sem criar serviços distribuídos prematuramente.

1. Cada funcionalidade é dona dos próprios modelos, regras e transformações.
2. Funcionalidades consomem contratos públicos, nunca detalhes internos de outros módulos.
3. React coordena interação e estado de tela; regras determinísticas ficam fora dos componentes.
4. Comandos Tauri são adaptadores de entrada finos.
5. Serviços de aplicação orquestram casos de uso.
6. Infraestrutura implementa persistência, sistema de arquivos, processos e integrações externas.
7. Arquivos originais nunca são sobrescritos.
8. Segredos nunca entram em projetos, configurações locais, logs ou argumentos de processo.

## Direção das dependências

React feature UI -> serviços tipados -> comandos Tauri -> casos de uso -> domínio. Infraestrutura implementa as portas exigidas pelos casos de uso. O domínio não depende de React, Tauri, SQLite, FFmpeg ou provedores de IA.

## Módulos de produto

- projects: ciclo de vida e organização dos projetos.
- media: biblioteca, metadados e referências de mídia.
- editorial: roteiros, cues, falantes e edição.
- transcription: transcrição local e em nuvem.
- translation: tradução contextual.
- voice: narração e geração de voz.
- learning-materials: shadowing, Anki e documentos.
- export: montagem e exportação.

A estrutura será criada progressivamente. Não criaremos arquivos vazios para simular módulos implementados.

## Shared Runtime Manager

O Shared é a fonte central para dependências de execução, ferramentas, runtimes, armazenamento de modelos e configuração de provedores autorizados.

- O projeto declara necessidades em shared.config.json.
- Caminhos são lidos da configuração gerada pelo Shared; nunca são codificados no código-fonte.
- O aplicativo não baixa, instala, atualiza ou mantém cópias privadas de recursos gerenciados pelo Shared.
- Projetos, banco local, logs e arquivos do usuário permanecem nos diretórios exclusivos da aplicação.
- Segredos ficam no armazenamento protegido do sistema operacional sob controle do Shared.
- A aplicação não deve ler arquivos internos de credenciais nem duplicar chaves em suas configurações.

### Limite atual da integração

A versão atual do Shared oferece configuração global, autorização por aplicação e armazenamento de credenciais no Windows Credential Manager. O SDK/IPC público para resolução de segredos por aplicações ainda está no roadmap. Até esse contrato existir, a integração ficará isolada atrás de uma porta/adaptador. Não implementaremos armazenamento paralelo de chaves no Nova.

O Shared ainda não faz resolução automática de compatibilidade nem atualização coordenada de todas as dependências. A aplicação deverá validar recursos resolvidos e apresentar erros acionáveis.

## Contratos de projeto

O documento do projeto será versionado e independente dos detalhes de execução. Deve representar fontes, assets, cenas, cues, segmentos, configurações editoriais e referências a saídas geradas. Segredos e caminhos absolutos de máquinas não pertencem ao documento.

Mudanças incompatíveis exigem migração explícita. Nunca apagar ou reescrever mídia original durante migrações.

## Regra de modularização

Extrações estruturais não devem alterar comportamento. Mudanças funcionais e refatorações devem ser separadas sempre que possível. Cada módulo precisa de responsabilidade clara, API pública pequena e testes próximos às regras que possui.
