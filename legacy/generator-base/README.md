# Media and Subtitle Generator — Alpha 1.39

Music Micro-Immersion percorre o pipeline compartilhado com recorte obrigatório de 30–60s, reutiliza o mesmo Shadowing do Scene e pula somente Connected Speech. Dialogue permanece intacto.

## Alpha 1.29

WbW timing expands cue bounds; final HUB export no longer rejects a reviewed word that extends the cue.

# Media and Subtitle Generator

> Current build: **Alpha 1.39** — preserva Mobile Layout + Quick Tunnel + QR da Alpha 1.38 e adiciona sincronização automática Cue Review → `words[]` para Dialogue e Music.

PDF content order: `How To Study → Day 5 — Diagnostic → Connected Speech → Connected Speech — Practice → Structures From This Scene → Activities → Finalization`. The cover is not counted as a content block.

Reinício do Generator com base multipágina e componentes reutilizáveis.

## Fluxo implementado

1. `/` — Fonte YouTube EN: valida URL e verifica se o vídeo pode ser incorporado.
2. `/config` — Configuração: `Kit/cena | Música`; em Kit pode ativar DualScene. DualScene exige URL PT válida e embedável em popup antes de avançar.
3. `/wave` — Mini Wave Editor usando o componente global de timeline.
4. `/process` — processamento técnico da mídia com logs em tempo real e artefatos clicáveis.
5. `/external-ai` — JSON canônico + áudio + instruções + ZIP, seguido de drag-and-drop e validação do retorno da IA externa.
6. `/cue-review` — revisão humana cue a cue, com caixas EN/PT editáveis, lista lateral e restauração do retorno original da IA.
7. `/word-review` — revisão humana Word by Word; 100% das words e traduções precisam ser aceitas antes de avançar.
8. `/cue-timing` — vídeo + WaveEditor global para ajustar IN/OUT de cada cue e cadastrar/atribuir speakers.
9. `/word-timing` — timing WbW por word/unidade semântica, com preview EN/PT sincronizado e destaque conjunto.
10. `/shadowing` — ramo `dualScene=false`: editor de blocos sequenciais com marcadores PAUSA/END e pausa de prática automática.
11. `/connected-speech` — exportação do pacote para análise externa de Connected Speech.
12. `/connected-speech-import` — validação do JSON devolvido.
13. `/connected-speech-review` — conferência manual dos fenômenos.
14. `/materials-external` — exporta canônico + Connected Speech revisado + contrato 1.3; recebe/valida o JSON do PDF único com os 7 blocos exatos + Anki separado produzido pela IA externa.
15. `/materials-review` — revisão humana do workbook único e dos cards Anki retornados pela IA externa.
16. `/materials-final` — Groq gera somente os WAV TTS dos cards aprovados; depois o Generator renderiza localmente o PDF único/APKG.


## Fluxo Music Micro-Immersion

Music reutiliza as etapas 01–09 do fluxo principal, com `content_type=music` e recorte manual obrigatório de **30–60 segundos**. Na etapa 05, a IA externa recebe o WAV do microtrecho e prepara somente lyrics, tradução e Word by Word do intervalo selecionado. Após o WbW Timing, Music reutiliza o Shadowing compartilhado e pula somente Connected Speech: `10 /shadowing` → `11 /materials-external` → `12 /materials-review` → `13 /materials-final`.

O `hub_final.json` Music publica `kit.contentType=music`, a janela absoluta `scene_start_ms/scene_end_ms/scene_duration_ms`, cues/words relativos ao microtrecho, `music.sections`, study/cards aprovados e materiais. Music publica o mesmo `shadowingConfig` + `shadowingPractice` usado pelo Scene; `connectedSpeech` permanece vazio.

O retorno da análise externa também inclui `generator_materials.wbw_practices`. A lista contém somente estruturas reutilizáveis, collocations, idioms e phrasal verbs relevantes. Cada item referencia `cue_order` e usa `start_ms`/`end_ms` na timeline local da cena, dentro de `speech_start_ms`/`speech_end_ms`. O `hub_final.json` publica a lista como `wbw_practices`; o Admin armazena esses milissegundos sem conversão, e o player usa `start_ms / 1000` para seek e `end_ms / 1000` para interromper o trecho.

## Wave Editor global

- desktop: vídeo 812 × 397 px à esquerda e WaveCut à direita;
- mobile: layout empilhado e responsivo;
- barra de etapas sticky abaixo da topbar;
- seletores IN/OUT sempre visíveis e arrastáveis;
- atalhos globais no último Wave Editor utilizado.

