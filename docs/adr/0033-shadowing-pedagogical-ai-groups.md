# ADR 0033 · Shadowing pedagógico por cues e revisão humana

- Data: 2026-10-18
- Estado: implementado na branch de qualidade; não altera Editorial
- Substitui a divisão temporal automática de 12 segundos descrita na ADR 0032

## Problema anterior

O sistema reunia cues consecutivos até 12 segundos sem conferir speaker. A reprodução
começava no fim do bloco anterior e podia incluir diálogos de outros personagens.
Não havia edição de grupos nem sugestão de IA, e o usuário precisava memorizar falas longas.

## Fluxo

1. Partir somente de cues com EN/PT e timings aprovados no Editorial.
2. Carregar um rascunho local seguro, curto, agrupado somente por speaker e cues contíguos;
   isso não é classificado como resultado de IA.
3. Gerar uma proposta selecionando **Gerar proposta com Groq** ou baixar o pacote
   `GET /api/projects/{project_id}/shadowing/{scene_id}/package` para IA externa e
   importar uma proposta JSON.
4. Revisar os grupos: **Juntar com próxima**, **Separar aqui**, **Excluir grupo**, ou
   **Adicionar** um cue anteriormente omitido. Essa edição muda apenas o arquivo do
   plano Shadowing, não os cues do Editorial.
5. Reproduzir a prévia completa do plano revisado, incluindo pausas de repetição.
   A aprovação está vinculada ao hash exato do conteúdo fonte e dos blocos.
6. Aprovar o plano e avançar para Materiais/Anki.

## Contratos e limites

- Plano persistido: `nova-generator-shadowing/2.0`.
- Proposta de IA externa ou Groq: `nova-generator-shadowing-proposal/1.0`.
- O JSON de proposta contém `contract`, `scene_id`, `source_sha256` e
  `groups: [{ "cue_ids": ["<id>"] }]`. Não retorna textos reescritos.
- Duração do grupo no vídeo: até **6,5 s**, com até **14 palavras** de EN aprovado.
- Cues de um grupo devem ser consecutivos, na ordem original, com apenas um
  personagem identificado e até **1 s de silêncio** entre cues.
- Não pode reutilizar cue, misturar personagens, alterar tempos ou criar conteúdo.
  A omissão é permitida e explicitada na tela.
- Cues individualmente acima dos limites permanecem excluídos e podem ser
  divididos no próprio Editorial, sem automação que deforme a sincronização.
- `PUT /{scene_id}/blocks` inclui `plan_sha256`; mudanças concorrentes e
  respostas de IA baseadas em fonte antiga são rejeitadas.
- Toda edição ou nova proposta retorna ao estado `draft`. A aprovação usa
  `source_sha256` e `plan_sha256`, evitando aprovar uma revisão não ouvida.
- Persistência atômica nos JSONs do diretório `data/projects/<project>/shadowing`.
  O contrato anterior não é apagado: um novo plano é gerado quando a versão
  ou fonte deixar de corresponder.

## Testes

Cobrir separação por personagem, limite de duração e palavras, omissão de cues
longos, ordenação e unicidade, integração Groq e JSON externo, edição/restore,
aprovação por hash, invalidação após mudança no Editorial, e UI de revisão.
