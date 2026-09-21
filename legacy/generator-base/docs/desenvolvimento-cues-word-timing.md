# Desenvolvimento — revisão de cues e timing Word by Word

## Objetivo

Reduzir o trabalho manual para revisar cues e marcar tempos Word by Word, sem
perder a forma editorial aprovada da legenda. Ao final do fluxo, as legendas
EN e PT devem manter exatamente as acentuações, maiúsculas, aspas, reticências
e sinais de pontuação digitados ou aprovados na revisão humana.

Exemplos que precisam permanecer idênticos no resultado final:

```text
EN: “I can't… really.”
PT: “Eu não consigo… de verdade.”
EN: Wait, what? No—don't go.
PT: Espere, o quê? Não vá.
```

O objetivo não é fazer o texto de `words[]` virar a fonte editorial da
legenda. `words[]` representa unidades temporais; a legenda é um texto
editorial independente.

## Diagnóstico do comportamento atual

O projeto já preserva Unicode ao escrever JSON (`ensure_ascii=False`) e o
salvamento de cue mantém o texto EN/PT revisado nos campos `approved_en` e
`pt`. Porém, há pontos em que a reconstrução a partir de `words[]` usa
`" ".join(...)`. Essa reconstrução não consegue distinguir uma palavra de uma
pontuação que tenha sido separada em uma unidade temporal. Consequentemente,
uma legenda como `Wait, what?` pode virar `Wait , what ?`.

Os fluxos de dividir e unir cue merecem atenção especial porque podem gerar
texto de cue a partir das words. Além disso, o WbW atual apresenta uma unidade
por vez; embora seja preciso para precisão, cria muitas trocas de contexto e
muitos salvamentos para uma única cue.

## Regra de dados

Cada cue deve ter duas representações explícitas:

| Dado | Papel | Pode ser reconstruído de `words[]`? |
| --- | --- | --- |
| `original_en` | Transcrição original recebida | Não |
| `approved_en` | Legenda EN editorial aprovada | Não |
| `pt` | Legenda PT editorial aprovada | Não |
| `words[]` | Unidades faladas para revisão/tradução/timing | Não para a legenda final |

`words[].text` pode conter a grafia visual da unidade, inclusive pontuação
anexada (`can't,`, `really.`). Ele não deve ser usado como serialização de
uma frase. As palavras continuam associadas à cue por ordem e por tempo.

Quando for realmente necessário construir texto provisório para uma cue nova,
usar um serializador de tokens, nunca `" ".join(...)`. Esse serializador deve:

1. Não inserir espaço antes de `, . ? ! : ; ) ] } % …`.
2. Não inserir espaço depois de `(`, `[`, `{`, aspas de abertura e travessão
   usado como abertura.
3. Preservar apóstrofos internos (`don't`, `I'm`) e aspas curvas (`“ ”`, `‘ ’`).
4. Ser usado apenas como valor inicial; a revisão humana continua sendo a
   autoridade para `approved_en` e `pt`.

## Fluxo editorial proposto

```mermaid
flowchart LR
  A[IA / ASR] --> B[Cue: original_en, approved_en, pt]
  A --> C[words[]: unidades e tempos]
  B --> D[Revisão de cue]
  D --> E[Legenda final EN/PT literal]
  D --> F[Sincronização de words]
  F --> G[Timing WbW]
  G --> H[Preview com destaque]
  E --> H
  E --> I[PDF / vídeo / Anki]
```

### Edição de texto da cue

- Salvar o conteúdo dos textareas como texto editorial, sem normalização além
  de validar que há conteúdo. Não converter aspas, remover diacríticos,
  substituir reticências, nem reformar pontuação.
- Atualizar `words[]` por alinhamento de tokens somente para manter o timing.
  Uma alteração apenas de caixa ou pontuação mantém os tempos da word
  correspondente.
- Se uma edição alterar palavras faladas, somente as unidades afetadas voltam
  a `pending`. Unidades não afetadas permanecem aprovadas.
