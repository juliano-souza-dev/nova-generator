# Shadowing na exportação editorial inicial · v1

O arquivo `shadowing/shadowing-prepared.json` é **gerado pelo próprio Generator**, no mesmo ZIP do Editorial e do Anki. Nenhuma IA externa/Groq deve alterá-lo ou devolvê-lo. Diferentemente do Anki, o Shadowing não exige resposta da IA. O `manifest.json` explicita `generation=automatic`, `required_in_export=true` e `requires_external_ai_result=false`.

## Antes da aprovação editorial

A fonte original pode ainda ter traduções e interlocutores pendentes. O Generator executa sua própria rotina de seleção por duração, palavras, interlocutor e pausas e inclui um rascunho no contrato `nova-generator-shadowing-seed/1.0` com `status=provisional`. O seed não é um plano aprovado e não deve ser publicado ou importado como se fosse proposta de IA. IDs e tempos servem apenas como referência do estado da cena na exportação. O hash da cena editorial é registrado em `editorial_input_sha256`.

## Após a aprovação editorial

O estágio Shadowing usa exclusivamente a implementação existente `PrepareShadowing.scene` e recalcula o plano a partir dos cues, palavras, traduções, speakers e tempos **definitivos**. Nenhum trecho provisório é transportado automaticamente para publicação. Ao reexportar uma cena já aprovada, o JSON incluído passa a ter o contrato canônico `nova-generator-shadowing/2.0`, preservando grupos, tempos, pausas e hashes gerados pelo mesmo método que o editor consome.

O usuário continua com controle de juntar, separar, excluir, adicionar, ouvir e aprovar. O exportador não altera a lógica do Shadowing nem exige segunda chamada da IA. Resultados Anki continuam obrigatórios na resposta editorial externa, e resultados Shadowing não.

## Limites (herdados da implementação)

6.500 ms por grupo, 14 palavras, até 1.000 ms entre cues adjacentes; mesma pessoa e cues consecutivos. Pausas automáticas entre 2.000 e 9.000 ms. Seeds com timings inadequados incluem alerta e podem ter zero grupos: a correção deverá ocorrer no Editorial.
