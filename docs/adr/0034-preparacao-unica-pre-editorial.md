# ADR 0034 · Preparação única pré-editorial com Shadowing determinístico

- Data: 2026-10-19
- Estado: implementação experimental, sujeita aos gates de qualidade e aceite de integração
- Responsáveis: 01 Arquitetura; 02 Editorial; 03 Mídia; 05 Integração

## Contexto
Após transcrever o corte, a produção anterior requeria solicitações distintas para
Editorial, Shadowing e Materiais. Havia múltiplos contratos, downloads/uploads
e risco de descarte das mini-aulas quando o texto era revisado.

## Decisão
1. A conclusão do ASR grava um pacote único e determinístico em
   `data/projects/<id>/preparation/<scene_id>.json`.
2. A seleção inicial do Shadowing usa as mesmas funções `_automatic_groups`
   e `_validated_blocks` já existentes, sem IA. Seu rascunho é reidratado
   pelos IDs após o Editorial e só pode ser aprovado após aprovação editorial.
3. Uma única solicitação Groq ou ida/volta externa gera traduções, correções
   editoriais 1.3, sete seções pedagógicas e cards Anki enriquecidos.
4. O retorno é vinculado ao snapshot ASR (job, projeto, cena, hash), validado
   antes da persistência e gravado como rascunho. Reimportação diferente após
   a primeira gravação é bloqueada para não perder revisões humanas.
5. Alterações posteriores do Editorial atualizam front/back literais no material
   salvo, invalidando a aprovação pedagógica sem descartar a mini-aula.
6. `hub_final.json` deve transportar `generatorShadowing` somente aprovado,
   `pedagogicalContent` aprovado e os campos de mini-aula dos cards; áudio
   Anki continua vinculado após exportação e upload humano.
7. Os fluxos legados continuam acessíveis como fallback, sem migração SQL.

## Recuperação e rollout
A branch mantém os contratos antigos. Reverter as rotas de preparação inicial
retorna a jornada anterior; os arquivos do projeto não são eliminados.
Não promova à main sem testes de backend/contratos/frontend e validação de
importação do hub_final no iHub. Evite mudanças no algoritmo de Shadowing.

## Critérios
- Pacote criado após ASR e obtido antes de abrir Editorial.
- Requisições idempotentes usam o mesmo hash e IDs da transcrição.
- IA nunca escreve Shadowing; plano pode ser editado e aprovado pelo usuário.
- Materiais e cartões preparados no mesmo retorno permanecem após correções.
- Publicação conserva literalmente o texto, o plano e o vínculo de áudio.