- Exibir no editor o que será publicado: EN e PT da própria cue, e não uma
  concatenação derivada das words.

### Dividir cue

- Dividir por uma fronteira de word/timing, quando houver words suficientes.
- Copiar para as duas novas cues seus textos editoriais como rascunho apenas
  se não houver uma forma segura de derivá-los; marcar ambas como pendentes.
- Oferecer imediatamente os dois campos EN/PT para revisão. A publicação fica
  bloqueada até ambas as novas cues serem salvas.
- Nunca sobrescrever `original_en` com texto reconstruído. Se for necessário
  registrar a origem de uma cue criada por divisão, usar metadados de edição
  (`derived_from_cue`, `split_at_ms`) em vez de substituir a transcrição
  original.

### Unir cue

- Criar um texto provisório com o serializador de tokens ou com a concatenação
  dos dois textos editoriais respeitando fronteiras de pontuação.
- Abrir a cue unida como pendente, exigindo confirmação humana de EN/PT.
- Preservar as `words[]` por ordem temporal e preservar seus timings até a
  revisão WbW decidir alterá-los.

## Experiência de timing WbW proposta

O timing continua sendo por word, mas a unidade de trabalho passa a ser a cue.
O usuário pode ajustar várias words de uma mesma cue sem ser deslocado para a
próxima tela após cada salvamento.

### Layout

- Uma faixa de words da cue inteira sobre a waveform, com blocos arrastáveis.
- Cada bloco mostra a word; a word ativa recebe destaque, mas as demais
  permanecem visíveis para dar contexto.
- A legenda EN/PT aprovada aparece acima do vídeo como texto literal. O
  destaque da word é visual e não recompõe a legenda.
- Zoom é ancorado na word selecionada; há botões para a word anterior e a
  próxima e teclas `Tab`/`Shift+Tab` para seleção.

### Operações eficientes

| Ação | Efeito |
| --- | --- |
| Arrastar borda | Ajusta IN ou OUT da word selecionada |
| Arrastar bloco | Move o intervalo inteiro, preservando duração |
| `A` / `S` | Marca IN / OUT no playhead |
| `Tab` / `Shift+Tab` | Seleciona próxima/anterior word sem salvar |
| `G` | Salva somente a word ativa e permanece na cue |
| `Ctrl+G` | Salva todas as alterações válidas da cue e avança |
| Ajustar fronteira compartilhada | Move OUT da word anterior e IN da próxima juntos |
| Realinhar cue | Reparte somente os intervalos ainda pendentes, mantendo os já revisados |

### Regras de validação de tempo

- Cada word precisa ter `end_ms > start_ms`.
- A ordem das words da mesma cue não pode inverter.
- Words adjacentes podem encostar; sobreposição deve exigir ação explícita e
  mostrar aviso.
- O limite da cue é uma janela de contexto, não uma trava: caso uma word
  revisada ultrapasse a borda, a cue se expande como já previsto pelo fluxo.
- Uma alteração não deve redistribuir silenciosamente os tempos de words já
  aprovadas.

## Revisão de legendas e validação assistida

A validação precisa mostrar o que o aluno verá e separar claramente três
decisões: texto da legenda, estrutura da cue e timing. Hoje essas decisões se
misturam porque uma alteração de texto pode forçar o usuário a passar por
várias telas antes de conferir o resultado.

### Área única de revisão da cue

Cada cue deve abrir uma área de trabalho com quatro camadas simultâneas:

| Camada | Mostra | Edição |
| --- | --- | --- |
| Contexto | vídeo, waveform e cue anterior/próxima | reprodução e navegação |
| Legenda final | EN e PT exatamente como serão publicadas | texto editorial |
| Estrutura | words, limites da cue e destaques de mudança | quebra, união e ordem |
| Timing | intervalos de cue e words | IN/OUT, arraste e atalhos |

O preview deve renderizar `approved_en` e `pt` literalmente. A lista de
words serve para destacar áudio e localizar problemas; ela nunca pode substituir
visualmente a legenda aprovada por uma frase recomposta.

