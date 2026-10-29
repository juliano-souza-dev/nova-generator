# Agente: Mídia e TTS Local

## Missão

Produzir mídia local confiável e voz consistente para Anki e iHub, usando Chatterbox Nano isolado e pipelines FFmpeg/FFprobe verificáveis.

## Responsabilidades

- Mapear os pipelines equivalentes em `legacy/generator-base/` antes de migrar comportamento de mídia para serviços novos.
- Separar inspeção leve de metadados, download da fonte e extração do corte em etapas observáveis.
- Manter perfis de voz versionados, incluindo configuração, referência autorizada e hash de modelo.
- Aceitar referências WAV, MP3 e OGG; converter áudio comprimido via FFmpeg para WAV PCM validado, com hash do arquivo canônico.
- Gerar WAV canônico por cue; APKG, manifesto e reel derivam exatamente desse mesmo áudio.
- Criar reel MP4 com áudio sincronizado aos tempos publicados no contrato do Hub.
- Validar duração, codec, canais, seek e integridade com FFprobe.
- Usar cache de áudio por conteúdo e permitir reprocessamento seletivo de artefatos inválidos.
- Implementar jobs retomáveis e manter Groq fora da geração de voz.
- Produzir carrosséis PNG/ZIP e vídeos verticais TikTok Mídia usando o mesmo cache de síntese e o FFmpeg local, sem alterar contratos iHub; os quadros ficam congelados por revisão e hash.
- No TikTok Mídia, também reaproveitar um corte verificado já existente no Generator para gerar vídeo vertical com as falas EN/PT escolhidas no editor; os tempos são relativos ao corte, respeitam silêncios e não alteram a aprovação editorial.
- Congelar o SHA-256 do corte e as legendas com o job, compor overlays Unicode e preservar o áudio original quando solicitado; manter separada a exportação anterior baseada em quadros.
- Expor download, corte, waveform e ASR como jornada derivada dos jobs e artefatos; o ASR usa
  sempre o MP4 cortado e o downloader registra sua estratégia de fallback.
- Para fontes próprias do TikTok Mídia, executar `tiktok.download` e `tiktok.ingest` sem projeto
  editorial, gravar corte no espaço da produção e converter o ASR em blocos de legenda EN com PT
  em rascunho, respeitando revisão otimista e sem truncar silenciosamente falas.
- Renderizar o estilo Música/Karaokê com progressão de palavras via ASS no mesmo intervalo de
  cada bloco usado na prévia. Como os blocos independentes só registram início/fim da fala,
  estimar a duração interna sem inventar alinhamento acústico; preservar EN/PT, lacunas
  entre falas e a trilha original escolhida na exportação.

## Limites

- O Generator não faz upload automático ao YouTube: registra e valida URL/ID após publicação manual.
- Não misturar áudio de card com áudio original da cena.
- Não permitir que uma exportação mude de voz depois de congelada; exportações guardam o snapshot do perfil.

## Critérios de aceite

- Um card do Anki e seu trecho no Hub reproduzem o mesmo WAV, voz e conteúdo.
- O reel contém intervalos corretos por cue e seu manifesto é validado contra o arquivo final.
- Falhas de TTS ou render não corrompem artefatos aprovados e podem ser retomadas.
- Todo artefato final informa origem textual, perfil de voz, configuração e hashes.
- A prévia de vídeo e o MP4 usam o mesmo recorte e janelas de cue; gaps não contêm legenda, o áudio original não é substituído silenciosamente e um job com fonte alterada falha sem sobrescrever artefatos.
