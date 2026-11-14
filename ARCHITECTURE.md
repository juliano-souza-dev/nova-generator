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
- O Shared é o único proprietário de runtimes Python compartilhados, pacotes, workers, modelos acústicos e caches. Aplicações consumidoras nunca instalam ou copiam esses recursos em suas pastas.
- Recursos opcionais são declarados em `shared.dependencies` com `required: false`, instalados sob demanda e disponibilizados em `shared.resources` após a sincronização. A declaração `required: true` faz a instalação entrar na fila de registro e sincronização.
- O Forced Alignment é uma dependência obrigatória do Nova Generator (`required: true`) e será provisionado como recurso compartilhado `forced-alignment`, em ambiente virtual Python próprio dentro do Shared. O caminho resolvido é `shared.resources.forced-alignment`.
- O Nova Generator deve iniciar e consumir o worker por esse caminho provisionado. O worker mantém modelos carregados por idioma e recebe requisições incrementais por bloco.
- Ao registrar ou sincronizar o Nova pelo Shared Runtime Manager, o recurso entra automaticamente na fila. A instalação manual continua disponível como recuperação: `srm install forced-alignment --app nova-generator`.

O identificador de aplicação deste repositório é `nova-generator`. O vínculo provisionado deve declarar o mesmo identificador em `application.id`.

## Contratos de projeto

O documento do projeto será versionado e independente dos detalhes de execução. Deve representar fontes, assets, cenas, cues, segmentos, configurações editoriais e referências a saídas geradas. Segredos e caminhos absolutos de máquinas não pertencem ao documento.

Mudanças incompatíveis exigem migração explícita. Nunca apagar ou reescrever mídia original durante migrações.

## Contrato editorial e provedores de IA

A tradução contextual e as predições editoriais usam o contrato versionado 1.3:
- Entrada: `nova-generator-editorial-input/1.3`.
- Saída: `nova-generator-editorial-suggestions/1.3`.
- Predições selecionáveis: `word_translations` e `semantic_units`. Unidades semânticas dependem da presença de traduções por palavra.
- A tradução via Groq mantém o contrato editorial interno 1.3. Para IA externa, o Generator exporta um único TXT enumerado (`entrada-editorial.txt`) e espera um JSON no contrato `nova-generator-external-editorial-output/1.0`.
- O TXT expõe números temporários de cues e palavras, texto EN, campos PT a preencher e até duas cues anteriores/posteriores como contexto. Não expõe UUIDs internos nem timestamps.
- O JSON externo devolve a tradução integral de cada cue, a tradução contextual de cada palavra e grupos semânticos com os números das palavras inglesas, a expressão EN e sua tradução PT.
- Na importação, o Generator valida a cobertura, restaura os IDs e timestamps originais e converte a resposta externa para o contrato editorial interno 1.3. O iHub continua recebendo o formato que já conhece.
- Unidades semânticas devem conter palavras contíguas da mesma cue, não podem se sobrepor e precisam reproduzir exatamente a sequência inglesa referenciada.
- A resposta permanece como `draft` e exige revisão humana. Não gerar marcação pedagógica, mini-aulas, exercícios ou conteúdo Anki nesta etapa.
- O resultado editorial é salvo separadamente das traduções de linha, com revisão incremental e hash da entrada para invalidar predições desatualizadas.

O contrato é a fonte das instruções e do formato de resposta, não o provedor. Trocar Groq por IA externa não altera o contrato.

## Regra de modularização

Extrações estruturais não devem alterar comportamento. Mudanças funcionais e refatorações devem ser separadas sempre que possível. Cada módulo precisa de responsabilidade clara, API pública pequena e testes próximos às regras que possui.
