# ADR 0003: cache global YouTube como porta de mídia

**Status:** aceito em 2026-09-21

## Contexto

O legado baixa `original.mp4` dentro do diretório do projeto. Isso duplica uma
fonte quando URLs diferentes identificam o mesmo vídeo e mistura a vida útil da
fonte com a dos recortes do projeto. A documentação de migração define um cache
global por `video_id`, com metadata verificável e lock por entrada.

## Decisão

O domínio novo usa `YoutubeVideo` como valor imutável. Ele aceita URLs watch,
curtas, embed, shorts e live e produz a URL canônica. A aplicação depende apenas
da porta `YoutubeMediaCache`; `ResolveYoutubeSource` resolve `reused` ou
`missing`, mas não baixa mídia.

`FileYoutubeMediaCache` armazena cada entrada em
`media_cache/youtube/<video_id>/`. Uma entrada é reutilizável somente se
`metadata.json`, `source.mp4`, tamanho e SHA-256 coincidirem. A escrita do
metadata é atômica e o lock exclusivo `.download.lock` é por vídeo. O futuro
caso de uso de download deve adquirir o mesmo lock, instalar a fonte
atomicamente, validar FFprobe e só então chamar `save_verified`.

## Consequências

- URLs equivalentes reutilizam uma única identidade, sem expor caminhos locais
  nos contratos com o iHub.
- Esta fatia não chama yt-dlp, FFmpeg ou FFprobe e não altera o legado.
- Um arquivo corrompido nunca é cache hit; ele poderá ser rebaixado por uma
  fatia posterior.
- Recortes, áudio e demais derivados continuam responsabilidade do projeto,
  fora do cache global.