Atalhos: `Space` play/pause · `A` IN · `S` OUT · `←/→` ±10 ms · `Shift` ±100 ms · `Alt` ±1 ms.

## Processamento técnico

Após **Salvar recorte e continuar**:

`download → recorte → extração/conversão do áudio → JSON técnico inicial`

O download usa múltiplas estratégias/fallbacks do `youtube_pipeline.py`. O recorte e o áudio também têm tentativas alternativas de FFmpeg.

**Nenhuma transcrição é feita em `/process`.**

## Alpha 1.4 — IA externa

Quando `/process` termina, o botão **Avançar para IA Externa** libera `/external-ai`.

Arquivos:

- `canonical_scene.json` — schema canônico atual `immersionhub-canonical-ai-input` v1.7, inicialmente com `cues: []`;
- `scene_audio_16k_mono.wav` — áudio completo da cena recortada;
- `INSTRUCOES_EXTERNAL_AI.txt` — contrato detalhado para cues, timings, tradução e WbW;
- `external_ai_scene.zip` — contém exatamente os três arquivos acima.

A IA externa só pode escrever `cues[]`. Os demais blocos raiz são protegidos e comparados com o snapshot congelado.

O retorno é validado por drag-and-drop antes de a próxima etapa ser considerada pronta.

## Execução

Windows: `run.bat`

Linux/macOS: `./run.sh`

Servidor padrão: `http://127.0.0.1:8080`

## Alpha 1.6 — revisão humana dos cues

Depois que o JSON externo é validado, `/cue-review` permite revisar uma cue por vez. `approved_en` e `pt` são editáveis; `original_en` permanece preservado. Salvar marca a cue como aceita e segue para a próxima pendente. O botão **Restaurar da IA** só aparece quando o conteúdo atual diverge do retorno original importado.

## Alpha 1.7 — revisão Word by Word

Depois que todas as cues forem aceitas, `/word-review` apresenta uma word por vez. EN e PT são editáveis; Salvar marca a word como `review_status=approved` e abre a próxima pendente. A lateral acompanha o progresso por cue. Grupos semânticos PT continuam usando `pt_group`, `pt_group_role` e o `pt` do lead, sem alterar o schema. Ao chegar a 100% das words, a etapa `/cue-timing` é liberada.

## Alpha 1.8 — Cue Timing Wave Editor + Speakers

Editar manualmente EN ou PT de uma cue já aceita faz a cue voltar imediatamente para `pending`, bloqueando novamente o Word by Word até ela ser salva. Depois do WbW, `/cue-timing` abre vídeo e o componente global WaveEditor lado a lado, com IN/OUT individual por cue. Speakers nascem apenas nessa etapa: podem ser cadastrados, selecionados por cue, renomeados globalmente e excluídos; renomear propaga e excluir limpa as associações.

## Fora do escopo atual

O ramo `dualScene=true` após WbW Time e o fluxo específico de Música permanecem fora do escopo desta Alpha.


## Alpha 1.5 — correção do upload JSON bruto

- O retorno da IA externa é enviado ao backend como texto JSON bruto.
- O frontend não faz mais `JSON.parse -> JSON.stringify` antes do upload.
- O backend decodifica o corpo original e executa `json.loads` diretamente.
- Isso preserva tipos numéricos protegidos como `3.0` e `6.0`, evitando falso erro `float -> int`.
- Nenhuma regra do contrato canônico ou do validador de cues/WbW foi relaxada.


## Alpha 1.9 — Cue Timing shortcuts + subtitle preview

- `Space`: reproduz/pausa somente a cue atual.
- `Shift + Space`: reproduz/pausa a cena processada inteira.
- `G`: salva a cue atual e avança usando o fluxo normal da etapa.
- Preview de legendas EN + PT diretamente sobre o vídeo.
- A cue em edição usa o IN/OUT atual do WaveEditor no preview, mesmo antes de salvar.


## Alpha 1.10
Cue Timing: zoom de waveform 1×–8× com pan/centralização e controle de velocidade .75×/.85×/1×/1.25×.


## Alpha 1.11 — WbW Time

- Nova etapa `/word-timing` após Cue Timing.
- Word isolada = uma unidade; words contíguas com o mesmo `pt_group` = uma unidade semântica.
- O schema canônico permanece intacto: não é criado `groups[]`.
- EN aparece em cima e PT embaixo no vídeo; a unidade ativa recebe destaque simultâneo nos dois idiomas.
- O preview usa o IN/OUT ainda em edição.
- Reutiliza WaveEditor global, zoom 1×–8×, velocidades .75×/.85×/1×/1.25× e atalhos `Space`, `Shift+Space`, `G`, `A`, `S` e nudges.
- Ao salvar um grupo, os timings internos das words são remapeados proporcionalmente dentro do novo intervalo, preservando `original_start_ms`/`original_end_ms`.


