# ADR 0029: sugestões de unidades semânticas pela assistência editorial

## Status

Aceito.

## Contexto

O editor já permitia agrupar palavras manualmente, mas Groq e o pacote externo recebiam apenas o
texto do cue. Sem IDs de palavras, uma IA não conseguia propor com segurança que `Can I help?`
fosse uma unidade traduzida como `Posso ajudar?`. Aplicar grupos por chamadas direcionais sucessivas
também poderia deixar uma alteração parcial se uma chamada intermediária falhasse.

## Decisão

O input editorial 1.1 inclui as palavras com ID, ordem, superfície, tradução e grupo atuais. Cada
sugestão pode retornar `semantic_units`, contendo dois ou mais `word_ids` contíguos e uma tradução
brasileira natural em `pt`. O backend valida pertencimento ao cue, ordem, contiguidade, duplicidade,
sobreposição, tradução e hash canônico.

A interface aplica cada proposta primeiro em estado local. Salvar substitui atomicamente o conjunto
de unidades do cue usando `expected_revision`; conflito de revisão exige recarregar. A operação
preserva todos os IDs e timings, incrementa a revisão e deixa o cue em `draft`. Aprovar continua uma
ação explícita separada.

Resultados externos 1.0 continuam aceitos sem `semantic_units`. Pacotes novos usam input e output
1.1. Sugestões nunca carregam nem alteram timestamps.

## Consequências

- Groq e IA externa compartilham o mesmo contrato e as mesmas validações.
- Uma falha nunca persiste metade de um agrupamento sugerido.
- O hash muda quando palavras ou grupos atuais mudam, invalidando respostas obsoletas.
- O rollback consiste em descartar o rascunho antes de salvar ou substituir as unidades pelo estado
  anterior usando a revisão editorial auditada.
