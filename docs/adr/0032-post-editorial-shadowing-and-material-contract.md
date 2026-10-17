# ADR 0032 · Shadowing pré-produzido e novo contrato pedagógico externo

- Data: 2026-10-17
- Estado: aceito para implementação incremental
- Responsáveis: 03 Mídia e TTS Local; 05 Integração e Release
- Referência: repositório `juliano-souza-dev/generator`, Alpha 1.13–1.24, apenas como orientação de fluxo.

## Contexto

O novo Editorial já está funcional e deve ser preservado. A navegação atual pula para cards Anki sem um estágio próprio de Shadowing e sem contrato que peça à IA externa o conteúdo real do workbook, exercícios e explicações pedagógicas. Connected Speech deixou de fazer parte do produto.

## Decisão

1. Não modificar o Editor nem o repositório legado.
2. Produzir blocos iniciais de Shadowing determinísticos ao consultar as cenas aprovadas, usando limites de cue, grupos de até 12 segundos e pausa ajustada por duração (mínimo de 2 s, máximo de 12 s).
3. Exigir prévia e aprovação humana. Persistir por projeto/cena em JSON atômico com hash de texto, timestamps e revisão. O plano é regenerado quando a fonte muda.
4. Um novo contrato `materials-ai/v1` deve conter **conteúdo pedagógico completo**, além de cards Anki com explicação contextual. A IA externa não altera os textos EN/PT aprovados.
5. O backend rejeita hash obsoleto, projeto incorreto, seção ausente, exercício sem resposta e card sem identidade válida. Revisão e aprovação são ações distintas.
6. Connected Speech não será portado.
7. Começar com persistência em arquivos JSON nos diretórios de projeto para evitar migração SQL até o modelo definitivo ficar estabilizado.

## Consequências e compatibilidade

O novo contrato não altera `generator-ihub/v1`, que continua sendo usado pelo exportador existente. A nova revisão pedagógica antecede a exportação; integrar as sete seções ao renderer PDF e os cards enriquecidos ao APKG requer testes de equivalência antes do release. Falha ou interrupção podem ser recuperadas pelo JSON aprovado e pela fonte hash; rollback consiste em desativar as rotas novas sem alterar o banco/editorial.

## Critério de aceite incremental

Testes unitários de invalidação/hash; schemas versionados com fixtures válidas/inválidas; API/UI para shadowing e materiais; gates CI verdes. Release final permanece condicionado à integração PDF/APKG/iHub.
