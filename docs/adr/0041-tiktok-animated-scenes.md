# ADR 0041 — Cenas Animadas com imagens estáticas e movimentos locais

## Contexto

O TikTok Mídia já possui quadros 9:16 rasterizados no navegador, narração local e um worker FFmpeg para MP4. O computador de produção pode ter apenas CPU antiga e vídeo integrado; gerar cenas cinematográficas com modelos de difusão não é uma opção prática.

## Decisão

- Incluir **Cenas Animadas** como modo de criação de `lesson_video`, identificado pelo campo opcional `animated_scenes: false` no contrato `nova-tiktok-media/1`. Carrosséis e projetos antigos continuam estáticos.
- Cada quadro ganha os campos opcionais `motion` (`still`, `zoom_in`, `zoom_out`, `pan_left`, `pan_right`) e `background_image` (nome de PNG imutável dentro da própria produção). JSON externo não pode apontar para um arquivo de mídia do servidor.
- O navegador prepara fotos JPG/PNG/WebP para PNG vertical 1080×1920; a API limita o arquivo a 8 MiB, valida o cabeçalho e atrela a imagem ao quadro via revisão otimista. O preview, o ZIP de quadros e o render usam a mesma imagem e os mesmos textos.
- FFmpeg anima as capturas congeladas com `zoompan`; cada segmento retém o tempo e áudio existente. O modo leve rende 720×1280, e o modo de maior resolução usa 1080×1920. A opção não altera renderizações de vídeo de origem nem Shadowing.
- O manifesto registra revisão, movimento de cada quadro, qualidade escolhida, hashes de PNG e MP4, além dos dados já existentes. O snapshot congelado permanece retomável; falhas não alteram o projeto.
- A animação da prévia é uma aproximação visual via CSS do movimento no FFmpeg, não uma garantia pixel a pixel. O texto já está integrado ao PNG e acompanha o movimento da câmera nesta primeira fatia.

## Segurança, compatibilidade e recuperação

- Os nomes de fotos são UUIDs hexadecimais mais `.png`; uma rota só serve uma imagem se ela estiver referenciada por um quadro da mesma produção. Não há caminhos externos, execução de HTML, URL de terceiros ou upload automático.
- A API de upload exige projeto atualizado e grava o PNG sob novo nome antes de aumentar a revisão; uma tentativa obsoleta retorna conflito sem substituir a foto anterior.
- Projetos salvos antes desta extensão recebem `animated_scenes=false`, `motion=still`, `background_image=null`. Não há migration de banco e os contratos Generator–iHub permanecem intocados.
- Se um job falhar, abrir **Jobs**, ajustar a imagem, a qualidade ou a narração e gerar outra exportação. MP4 anteriores seguem disponíveis por ID. O rollback é voltar ao modo de quadros estáticos, preservando textos e imagens existentes.

## Aceite

1. Criar produção Cenas Animadas, adicionar uma foto própria, selecionar movimento e ver a prévia.
2. Salvar e reabrir sem perder foto, textos, movimento ou duração.
3. Exportar em 720p ou 1080p pelo FFmpeg local e obter MP4 com tempos de quadros válidos.
4. Projeto antigo mantém render estático e pode seguir editável sem qualquer conversão.
5. Revisão atrasada no upload não substitui outra versão; ausência de foto não impede um quadro textual.

## Agentes portáteis atualizados

`agentes/03-midia-e-tts-local.md`: o modo anima quadros e fotos sem IA de vídeo. Os revisores 01/02/05 continuam sendo os mesmos do mapa.
