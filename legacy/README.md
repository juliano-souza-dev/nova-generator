# Código legado de apoio

`generator-base/` é uma cópia do sistema atual em `C:\generator` no momento da criação deste repositório. Ela existe para orientar a migração, recuperar regras de negócio e transformar o comportamento conhecido em testes.

## Regras

- Não implemente funcionalidades novas em `generator-base/`.
- Antes de migrar um recurso, localize os módulos, páginas estáticas e testes que já o representam.
- Crie a nova versão fora de `legacy/`, com fronteiras e contratos definidos pelos agentes portáteis.
- Quando houver divergência entre legado e contrato novo, documente a decisão em ADR e mantenha a compatibilidade de exportação enquanto houver consumidores.

## Conteúdo intencionalmente ausente

Ambientes Python, caches, projetos gerados, settings locais, workspaces, backups e logs permanecem fora do Git porque não são código-fonte nem fixtures reprodutíveis.

