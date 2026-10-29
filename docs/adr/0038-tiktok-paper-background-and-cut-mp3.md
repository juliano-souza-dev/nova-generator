# ADR 0038 — Fundo de papel e áudio MP3 de recortes independentes

## Contexto
Produções sociais precisam alternar entre o vídeo original e uma página tipográfica
que use apenas o áudio recortado. O recorte também deve persistir um MP3 reutilizável,
sem depender da aprovação editorial ou de uma nova exportação.

## Decisões
- O contrato `nova-tiktok-media/1` adiciona dois campos opcionais com defaults
  compatíveis: `background_mode: video|paper` (video) e
  `paper_theme: cream|kraft|night` (cream).
- A mudança de fundo **não** substitui o vídeo, recorte, legendas, áudio ou
  timestamps. A prévia usa o mesmo elemento de vídeo como relógio de reprodução,
  mas esconde sua imagem no modo Papel.
- Na exportação, o MP4 do recorte continua sendo congelado e verificado por hash.
  Quando o fundo é papel, FFmpeg gera um canvas vertical 1080×1920 com textura
  e linhas discretas e sobrepõe o ASS já aprovado. O som é mapeado do MP4
  congelado ou da trilha enviada, segundo a seleção do operador.
- Em papéis claros, texto branco default é apresentado em tom escuro, sem
  modificar a opção guardada. A renderização das traduções também usa contraste
  próprio para fundos claros.
- O job `tiktok.ingest` grava `cuts/<job-id>.mp3` após o recorte/transcrição,
  por FFmpeg (MP3 44.1 kHz, `libmp3lame`, VBR qualidade 2). A gravação usa
  arquivo temporário e substituição atômica. O MP3 pertence ao **mesmo job** e
  nunca é encontrado por nome arbitrário.
- `GET /tiktok-media/projects/{id}/source/audio.mp3` resolve o recorte
  corrente pelo job validado. Arquivos de recortes antigos não são exibidos
  como se pertencessem à fonte atual. A API `source/status` informa
  `mp3_ready`, e a interface oferece player e link de download.
- O modo Papel não depende do arquivo MP3 para publicar: usa o áudio original
  do MP4 congelado. Essa separação evita substituições silenciosas.

## Critérios de verificação
1. Trocar Papel ↔ Vídeo não apaga legendas nem altera intervalos.
2. Papéis claro, kraft e noturno podem ser persistidos e restaurados.
3. MP3 só é oferecido se existir para o job atual; reprocessar ou trocar a
   fonte não aponta para o MP3 antigo.
4. MP4 com papel preserva duração, áudio original e legendas.
5. Produções anteriores continuam usando o vídeo original por padrão.

## Limites
- A textura do papel é uma aproximação visual por CSS e FFmpeg; diferenças
  pontuais de granulação entre prévia e exportação podem ocorrer.
- O MP3 é extraído ao concluir o processamento do trecho. Um erro de áudio
  impede concluir esse job, com mensagem de falha para correção/reprocessamento.
- Usar conteúdo protegido por direitos autorais depende da autorização aplicável.
