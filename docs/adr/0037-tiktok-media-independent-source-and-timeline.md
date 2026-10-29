# ADR 0037 — Fonte e transcrição independentes no TikTok Media

## Problema

O fluxo anterior criava um projeto editorial ao colar um link, enviava o operador para `/media`
e só permitia vídeo legendado após a aprovação de cues em `/editorial`. Isso misturava dois
processos distintos, exigia trocas de tela e tornava impossível editar a transcrição no tempo do
vídeo diretamente no estúdio social.

## Decisão

- Uma produção `nova-tiktok-media/1` guarda opcionalmente `source_youtube_id` e
  `source_cut_job_id`. Ambos são campos aditivos; projetos e clientes anteriores continuam
  válidos. Os campos editoriais anteriores continuam apenas para importação opcional.
- O link é validado como identidade do YouTube; a preparação usa o cache global e o downloader
  existentes, mas os jobs `tiktok.download` e `tiktok.ingest` pertencem à própria produção.
- O usuário escolhe um intervalo de até 180 segundos do vídeo verificado; o worker recorta e
  transcreve com FFmpeg/waveform/Faster Whisper já usados pelo Generator. O MP4 fica dentro
  de `tiktok-media/<project-id>/cuts/` e não cria cena/cue editorial.
- O ASR gera blocos EN temporizados em rascunho, com PT inicialmente vazio, para que a tradução
  seja elaborada e corrigida no editor. Renderizar exige inglês nos blocos ativos, timing válido
  e um corte verificável, **mas não aprovação editorial** para produções independentes.
- O editor mostra player, timeline proporcional ao tempo, bordas de bloco arrastáveis, edição
  EN/PT, destaque, nota, estilo e exportação em painéis contextualizados.
- A bancada de edição tem navegação compacta, painel esquerdo de ferramentas mutuamente
  exclusivas (Fonte, Projetos, Criar, Importar) e inspetor contextual à direita (Texto, Visual,
  Exportar, Projeto). No desktop, vídeo, controles e timeline dividem a altura disponível sem
  rolagem vertical global; os painéis laterais possuem suas próprias áreas de rolagem.
- O render continua congelando o corte e o snapshot com hash. Se a fonte mudar, os blocos são
  limpos por escrita atômica. A incorporação do ASR usa revisão otimista e não sobrescreve
  ajustes posteriores do operador; tentativas do mesmo job são idempotentes.

## Compatibilidade e recuperação

- Contrato `nova-tiktok-media/1` mantido, apenas campos opcionais. Nenhuma tabela, migração,
  schema de `hub_final`, exportação iHub ou validação da bancada Editorial muda.
- Projetos antigos com `source_project_id`/`source_scene_id` continuam passando pela checagem
  de aprovação anterior. Produções novas usam o ID do job de corte e a transcrição independente.
- Jobs `tiktok.download` e `tiktok.ingest` são observáveis em Jobs. Em falha, o operador pode
  tentar novamente o link/corte. Para reprocessar, selecionar o intervalo e gerar nova transcrição;
  a produção anterior persiste até uma transcrição válida terminar.
- O rollback do novo percurso é desativar os botões de preparação independente; projetos antigos
  e renderizações anteriores permanecem legíveis por conta dos campos opcionais.

## Critérios de aceite

1. Colar um URL do YouTube no Media não cria projeto editorial nem navega para outra tela.
2. O operador vê o vídeo antes do ASR, marca um recorte e recebe os blocos na mesma produção.
3. Editar EN/PT/timing não exige aprovação em `/editorial` nem modifica cenas antigas.
4. `tiktok.render` usa exatamente o corte congelado com timestamps relativos, preserva silêncios
   e não substitui o áudio original inadvertidamente.
5. Um job atrasado ou repetido não altera um draft editado depois da transcrição.
6. Em 1366×768 e 1440×900, a bancada cabe na janela, sem overflow horizontal e sem precisar
   rolar a página para alternar prévia, timeline e edição; apenas uma ferramenta por lateral fica
   aberta de cada vez.

## Limites conhecidos

Esta fatia oferece timeline de legendas com cortes de até três minutos. Ainda não inclui
keyframes, multicamadas de efeitos, diarização de alto nível, karaoke palavra-a-palavra,
tradução automática revisada por IA, undo/redo ou transcrição de vídeos longos em lote.
Os textos de terceiros continuam sujeitos a autorização de uso na publicação.
