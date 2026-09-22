# ADR 0004: Configuração e observabilidade local

## Decisão

Usar `pydantic-settings` para configuração tipada e validação no startup. Logs da aplicação
são JSON com campos de correlação permitidos explicitamente; payloads, texto e URLs nunca são
incluídos. Métricas operacionais são contadores e somas de duração por processo, emitidos também
como eventos JSON. O armazenamento permanece em SQLite e filesystem local.

## Consequências

Falta de FFmpeg, FFprobe, yt-dlp ou cloudflared habilitado impede o startup com erro acionável.
Modelos pesados continuam lazy para manter a API leve. Contadores não sobrevivem ao reinício;
para análise histórica, agregue os logs JSON. O ID de request atravessa HTTP; jobs usam sua ID
persistida para correlação independente do ciclo da requisição.
