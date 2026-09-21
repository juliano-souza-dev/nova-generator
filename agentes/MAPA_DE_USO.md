# Mapa de uso dos agentes

Leia este mapa antes de delegar uma tarefa. Se ela tocar mais de uma linha, escolha o responsável da maior alteração e convide os agentes indicados como revisores.

| Mudança | Responsável | Revisores obrigatórios | Artefatos que devem acompanhar |
| --- | --- | --- | --- |
| Domínio, API, SQLite, migrations, worker, cache ou logs | 01 Arquitetura e Plataforma | 05 Integração e Release | ADR quando estrutural, migration, testes e logs |
| Texto EN/PT, cues, tokens, timing, waveform ou interface de revisão | 02 Estúdio Editorial, UX e QA | 01 Arquitetura; 05 quando exportar | fixtures editoriais, testes de domínio/UI e critérios de aceite |
| Download, FFmpeg, FFprobe, áudio, Chatterbox, Anki ou reel | 03 Mídia e TTS Local | 01 Arquitetura; 05 Integração | manifesto de artefatos, fixtures de mídia e testes de validação |
| ZIP de história, imagens, highlights, narração ou vídeo de História | 04 Modo História | 03 Mídia; 05 Integração | schema do ZIP, fixture de História e testes de validação |
| `hub_final.json`, `ankiAudio`, `immersionhub-text-audio`, importação no Hub ou release | 05 Integração e Release | agente dono do conteúdo | schema versionado, fixture válida/inválida, compatibilidade e rollback |

## Protocolo de atualização

Depois de qualquer alteração, o agente responsável verifica se seu arquivo portátil ainda descreve a realidade. Se não descrever, ele o atualiza no mesmo commit. Mudanças de roteamento atualizam também este mapa. Uma alteração sem impacto nesses documentos deve registrar no pull request: `Agentes portáteis: sem alteração — [motivo]`.

## Ordem da primeira entrega

1. Arquitetura cria o esqueleto de execução, limites de módulos e contratos internos.
2. Integração congela schemas e fixtures iniciais do Generator–iHub.
3. Editorial modela texto, cue e palavra sem perda literal.
4. Mídia implementa portas e manifestos, sem acoplar-se à interface ou ao provedor de voz.
5. História usa as mesmas portas de voz e publicação, mantendo produção independente.