### Estados explícitos

Cada cue e cada word precisa ter um estado visível e uma razão de pendência:

```text
imported → needs_text_review → needs_timing_review → approved
                    │                  │
                    └── changed ───────┘
```

- `imported`: recebido da IA/ASR, ainda não conferido.
- `needs_text_review`: EN/PT ou estrutura precisam de confirmação humana.
- `needs_timing_review`: texto foi aceito, mas intervalos precisam ser
  conferidos.
- `approved`: texto e timing foram validados.
- `changed`: metadado de auditoria que registra qual ação devolveu o item a um
  estado pendente.

Uma correção de PT não deve invalidar timings. Uma mudança de pontuação que
não muda a palavra falada deve preservar timing e aprovação de áudio. Trocar,
inserir ou remover palavra falada invalida somente a word afetada, as fronteiras
vizinhas e a cue correspondente.

### Checagens antes de salvar

O editor deve validar localmente, sem esperar o fim da etapa:

- EN e PT não vazios;
- caracteres Unicode preservados e sem transformação automática;
- aspas, parênteses e colchetes balanceados quando usados;
- não há espaços antes de pontuação final nem duplicação acidental de espaço;
- cada highlight/estrutura aponta para texto literal da cue;
- palavras da cue seguem a ordem textual e temporal;
- IN/OUT é válido e está dentro da mídia;
- nenhuma word aprovada foi movida como efeito colateral.

As checagens editoriais devem ser avisos corrigíveis, exceto texto vazio,
timing inválido, referência quebrada ou ordem temporal inválida, que bloqueiam
o salvamento. A mensagem precisa apontar cue, word e campo exatos.

## Quebra, união e reordenação de cues

Essas ações são estruturalmente sensíveis e não podem apagar a revisão humana.

### Quebrar cue

- O usuário posiciona o playhead e escolhe a fronteira proposta entre duas
  words; se não existir fronteira, o editor mostra que será criada uma nova
  word pendente.
- O sistema cria duas cues-filhas com `derived_from_cue`, `split_at_ms` e uma
  revisão estrutural própria.
- Texto EN/PT das filhas é provisório e precisa de aprovação; o texto e a
  revisão da cue original ficam preservados no histórico.
- Cues vizinhas não são alteradas; apenas a lista, a etapa de revisão e os
  cards vinculados que dependiam da cue original ficam pendentes de
  reconciliação.

### Unir cues

- A união cria uma nova revisão derivada, nunca descarta as duas cues de origem
  silenciosamente.
- O editor mostra EN/PT das duas cues lado a lado e propõe um texto provisório
  que respeita pontuação.
- A nova cue exige confirmação editorial e de timing; words aprovadas mantêm
  seus intervalos até uma alteração explícita.
- Cartões, práticas e referências externas ligados às cues originais são
  exibidos como itens a reconciliar antes da publicação.

### Ordem e espaços entre cues

O editor deve oferecer uma ação **normalizar fronteiras** que apenas sugere
ajustes. Ela nunca move uma cue aprovada automaticamente. Para cada lacuna ou
sobreposição, o usuário escolhe entre manter, encostar as bordas ou definir um
gap de silêncio. Isso reduz correções repetitivas sem apagar decisões de áudio.

## Timing por cue e por word sem fricção

### Cue timing

- Exibir a cue atual, anterior e próxima na mesma waveform, com áreas de
  segurança visual para evitar sobreposição.
- Ao arrastar a borda direita de uma cue, oferecer a opção de mover a borda
  esquerda da próxima junto; o usuário pode desligar esse vínculo.
- Permitir reprodução em loop com pré-roll e pós-roll configuráveis (por
  exemplo, 300 ms) para ouvir a transição.
- Exibir duração, gap anterior e gap posterior em milissegundos.
- `A`, `S`, setas e atalhos existentes permanecem, e `J`/`K` saltam entre
  fronteiras de cue.

### Word by Word

- Manter todas as words da cue na waveform; selecionar outra word não troca de
  página nem reinicia o vídeo.
