# ADR 0023 — Jornada sequencial de mídia e revisão

## Estado

Aceita.

## Contexto

Download, corte, waveform, ASR e importação editorial existiam como ações técnicas
independentes. O operador precisava transportar o ID interno do job de ASR para criar um
rascunho editorial, e a interface não conseguia reconstruir uma etapa coerente após recarga.

## Decisão

`GET /projects/{id}/media` deriva uma jornada dos artefatos verificados e dos jobs persistidos.
Nenhum estado paralelo é gravado: cache, arquivo de corte, hash da fonte e jobs continuam sendo
a fonte de verdade. `POST /media/start` reutiliza o cache global ou enfileira o download de forma
idempotente. O job de ingestão continua sendo a unidade retomável que executa corte, waveform e
ASR sempre sobre o MP4 cortado.

O adaptador yt-dlp tenta, em ordem, vídeo+áudio de melhor qualidade, MP4 progressivo, combinação
compatível e formato disponível. Cada tentativa é registrada e a fonte só entra no cache após
FFprobe.

`POST /editorial/projects/{id}/review` resolve o último candidato compatível com a fonte atual,
confere o corte e materializa a cena com IDs determinísticos. O autor operacional local é
definido pelo backend/UI e IDs de job deixam de ser entrada do operador.

## Recuperação

Jobs interrompidos preservam as regras de lease e retry. Repetir **Iniciar processamento** ou
abrir novamente **Revisar legenda** é seguro. Se a fonte ou seu hash mudar, o candidato anterior
é recusado e um novo corte precisa ser processado.

## Consequências

A API ganha campos de jornada aditivos e dois endpoints. Não há migration: o estado é derivado,
evitando divergência entre uma coluna de etapa e os artefatos reais. Clientes antigos continuam
compatíveis com os campos anteriores do snapshot.
