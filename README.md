# Nova Generator

Aplicação desktop para criação, edição e exportação de materiais educacionais de inglês.

- Desktop: Tauri 2 + React 19 + TypeScript + Vite.
- Backend nativo: Rust.
- Arquitetura: monólito modular.
- Dependências de execução, ferramentas, modelos e provedores: Shared Runtime Manager.

Node.js, npm e Rust estável são necessários para construir a aplicação. Recursos de execução como FFmpeg, FFprobe e Python são declarados em shared.config.json e resolvidos pelo Shared.

Consulte ARCHITECTURE.md antes de introduzir novas funcionalidades.
