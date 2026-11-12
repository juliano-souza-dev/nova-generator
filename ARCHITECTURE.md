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
8. Segredos nunca entram em projetos, configurações próprias da aplicação, logs ou argumentos de processo.

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

O Shared Runtime Manager é a fonte central para dependências de execução, ferramentas, modelos, diretórios globais e configuração de provedores autorizados.

- O projeto declara dependências em `shared.dependencies` e provedores desejados em `shared.providers`.
- O Shared provisiona caminhos resolvidos em `shared.resources`, diretórios globais em `shared.directories` e provedores autorizados em `shared.apiProviders`.
- O vínculo gerado é local, específico da instalação e fica em `shared.config.json`, ignorado pelo Git.
- O aplicativo lê os caminhos provisionados; nunca codifica o diretório de instalação do Shared nem mantém cópias privadas de recursos gerenciados.
- O diretório de vídeos originais é sempre `shared.directories.mediaShared`. Recortes de trabalho e dados dos projetos permanecem no diretório próprio do Nova.
- O SDK Rust oficial `shared-runtime-manager` valida o identificador da aplicação, carrega endpoints/modelos e descriptografa credenciais autorizadas somente no backend nativo.
- O Shared Runtime Manager não precisa permanecer aberto depois do provisionamento.

O identificador de aplicação deste repositório é `nova-generator`. O vínculo provisionado deve declarar o mesmo identificador em `application.id`.

## Contratos de projeto

O documento do projeto será versionado e independente dos detalhes de execução. Deve representar fontes, assets, cenas, cues, segmentos, configurações editoriais e referências a saídas geradas. Segredos e caminhos absolutos de máquinas não pertencem ao documento.

Mudanças incompatíveis exigem migração explícita. Nunca apagar ou reescrever mídia original durante migrações.

## Regra de modularização

Extrações estruturais não devem alterar comportamento. Mudanças funcionais e refatorações devem ser separadas sempre que possível. Cada módulo precisa de responsabilidade clara, API pública pequena e testes próximos às regras que possui.
