# ADR 0034 — Importação confirmada de cues resegmentadas

## Contexto

Uma IA externa pode receber uma ordem direta do proprietário para separar falas por pausas e
interlocutor. O ZIP retornado pode conter 32 cues quando a cena atual tem 30. O fluxo editorial
1.5 ordinário rejeita legitimamente os hashes de outra divisão; aceitar silenciosamente um
hash obsoleto eliminaria a proteção contra perda de palavras e edições concorrentes.

## Decisão

- Manter **inalterada** a validação comum dos JSONs/ZIPs sob contrato editorial 1.5.
- Reconhecer uma resegmentação somente se o ZIP tiver `cue-resegmentation-map.json` com versão
  `nova-generator-cue-resegmentation/1.0`, além do manifesto, da entrada, de todos os chunks
  e do resultado Anki. Não alterar o schema de `editorial-suggestions/1.5`.
- Conferir o SHA256 da entrada resegmentada, IDs e ordem das cues e dos chunks, todas as palavras
  originais da **cena aberta** uma única vez na mesma ordem, intervalos atuais e originais,
  e a atribuição explícita das palavras a cada cue do mapa.
- Validar traduções, inglês reconstruído, unidades semânticas, `context_practices` e Anki **antes**
  de mutar o banco. Um retorno inválido não produz revisão parcial.
- Responder `409 Conflict` com a contagem antes/depois; o operador confirma na interface e a
  segunda requisição usa `allow_resegmentation=true`. O servidor faz a conferência novamente.
- Gravar uma única revisão transacional `import_external_cue_resegmentation`, conservar IDs e
  tempos originais de palavra e deixar todas as cues em rascunho para aprovação humana.
- O mesmo ZIP reaplicado contra o mesmo texto/IDs é idempotente. Em caso de conflito de palavras,
  tempos ou fonte, pedir a exportação do pacote atualizado.

## Consequências e recuperação

- Contratos já consumidos pelo iHub não mudam. O Anki 2.0 e English in Context continuam
  armazenados no formato atual, vinculados às novas cues e às palavras estáveis.
- Aprovações anteriores são reabertas como rascunho quando o dono autoriza a substituição.
- O editor explica o erro junto à área de arrastar; não oculta falhas no rodapé rolável.
- Em caso de problema, consultar a revisão transacional antes/depois da cena e restaurar pela
  operação de revisão existente. Não é necessário recriar o corte do vídeo.
- A preparação do Shadowing continua derivada do editorial aprovado, como no fluxo atual.

## Verificação

- `tests/application/test_external_editorial_exchange.py`: confirmação, operação transacional,
  integridade de palavras, idempotência e rejeição sem efeitos colaterais.
- `frontend/src/features/editorial/EditorialPage.test.tsx`: erro visível e confirmação com retry.