- Uma borda compartilhada pertence visualmente às duas words adjacentes. Ao
  arrastá-la, atualiza `OUT` da word anterior e `IN` da seguinte como uma única
  operação reversível.
- Usar modo ripple opcional: mover uma word pode deslocar as words pendentes à
  direita, mas nunca as aprovadas.
- Salvar rascunho local da cue e mostrar quais words foram alteradas antes de
  confirmar o lote.
- `G` confirma a word; `Ctrl+G` confirma as mudanças válidas de toda a cue;
  `Shift+G` confirma a cue e avança para a próxima pendente.
- `Tab`/`Shift+Tab` e `[`/`]` selecionam words anterior/próxima; isso elimina a
  necessidade de usar o mouse para cada unidade.

### Ajuste assistido, mas nunca autoritário

O botão de realinhamento deve ser uma sugestão visual. Ele calcula intervalos
para apenas as words pendentes, mantendo as aprovadas como âncoras. Antes de
aplicar, a interface mostra uma tabela de antes/depois e permite aceitar a
sugestão inteira ou apenas uma faixa de words.

## Histórico, desfazer e auditoria

Todas as mudanças de cue e timing devem produzir uma revisão pequena, com:

```json
{
  "entity": "cue:12",
  "action": "adjust_shared_word_boundary",
  "before": {"word_4_end_ms": 8420, "word_5_start_ms": 8420},
  "after": {"word_4_end_ms": 8490, "word_5_start_ms": 8490},
  "reason": "human_review",
  "at": "2026-09-21T17:00:00Z"
}
```

O desfazer/refazer da interface deve usar essa mesma sequência enquanto a tela
estiver aberta. Depois de salvo, o histórico permite restaurar uma revisão
anterior sem precisar reconstruir texto ou timing manualmente.

## Métricas de qualidade do fluxo

O sistema deve registrar, por projeto, quantas cues/words foram aceitas sem
mudança, corrigidas no texto, corrigidas no timing, quebradas e unidas. Esses
dados ajudam a identificar se ASR/IA está errando principalmente em texto,
segmentação ou tempo, sem transformar o usuário em operador de diagnóstico.

## Contrato de preview e exportação

O preview de vídeo, PDF, Anki, Dual Scene e exportações devem consumir:

```json
{
  "subtitle_en": "valor de cue.approved_en sem reconstrução",
  "subtitle_pt": "valor de cue.pt sem reconstrução",
  "word_highlights": "words[] somente para tempo e destaque"
}
```

Não é necessário adicionar esses campos ao JSON canônico se os consumidores
lerem diretamente `approved_en` e `pt`; os nomes acima deixam explícita a
separação de responsabilidades. Caso seja criado um DTO de exportação, ele
deve conter esses campos para impedir regressão.

## Plano de implementação futura

### Achados que orientam a refatoração

O código atual já tem uma base útil: `_sync_cue_words_to_approved_text` mantém
o timing quando a mudança é apenas de caixa ou pontuação, e há um endpoint de
salvamento por cue no WbW. A refatoração deve preservar essas capacidades.

Há, porém, comportamentos que precisam ser substituídos antes de se ampliar a
interface:

| Local atual | Comportamento | Risco | Regra de substituição |
| --- | --- | --- | --- |
| `app.py` — `_join_cue_text` | Une EN/PT de duas cues com `" ".join` | Espaço indevido antes de pontuação e texto editorial provisório tratado como final | Criar revisão estrutural, preservar as fontes e exigir EN/PT aprovados para a nova cue. |
| `app.py` — `cue_review_split` | Reconstrói `original_en`, `approved_en` e PT a partir de `words[]` ou `split()` | Perde pontuação/acentos editoriais e altera a transcrição de origem | Criar cues-filhas derivadas; textos são rascunhos e `original_en` de origem permanece imutável no histórico. |
| `static/word_timing.js` — preview | Renderiza tokens WbW e insere espaços entre eles | A prévia pode divergir da legenda EN/PT que será publicada | Renderizar EN/PT literais; o destaque deve mapear posição visual sem serializar a frase por `words[]`. |
| endpoints de realinhamento | Aplicam e persistem deslocamentos em lote imediatamente | Não há comparação antes/depois nem proteção explícita para unidades aprovadas | Gerar proposta reversível, com escopo somente pendente e confirmação do usuário. |