## Alpha 1.12 — edição de grupos WbW + timing livre

- Etapa 07: edição humana da estrutura WbW com **Agrupar com anterior**, **Agrupar com próxima** e **Desagrupar unidade**.
- Agrupar/desagrupar altera somente `pt_group`/`pt_group_role`; não cria outra cue nem outro schema.
- A estrutura semântica da cue é mostrada em linhas: desagrupar cria unidades independentes dentro da mesma cue.
- Quando `pt_group_original_pt` existe, a tradução individual é restaurada ao desagrupar. Se não existe, o campo desconhecido fica pendente em vez de receber tradução inventada.
- Qualquer mudança de agrupamento invalida as words afetadas e as etapas dependentes Cue Timing/WbW Time.
- WbW Time nasce com as words posicionadas dentro do IN/OUT da cue atual, preservando `original_start_ms`/`original_end_ms`.
- Depois de iniciado, IN/OUT de word/grupo pode atravessar o limite da cue; o único limite é a duração real da mídia.
- O botão da etapa 06 para avançar ao Word by Word voltou ao padrão de ação separado das etapas anteriores.


## Alpha 1.13 — Shadowing single scene por blocos

- Após WbW Time, o fluxo agora bifurca pelo `configuration.dual_scene`.
- Para `dualScene=false`, a próxima etapa é `/shadowing`; o ramo Dual Scene permanece bloqueado para implementação posterior.
- O WaveEditor global ganhou um `MarkerEditor` reutilizável para timelines baseadas em pontos, sem IN/OUT.
- `A` marca **PAUSA** no playhead. O início de cada bloco é automático: bloco 1 começa em `0`, e cada bloco seguinte começa exatamente no ponto PAUSA anterior.
- `E` marca **END** para encerrar antecipadamente. END só pode ficar depois do início do bloco atual e impede criar PAUSAs posteriores até ser removido.
- Sem END, o último bloco termina automaticamente no fim da mídia. Também é válido usar a cena inteira como um único bloco.
- Cada bloco recebe `pause_duration_ms` calculado por `shadowingConfig.studentPause` (`speech_duration + margin`, respeitando `minSeconds/maxSeconds`).
- O plano persiste `start_ms`, `pause_at_ms`, `end_ms`, `repeat_ms`, `pause_duration_ms`, `continue_at_ms`, equivalentes `source_*`, `boundary_type`, `terminal` e `cue_orders`.
- Finalizar gera `workspace/shadowing/shadowing.json` sem alterar o schema do JSON canônico revisado.
- Zoom 1×–8×, pan, velocidades `.75×/.85×/1×/1.25×`, nudges de 10/100/1 ms e drag dos marcadores permanecem disponíveis.

## Alpha 1.14 — Shadowing preview fiel ao HUB + atalhos globais

- Shadowing: `Space` reproduz somente o bloco atual; `Shift+Space` reproduz toda a área de Shadowing (até END ou fim da mídia).
- Legendas EN/PT permanecem visíveis no vídeo durante a edição e reprodução dos blocos.
- Finalização agora passa por um preview obrigatório em popup usando exatamente os blocos e `pause_duration_ms` do plano persistido.
- Durante `WAITING_REPEAT`, o preview congela o vídeo e aplica overlay preto de 90% com todas as cues do bloco em tamanho grande para leitura/prática.
- O botão de aprovação/finalização só é liberado após o preview chegar ao fim.
- `Shift+Space` também passa a existir no contrato global do `RangeEditor`: seleção com `Space`, mídia inteira com `Shift+Space`; etapas com semântica própria podem sobrescrever somente a ação aplicável.
- Nenhum schema canônico foi alterado.


## Alpha 1.15 — contrato global de Shift+Space no MarkerEditor

- O `MarkerEditor` compartilhado agora reconhece `Shift+Space` como reprodução da mídia inteira mesmo fora do handler específico da página.
- No Shadowing, o handler de página continua tendo prioridade: `Space` = bloco atual e `Shift+Space` = cena inteira.
- Preview HUB, legendas e `WAITING_REPEAT` permanecem sem mudanças de schema.


## Alpha 1.17 — Shadowing preview approval UX

