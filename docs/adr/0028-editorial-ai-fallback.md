# ADR 0028: assistência editorial opcional com fallback externo

## Status

Aceito.

## Contexto

A revisão pode usar a Groq gratuita para corrigir pontuação, tradução e agrupamentos, mas limites e
disponibilidade variam por conta e modelo. A produção não pode depender de uma cota fixa nem ficar
bloqueada quando o provedor falhar.

## Decisão

O caso de uso depende de uma porta de assistência editorial. O adaptador Groq usa saída estruturada,
valida IDs, ordem e conteúdo, e registra somente metadados seguros de limite retornados pela API.
Ausência de chave, autenticação, limite, capacidade ou resposta inválida mantém a revisão manual
disponível e direciona o operador ao fluxo externo.

O fallback exporta um ZIP versionado com entrada canônica, template de resposta, instruções e o
corte da cena quando disponível. A importação aceita somente JSON pequeno com mesma versão, hash da
entrada, IDs e ordem. Toda resposta é uma sugestão: aplicá-la preenche um rascunho e não aprova cue.

## Consequências

- Não se codificam cotas da modalidade gratuita; o sistema usa headers recebidos em cada resposta.
- O worker executa Groq como job persistente e expõe resultado e erro observáveis.
- O fallback pode ser usado com qualquer IA externa sem enviar credenciais ao Generator.
- O rollback remove o adaptador e as rotas de pacote; a edição manual permanece independente.
