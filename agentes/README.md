# Especialistas do Nova Generator

Estes arquivos são instruções portáveis para Codex e outros sistemas de IA. Cada agente descreve o dono da área, entradas, saídas, limites e critérios de aceite. Não são processos em execução.

| Arquivo | Use quando a tarefa envolver |
| --- | --- |
| `01-arquitetura-e-plataforma.md` | domínios, API, banco, migrations, jobs, cache, observabilidade e arquitetura limpa |
| `02-estudio-editorial-ux-qa.md` | cues, palavras, timing, texto EN/PT, interface de revisão e qualidade editorial |
| `03-midia-e-tts-local.md` | download, FFmpeg, voz Chatterbox, áudio Anki, reel e sincronização |
| `04-modo-historia.md` | ZIP de imagens/JSON, narração, vídeo e conteúdo didático de História |
| `05-integracao-e-release.md` | contratos Generator–iHub, fixtures, compatibilidade, testes integrados e release |

## Como colaborar

1. Escolha o agente dono da mudança.
2. Leia `../AGENTS.md` e o arquivo do agente.
3. Escreva ou atualize o critério de aceite antes de implementar.
4. Quando houver mais de uma área, defina um agente principal e consulte os demais como revisores obrigatórios.
5. Registre decisões estruturais em ADR e mantenha fixtures de contrato executáveis.

