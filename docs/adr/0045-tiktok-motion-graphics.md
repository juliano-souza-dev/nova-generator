# ADR 0045 — Motion Graphics sincronizados no TikTok Media

- Status: Aceita
- Contexto: vídeos educativos precisam de destaques visuais curtos sincronizados com a explicação e acompanhados por efeitos sonoros. A legenda sozinha não cobre essa linguagem visual.
- Decisão: acrescentar uma coleção opcional `motion_graphics` ao contrato independente `nova-tiktok-media/1`. Cada evento guarda ID, instante relativo ao corte, duração, ícone, rótulo, animação, posição, efeito sonoro e estado ativo. O campo tem lista vazia como padrão para compatibilidade com produções antigas.
- Renderização: eventos visuais são gravados como eventos ASS sobre o mesmo relógio do corte e das legendas. Efeitos sonoros curtos são gerados localmente pelo FFmpeg, atrasados pelo mesmo `start_ms` e mixados à trilha escolhida. O áudio original permanece como base; sem trilha, os efeitos podem formar a faixa de áudio.
- Edição: a bancada oferece painel Movimento, prévia visual, marcadores na timeline e controles para ícone, texto, entrada, duração, animação, som, posição e ativação.
- Compatibilidade: sem migration de banco, sem alteração do contrato Generator–iHub e sem mudança na versão pública do contrato TikTok.
- Limites: esta entrega aplica Motion Graphics à exportação de vídeos com fonte/corte e legendas. Shadowing permanece inalterado para preservar o áudio e os tempos aprovados.
- Verificação: testes de compatibilidade do contrato, IDs únicos, duração, renderização ASS e texto literal seguro, além da regressão dos testes TikTok existentes.