O preview do Shadowing agora diferencia visualmente o estado de reprodução do estado pronto para aprovação. O botão de aprovação permanece claramente desabilitado até todos os blocos e pausas serem reproduzidos.


## Alpha 1.18 — Connected Speech return + manual review

- Nova etapa 12 para receber e validar `connected_speech_return.json`.
- Validação estrita de snapshot/hash, escopo, cues, tipos, sequência global e timings.
- Retorno válido segue automaticamente para a etapa 13.
- Conferência manual item a item com **Aprovar** ou **Recusar**; cada decisão persiste e avança automaticamente.
- Decisões podem ser alteradas reabrindo o item.
- Resultado separado em `connected_speech_review.json`; o canônico original não é alterado.

## Alpha 1.19

Após a conferência de Connected Speech, `/materials-groq` reimplementa a arquitetura Groq antiga para gerar o draft pedagógico dos PDFs/Anki e os WAV TTS dos cards. Consulte `ALPHA_1.19.md`.


## Alpha 1.20
Retorno automático da configuração Groq para a etapa que a solicitou (`/materials-groq`) após salvar e validar.

## Alpha 1.21
A prontidão da Groq agora é determinada pelo backend (`configured + connected + ready`) e persistida após a validação. A etapa `/materials-groq` não depende mais apenas de `has_api_key` e informa o motivo real quando a configuração não estiver pronta.


## Alpha 1.22
A etapa Groq agora entrega diretamente para uma revisão humana de PDFs + Anki. Depois da aprovação, a etapa final renderiza os PDFs e os decks APKG localmente, sem nova geração pedagógica. Consulte `ALPHA_1.22.md`.

## Alpha 1.23

Responsabilidades dos materiais foram separadas novamente conforme o fluxo externo antigo:

- **IA externa de materiais:** preenche apenas os blocos editoriais definidos no contrato 1.3 do PDF único e os cards Anki; How To Study é controlado pelo Generator.
- **Connected Speech:** já chega revisado; a IA externa não pode recriar/reclassificar fenômenos, apenas criar dicas/drills para os itens aprovados.
- **Generator:** valida o retorno, cria as transcrições diretamente do canônico, abre a revisão humana e renderiza PDF/APKG.
- **Groq:** não gera conteúdo pedagógico; é chamada somente após a revisão, exclusivamente para TTS dos cues usados pelos cards Anki aprovados.

Fluxo final: `CS revisado → IA externa PDF/Anki → validar → revisar → Groq TTS → renderização final`. Consulte `ALPHA_1.23.md`.


## Alpha 1.24

A etapa de revisão de materiais usa blocos visuais fiéis ao renderer final em vez de JSON cru. O workbook único é revisado como documento estruturado; Anki recebe prévia visual do card antes dos campos editáveis. Campos técnicos/protegidos permanecem read-only.


# Alpha 1.29 — WbW expands cue bounds

- WbW timing is allowed to extend beyond the previous cue boundary.
- Saving a WbW unit expands `speech_start_ms/speech_end_ms` to contain every reviewed word; no word is clamped or rescaled.
- `subtitle_*` follows the new speech edge only when it was linked to the old speech edge.
- Existing projects are migrated automatically when WbW is loaded or final materials start.
- `hub_final.json` expands the transport cue to the WbW bounds before validation/export.
- Removed the blocking `Word timing fora do cue` rule for this legitimate case.
- Invalid word intervals themselves (`end <= start` or negative start) remain structural errors.


## Alpha 1.39 — Cue Review → WbW Synchronization

Ao salvar uma cue com `approved_en` alterado, o Generator reconcilia `words[]` com o novo texto. Tokens preservados mantêm timings/metadados; tokens novos ou substituídos voltam como pendentes; grupos PT afetados são dissolvidos de forma segura. Mobile layout, Quick Tunnel e QR Code da Alpha 1.38 permanecem intactos.

## Alpha 1.38 — QR Code for mobile access

When `run.bat` / `run.sh` creates the Cloudflare Quick Tunnel, the public URL is shown together with a QR Code directly in the terminal. The same QR is also saved as `mobile_access_qr.png`. Scan it with the phone camera to open the Generator without typing the tunnel URL.


### Exportação de Música com Lyrics do HUB