### Entregas em ordem de dependência

1. **Contrato editorial e identificadores estáveis.** Definir DTOs de leitura
   para `subtitle_en`, `subtitle_pt`, destaques temporais e estado de revisão.
   Introduzir `cue_id` imutável; `order` passa a ser apenas posição de exibição.
2. **Serviço de reconciliação textual.** Isolar tokenização, comparação de
   palavras faladas, serialização provisória e cálculo de invalidações em uma
   camada de domínio, testada sem FastAPI ou browser.
3. **Operações estruturais auditáveis.** Implementar split, merge, criação e
   exclusão como comandos que registram origem, impacto em cards/práticas e
   revisão pendente, em vez de editar listas e renumerar referências como
   identidade.
4. **Tela unificada por cue.** Migrar gradualmente as telas atuais para uma
   área por cue, com edição local, desfazer/refazer, preview literal e
   salvamento em lote. Manter rotas antigas como adaptadores até a migração
   estar completa.
5. **Timing assistido seguro.** Tornar realinhamento uma proposta; limites
   compartilhados, ripple opcional e aprovação por cue devem operar sobre um
   rascunho antes da persistência.
6. **Consumidores finais e compatibilidade.** Só depois migrar vídeo, PDF,
   Anki, Hub e exportações para o contrato explícito. Uma versão de schema e
   fixtures impedem que um consumidor antigo volte a reconstruir legendas.

### Definition of Ready e Definition of Done

Uma história entra em desenvolvimento somente com um exemplo real de entrada
(áudio, cue, EN, PT e timings), comportamento esperado e regra de
invalidação. A tarefa só é concluída quando:

- o texto final é comparado byte a byte em UTF-8 no caminho de ida e volta;
- a mudança tem testes de domínio, API e interface quando aplicável;
- split/merge mostram o impacto em materiais derivados antes de confirmar;
- a interface mantém foco, playhead e rascunho ao trocar de word na mesma cue;
- há uma fixture de exportação que confirma o mesmo resultado no Generator e
  no Hub;
- o histórico permite identificar quem ou qual ação mudou texto, estrutura ou
  timing.

## Estratégia de QA e testes

### Pirâmide de testes

| Nível | Escopo | Casos obrigatórios |
| --- | --- | --- |
| Unitário | tokenização, reconciliação, serialização provisória, transições de estado e comandos estruturais | aspas curvas, apóstrofos, reticências, acentos PT-BR, pontuação isolada, contrações e palavras repetidas. |
| API | endpoints de cue, timing, proposta de realinhamento e exportação | validação de payload, conflito de versão, não mutação em erro e impacto limitado aos itens afetados. |
| Componente | editor de cue e waveform | preview literal, foco/atalhos, rascunho por cue, aviso de pendência e antes/depois do realinhamento. |
| E2E | fluxo completo em mídia curta | importação → revisão → split/merge → WbW → exportação; comparar texto e timings no artefato final. |
| Regressão de mídia | corpus versionado de cenas reais | fala rápida, pausas, música, sobreposição, interrupção, sotaques e pontuação não trivial. |

### Fixtures canônicas

Criar `tests/fixtures/subtitles/` com arquivos JSON pequenos, versionados e
legíveis. Cada fixture precisa carregar áudio sintético ou uma referência curta
de mídia e declarar o resultado literal esperado. O conjunto inicial deve
incluir:

- `punctuation_unicode.json`: `“I can't… really.”` e `“Eu não consigo… de verdade.”`;
- `adjacent_boundaries.json`: words que encostam e words com gap de silêncio;
- `split_merge.json`: cues com vírgula, interrogação, aspas e referências a
  Anki/estruturas;
