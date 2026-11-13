# Nova Generator

Aplicação desktop para criação, edição e exportação de materiais educacionais de inglês.

- Desktop: Tauri 2 + React 19 + TypeScript + Vite.
- Backend nativo: Rust.
- Arquitetura: monólito modular.
- Dependências de execução, ferramentas, modelos, diretórios globais e provedores de API: Shared Runtime Manager.

Node.js, npm e Rust estável são necessários para construir a aplicação. Recursos de execução como FFmpeg, FFprobe, Python, faster-whisper e yt-dlp são declarados em `shared.config.example.json` e resolvidos pelo Shared Runtime Manager.

## Shared Runtime Manager

O Nova Generator consome o vínculo local `shared.config.json`, provisionado pelo Shared Runtime Manager. Esse arquivo é específico da instalação e permanece fora do Git.

### Preparar o vínculo

Na raiz do repositório, execute uma vez:

```bash
npm run shared:init
```

O comando cria `shared.config.json` a partir de `shared.config.example.json`, mas nunca sobrescreve um arquivo existente. Depois, registre o diretório do Nova Generator no Shared Runtime Manager e sincronize suas dependências. O Shared preserva as declarações de dependências e provedores e provisiona os caminhos resolvidos.

- O identificador registrado da aplicação é `nova-generator`.
- Dependências e provedores permitidos são declarados pelo Nova; caminhos resolvidos e provedores autorizados são provisionados pelo Shared.
- O diretório global de vídeos originais é lido exclusivamente de `shared.directories.mediaShared`.
- FFmpeg e yt-dlp são executados a partir dos caminhos registrados em `shared.resources`.
- Endpoints, modelos e credenciais autorizadas são lidos pelo SDK Rust oficial `shared-runtime-manager`. Credenciais descriptografadas permanecem no backend nativo e nunca são enviadas ao React.
- O Shared Runtime Manager não precisa permanecer aberto depois de provisionar/sincronizar o vínculo.

Para provedores de API, autorize o Nova Generator no provedor desejado pelo Shared Runtime Manager e sincronize novamente a aplicação. Em uma instalação distribuída, o Shared deve ser vinculado ao diretório de instalação do aplicativo para provisionar o arquivo local nesse ambiente.

### Forced Alignment (Word by Word)

O Forced Alignment é um recurso opcional gerenciado integralmente pelo Shared Runtime Manager. Para instalá-lo:

```powershell
srm install forced-alignment --app nova-generator
```

O Shared cria o ambiente Python isolado, instala WhisperX e mantém os modelos acústicos no armazenamento global. O Nova Generator apenas lê o caminho provisionado em `shared.resources.forced-alignment`; não instala nem mantém cópias desses recursos.

Consulte `docs/WORD-BY-WORD-SYNC.md` para a arquitetura de alinhamento incremental por blocos e `ARCHITECTURE.md` antes de introduzir novas funcionalidades.
