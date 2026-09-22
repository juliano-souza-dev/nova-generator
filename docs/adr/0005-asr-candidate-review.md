# ADR 0005: Candidato ASR como rascunho editorial

## Decisão

Um job `ingest_scene_media` concluído mantém o candidato ASR no output persistido. A API
editorial cria uma cena determinística por ID de job, cues e palavras com IDs estáveis e
proveniência. O texto do candidato entra somente em `original_en`; `approved_en` e
`approved_pt` começam vazios. A aprovação explícita grava ambos os textos literais e marca
o cue como aprovado, sem alterar timings. Repetir a importação retorna a cena existente e
nunca sobrescreve edições aprovadas.

## Consequências

Cards e exportações exigem EN/PT preenchidos, portanto rascunhos não são publicados. O
editor pode revisar texto e tempos em comandos distintos, com revisão auditável. O job de
ingestão precisa pertencer ao projeto e ter terminado com sucesso; payloads de outro projeto
ou timings inválidos são rejeitados antes de qualquer escrita. A importação não altera o
contrato Generator–iHub nem exige migration.