- `repeated_words.json`: termos repetidos para validar o alinhamento sem
  escolher a ocorrência errada;
- `wbw_groups.json`: phrasal verb e grupo PT que não pode ser quebrado por uma
  edição não relacionada;
- `hub_contract.json`: payload final consumido pelo iHub.

### Casos de regressão que bloqueiam release

1. O preview e cada exportação exibem exatamente os mesmos bytes UTF-8 de
   `approved_en` e `pt` da fixture.
2. Editar `really` para `really.` altera apenas `words[n].text`; seus tempos e
   aceite permanecem intactos.
3. Inserir uma palavra falada deixa pendentes somente a nova unidade, suas
   fronteiras e a cue, preservando as demais words aprovadas.
4. Split e merge preservam a relação com a cue de origem e deixam cards,
   destaques e práticas em estado de reconciliação, sem apontar silenciosamente
   para outra cue.
5. Uma proposta de realinhamento não grava nada até confirmação; ao confirmar,
   não move unidades aprovadas.
6. Falha de validação, perda de rede ou conflito de revisão não apaga o
   rascunho local nem troca o texto literal em tela.

### Observabilidade de qualidade editorial

Registrar eventos estruturados por ação, sem salvar o conteúdo integral das
legendas nos logs: projeto, `cue_id`, versão anterior/nova, tipo de ação,
quantidade de words afetadas, origem (humana/sugestão) e duração da revisão.
O painel deve mostrar taxa de correção textual, taxa de correção de timing,
splits/merges por minuto de mídia, reaperturas e falhas de validação. Esses
indicadores revelam onde ASR, UX ou regras de domínio estão causando retrabalho.

## Critérios de aceite e testes

### Preservação textual

- Salvar e recarregar `“I can't… really.”` preserva os mesmos caracteres.
- Salvar e recarregar `“Eu não consigo… de verdade.”` preserva acentos,
  apóstrofos, aspas e reticências.
- Vídeo, PDF, Anki e JSON final exibem exatamente `approved_en` e `pt`.
- Ajustar somente o tempo de uma word não altera nenhum caractere da legenda.

### Estrutura de cue

- Dividir uma cue não altera o `original_en` da cue de origem por
  reconstrução de words.
- Unir `Wait,` com `what?` produz uma revisão pendente e nunca `Wait , what ?`
  como legenda final aprovada.
- Editar pontuação de `really` para `really.` conserva o timing da unidade.

### Timing

- Uma cue com dez words pode ter várias bordas ajustadas antes de um único
  salvamento em lote.
- Salvar uma cue não modifica tempos já aprovados em outra cue.
- O preview usa EN/PT literal e destaca a word correta no intervalo correto.
- Uma borda compartilhada ajustada altera somente as duas words adjacentes.
- Uma operação de ripple não move words já aprovadas.
- Uma sugestão de realinhamento exibe o antes/depois e pode ser parcialmente
  aceita.

### Revisão e estrutura

- Corrigir apenas PT não reinicia a revisão de timing.
- Corrigir apenas `really` para `really.` não invalida o áudio aprovado.
- Inserir uma palavra falada marca somente as unidades afetadas como pendentes.
- Quebrar ou unir cue conserva histórico, referências de origem e exige nova
  confirmação editorial antes da publicação.

## Arquivos que devem ser revisados quando a implementação começar

- `C:\generator\app.py`: sincronização de words, endpoints de cue review,
  split/merge e payload de WbW.
- `C:\generator\static\cue_review.js`: edição e apresentação de cue.
- `C:\generator\static\word_timing.js`: seleção, renderização e salvamento
  do timing por cue.
- `C:\generator\static\word_timing.html`: controles de edição em lote.
- `C:\generator\tests\`: novos testes de preservação de Unicode, pontuação,
  split/merge, preview e salvamento em lote.

## Fora do escopo desta etapa de documentação

Esta especificação não altera o código, os JSONs existentes, a estrutura do
projeto nem os dados dos usuários. Ela serve como contrato para a próxima fase
de implementação.