Na geração final, projetos do tipo Música produzem `videoMusic.mp4` com as letras
em inglês incorporadas à imagem: palavra ativa amarela com animação, palavras
anteriores claras, próximas palavras suaves, fundo translúcido, progresso da frase
e prévia `NEXT` da próxima linha. Não são gravados botões de idioma ou controles.
O enquadramento e a resolução da fonte são preservados (dimensões ímpares são
ajustadas para H.264), com até 60 fps. A fonte é o vídeo já recortado; as letras
usam os tempos locais revisados de cues e palavras. A geração é local, com
FFmpeg, Pillow e a fonte Inter incluída sob a licença OFL.
Este estilo se aplica somente a Música; DualScene e Shadowing usam seus próprios
renderizadores. Para atualizar um MP4 gerado antes desta mudança, use
**Gerar tudo novamente** na página de geração final.


### TikTok Media (somente Música)

Em **Geração final**, escolha as opções do painel **TikTok Media** antes de iniciar
**Gerar tudo novamente**. Para Música, a geração aguarda esse clique.

- `tiktok_lyrics_en.mp4` e `tiktok_lyrics_pt.mp4`: visual Lyrics do HUB.
- `tiktok_typography_en.mp4` e `tiktok_typography_pt.mp4`: tipografia serifada,
  palavras entrando no tempo revisado, padrão branco com letras pretas.
- `tiktok_black_neon_en.mp4` e `tiktok_black_neon_pt.mp4`: fundo escuro, entrada
  animada e brilho ciano/violeta nas palavras.
- `tiktok_video_limpo.mp4`: vídeo recortado original, sem novas legendas.
- `tiktok_audio.wav`: áudio original do trecho.
- `TikTok_Media.zip`: arquivos disponíveis e manifesto com eventuais falhas.

As seis versões animadas usam 1080 × 1920 por padrão; é possível manter o formato
da fonte. A versão limpa sempre mantém a fonte. EN e PT mantêm o mesmo áudio
original: PT usa `words[].pt`, grupos `pt_group` (lead/member) e seus intervalos
revisados, ou `ptWords` quando disponível. Não há botões gravados nos vídeos.
Falhas de PT não impedem as saídas EN; o fluxo permite repetir apenas as falhas.

Uma imagem JPG/PNG/WebP de até 20 MB pode substituir o fundo nos três estilos.
Ela é ajustada ao centro, recebe contraste para leitura e fica salva no workspace
do projeto. A opção **Padrão de cada estilo** volta ao vídeo no Lyrics, branco na
Tipografia e escuro no Black Neon. Mudar o fundo ou formato invalida o cache de
materiais para a próxima geração. A fonte Libre Bodoni está incluída sob OFL.


## Editor de vídeo (V1)

Abra **Editor de vídeo** na página de projetos ou `/editor` no mesmo servidor
Generator. Não precisa iniciar a porta 8091. O editor permite importar vídeo,
cortar/dividir/reordenar trechos, editar palavras EN/PT, escolher sete estilos,
aplicar fundo, ajustar fontes até 400% e exportar MP4 em 720p ou 1080p.
Use **F** para ampliar o monitor e **Esc** para voltar.

Rascunhos, cópias das fontes e exports ficam em `editor_workspace/`, fora das
revisões canônicas e do Git. O editor não sobrescreve a mídia nem as revisões
usadas por Cues, WbW, Shadowing e materiais. Faça backup dessa pasta para
preservar as edições. Fontes abertas são identificadas pelo conteúdo, para
continuarem disponíveis ao trocar de projeto no Generator.

A prévia durante reprodução é aproximada; pausada usa o renderizador final.
Vídeos e áudios importados começam no estilo limpo, sem transcrição automática.
Use **JSON do Hub** para carregar as legendas e tempos do `hub_final.json`.
O JSON não contém a mídia: selecione o vídeo ou áudio correspondente.
O modo padrão mantém os timestamps; o modo mídia completa soma a origem
do recorte declarada pelo Generator. Há também um ajuste manual em segundos.
A importação pode ser desfeita e não muda as revisões canônicas.
Exports concluídos permanecem disponíveis após reiniciar o servidor; um
render interrompido precisa ser solicitado novamente. Esta V1 edita trechos
de uma fonte por rascunho, sem mistura de vários vídeos ou trilhas livres.


### Combinar áudio e visual

Selecione/importe a fonte do áudio (vídeo, MP3 ou WAV). Em **Visual independente
 do áudio**, escolha uma imagem ou outro vídeo. O áudio do vídeo de fundo é
removido na importação. Ele se repete pelo tempo dos trechos de áudio; a imagem
permanece fixa. O estilo limpo também aceita esse fundo. Importe o JSON do Hub
correspondente à fonte do áudio para adicionar palavras sincronizadas.
