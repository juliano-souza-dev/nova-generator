# Roadmap da reconstrução

## Fase 01: Fundação
- [x] Preservar a versão anterior na branch backup.
- [x] Reiniciar a main sem apagar o histórico Git.
- [x] Definir arquitetura modular e identidade visual.
- [x] Declarar dependências e provedor inicial no Shared.
- [ ] Validar build desktop em ambiente Windows com Shared instalado.

## Fase 02: Integração Shared
- [ ] Registrar a aplicação no Shared Runtime Manager.
- [ ] Validar leitura de shared.config.json e recursos resolvidos.
- [ ] Implementar porta de acesso ao Shared sem acoplar funcionalidades ao formato interno do registry.
- [ ] Consumir SDK ou IPC oficial para segredos quando disponível.
- [ ] Exibir diagnóstico claro de dependências ausentes ou incompatíveis.

## Fase 03: Núcleo do produto
- [ ] Contrato versionado do projeto.
- [ ] Persistência e ciclo de vida dos projetos.
- [ ] Biblioteca de mídia e referências portáveis.
- [ ] Centro de tarefas para operações longas.

## Fase 04: Funcionalidades
- [ ] Pré-editorial e edição de cues.
- [ ] Transcrição e diarização.
- [ ] Tradução contextual.
- [ ] Voz e narração.
- [ ] Shadowing, Anki e PDF.
- [ ] Exportação e empacotamento.
