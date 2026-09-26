# ADR 0030: preparação editorial obrigatória antes da bancada

## Contexto

O rascunho criado pelo ASR podia chegar à bancada com `approved_en`, `approved_pt` e traduções do
word-by-word vazios. Isso transferia trabalho mecânico ao operador, produzia prévias incompletas e
permitia avançar sem o tratamento linguístico que o produto exige. A Groq gratuita também pode
estar sem chave, atingir limite ou devolver uma resposta parcial.

## Decisão

Depois do ASR, a interface tenta automaticamente um job persistente de preparação pela Groq. O
resultado só é aceito quando contém, para cada cue e na ordem original:

- inglês e português não vazios;
- uma tradução contextual não vazia para cada ID de palavra;
- unidades semânticas contíguas, não sobrepostas e atuais, quando propostas.

O worker captura o snapshot antes de validar o hash da entrada e persiste a cena inteira como um
rascunho editorial atômico. No SQLite, a comparação e a troca usam a mesma transação com bloqueio
de escrita antecipado; uma edição concorrente invalida a resposta em vez de ser sobrescrita. A
proveniência registra provedor, modelo e hash, sem aprovar o conteúdo. A bancada só abre depois
dessa persistência.

Quando a Groq não está configurada, falha, excede o limite ou devolve conteúdo incompleto, a
interface exige o fallback externo. O pacote externo passa à versão 1.2 e inclui
`word_translations`. Versões 1.0 e 1.1 continuam legíveis para compatibilidade, mas não liberam a
bancada porque não provam cobertura completa do word-by-word.

## Consequências

- A revisão humana começa com EN, PT e word-by-word preenchidos, mantendo aprovação explícita.
- Respostas parciais ou obsoletas não alteram a cena.
- A indisponibilidade da Groq exige a troca de arquivo com uma IA externa antes da revisão.
- O contrato 1.2 precisa permanecer coberto por fixtures e testes de ida e volta.

## Recuperação

Se o job falhar, o operador pode tentar a Groq novamente ou baixar o pacote externo e importar um
JSON 1.2 completo. Repetir o mesmo job é idempotente pelo hash da entrada. Uma nova transcrição ou
edição muda o hash e exige nova preparação.
