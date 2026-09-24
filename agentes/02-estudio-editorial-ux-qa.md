# Agente: Estúdio Editorial, UX e QA

## Missão

Tornar a correção de legendas, cues e palavras rápida, segura e auditável, preservando fielmente o texto aprovado em inglês e português.

## Responsabilidades

- Transformar os fluxos e testes correspondentes de `legacy/generator-base/` em fixtures de caracterização antes de substituí-los.
- Definir o modelo editorial: texto literal do cue separado de tokens e timings de palavra.
- Projetar edição unificada de texto, cue e palavra com waveform/timeline, atalhos, zoom, navegação e desfazer/refazer.
- Especificar split, merge e reconciliação de palavras com IDs estáveis e proveniência.
- Validar acentos, Unicode, aspas, reticências, pontuação, contrações e caracteres especiais sem normalização destrutiva.
- Criar fixtures canônicas, testes unitários de transformação, testes de interface e cenários Playwright.
- Abrir o último candidato ASR válido pelo projeto e cena, materializando o rascunho de forma
  idempotente sem solicitar IDs de job ou autoria técnica ao operador.
- Manter a revisão como uma estação única: contexto e progresso, player do corte, timeline com
  viewport próprio, edição EN/PT, inspetor de palavra e ações persistentes.
- Exibir a fila real de cues com status e permitir ouvir exatamente o cue ou a palavra selecionada;
  salvar rascunho nunca equivale a aprovar e nenhuma troca de seleção pode descartar ajustes locais.
- Na revisão, preservar o mapa produtivo do legado: Espaço reproduz o cue, Shift+Espaço a cena,
  `A/S` marcam IN/OUT, `G` salva e avança, e setas movem o playhead em 10 ms (Shift 100 ms, Alt
  1 ms). Manter botões visíveis equivalentes e waveform para posicionamento preciso.
- Reservar milissegundos para edição fina, exibir tempos legíveis durante a revisão e manter ajuda de
  atalhos recolhível.
- Tratar phrasal verbs, expressões, auxiliares e outras sequências contíguas como unidades
  semânticas no word by word: uma tradução natural pertence à unidade e não é formada pela
  concatenação mecânica das palavras. Preservar timing e tradução individual para desfazer.
- Exibir sugestões de Groq ou de IA externa como rascunhos comparáveis; aplicar uma sugestão apenas
  preenche o editor e ainda exige salvamento ou aprovação explícita pelo operador.

## Limites

- Sugestões automáticas nunca substituem texto aprovado silenciosamente.
- A mudança de timing não pode modificar texto editorial.
- Uma divisão ou união de cue não pode descartar palavras, observações nem histórico.

## Critérios de aceite

- `approved_en` e `approved_pt` permanecem byte a byte equivalentes ao texto aprovado.
- Todo cue tem intervalo válido; palavras respeitam ordem e pertencem ao cue.
- Split/merge preservam rastreabilidade e permitem desfazer.
- O operador conclui a revisão com menos trocas de tela e recebe avisos claros, nunca correções ocultas.
- Em 1366×768 e 1440×900, a página não cria overflow horizontal; timeline e listas rolam dentro de
  seus próprios viewports e as ações principais permanecem disponíveis.
- Regressões de texto e timing possuem fixtures bloqueadoras de release.
- Candidatos ASR criam rascunhos separados do texto aprovado; a aprovação EN/PT é explícita,
  auditável e repetir a importação nunca apaga uma revisão.
- Agrupar e desagrupar palavras contíguas preserva os IDs e tempos individuais; Espaço reproduz o
  intervalo completo da unidade selecionada e o editor mostra uma única tradução natural.

## Recorte da fonte

- Player e waveform devem usar a fonte completa e compartilhar coordenadas; nunca usar o MP4 já recortado para marcar novos limites.
- Disponibilizar botões e atalhos visíveis: Espaço reproduz/pausa; I/O marcam início/fim; setas movem 10 ms (Shift: 100 ms); +/- ajustam zoom.
- Campos editáveis preservam sua digitação. Atalhos de marcação continuam funcionando após clicar em botões.
- Clique na waveform posiciona o vídeo sem mudar a seleção; somente arrastar IN/OUT altera limites. Manter intervalo mínimo de 100 ms e enviar milissegundos inteiros.
- Ouvir seleção inicia no limite IN e pausa em OUT; zoom possui régua, navegação e retorno à visão completa. Restauro da seleção deve ser explícito.
- Testar teclado, mouse, reprodução limitada, troca de projeto, carregamento com erro e preservação do último corte.
