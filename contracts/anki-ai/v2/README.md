# Anki didático v2 · criação por estrutura, não transcrição

Contrato: `nova-generator-anki-proposal/2.0`, retornado na primeira troca com a IA externa, no mesmo ZIP de Editorial. Shadowing continua calculado exclusivamente pelo Generator.

- `cue_id` vincula o card à fala real; `card_id` é UUID único e persistente por exercício.
- `source_context_en` e `source_context_pt` são a fala editorial aprovada e sua tradução **literais e imutáveis** (integridade de origem).
- `focus_text` é uma expressão/padrão que deve aparecer na fala original. Selecione phrasal verbs, collocations, gramática produtiva, expressões e vocabulário contextual; descarte triviais.
- `front_en` e `back_pt` constituem **uma nova frase didática contextualizada**, que usa a estrutura selecionada em situação coerente com a cena. Não copie legendas como comportamento padrão.
- `marked_en` deve existir em `front_en`; `marked_pt` deve existir em `back_pt`.
- `meaning`, `explanation_pt`, `example_en`, `example_pt`, `card_type` e `tags` criam a mini-aula.
- `uses_literal_scene_line=true` é exceção expressa para quando a fala original é a melhor unidade pedagógica; neste caso os dois textos do card devem ser idênticos ao contexto. Use `false` nos outros casos.
- A interface apresenta frente e verso lado a lado, edita todos os campos e exige gravação explícita. Não altera Editorial, timing, mídia ou Shadowing. Cards v1 salvos previamente são apresentados como rascunhos migráveis, sem perda de conteúdo.
- IDs/hashes, contexto aprovado e destaques são validados. Uma cue pode originar múltiplas lições quando o foco é diferente. Resultado de IA é rascunho, nunca aprovação automática.

### Exemplo

Fala da cena: `...you'll also answer to him.`

Foco: `answer to` (prestar contas/responder hierarquicamente).

Frente didática: `Junior lawyers answer to their department head.`

Verso: `Advogados iniciantes prestam contas ao chefe do departamento.`

Contexto da cena original continua integralmente em `source_context_en/pt`.
