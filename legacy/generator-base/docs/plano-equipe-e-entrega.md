# Equipe e entrega para a reestruturação do Generator

## Objetivo

Entregar um Generator modular e confiável, que permita revisar legendas com precisão, reutilize mídia baixada, gere voz local consistente e produza pacotes que o iHub consiga importar sem retrabalho.

O trabalho é organizado por **responsabilidade pelo resultado**, não por tecnologia. Uma pessoa pode acumular papéis em uma equipe pequena, mas cada decisão precisa ter um responsável explícito.

## Papéis

| Papel | Decide | Entrega e valida |
| --- | --- | --- |
| Product owner e revisão pedagógica | prioridade, exemplos de referência e aceite editorial | critérios de aceite, texto EN/PT, utilidade didática e publicação |
| Liderança técnica | limites de contexto, contratos, arquitetura e riscos | ADRs, dependências, migrations, observabilidade e revisão técnica |
| Engenharia de experiência editorial | fluxo de cues e palavras | protótipos, interface de revisão, atalhos, acessibilidade e testes de interface |
| Engenharia de mídia e IA | pipeline de vídeo, áudio e voz | cache de mídia, TTS local, FFmpeg, timings, reels e modo História |
| Qualidade e release | estratégia de testes e liberação | regressão, fixtures, compatibilidade com iHub e checklist de release |

Em uma formação de três pessoas, a composição mínima é: product owner/editorial; liderança técnica/backend; e engenharia frontend/mídia. A qualidade é uma responsabilidade rotativa, com aceite final do product owner.

## Frentes de trabalho

### 1. Plataforma e contratos

É dona do banco SQLite, migrations, tabela de jobs, arquivos locais, cache global de vídeo, logging e APIs. Mantém schemas versionados e exemplos executáveis dos contratos Generator–iHub.

### 2. Estúdio editorial

É dona do fluxo de importação, preservação literal do texto aprovado, divisão e união de cues, edição de palavra por palavra, sugestões, auditoria e aprovação.

### 3. Mídia e voz local

É dona de perfis de voz, Chatterbox isolado, cache de áudio, geração Anki, reel MP4 e validação do vídeo no YouTube usado pelo Hub.

### 4. Modo História

É dona do pacote ZIP, validação de imagens e JSON, narração, composição de vídeo e envelope `immersionhub-text-audio` para importação.

### 5. Integração, qualidade e release

É dona das fixtures entre os dois repositórios, testes de contrato, regressão de mídia, migrations, notas de versão e rollback.

## Regra de integração Generator–iHub

Nenhuma frente altera um contrato sozinha. A pessoa que propõe a mudança deve fornecer, no mesmo pull request ou ADR:

1. versão do schema;
2. exemplo mínimo válido e exemplo inválido;
3. política de compatibilidade ou migração;
4. fixture consumida pelos testes dos dois sistemas;
5. responsável pelo aceite no iHub.

Os contratos prioritários são o reel de áudio do Anki (`hub_final.json` com `ankiAudio`) e História (`immersionhub-text-audio`, versão 1.1).

## Fluxo de uma entrega

1. **Descoberta:** product owner descreve o problema com material real e critérios de aceite mensuráveis.
2. **Preparação:** UX apresenta o fluxo; engenharia registra ADR se a decisão for estrutural; integração aprova a alteração de contrato.
3. **Fatia vertical:** a tarefa inclui domínio, API, interface, processamento de mídia e teste necessário para demonstrar a jornada inteira.
4. **Revisão:** uma pessoa revisa a regra de negócio e outra, quando houver risco, revisa o contrato, mídia ou arquitetura.
5. **QA e aceite:** fixture real percorre Generator e iHub; revisão editorial aprova texto, tempo e comportamento percebido.
6. **Release:** migration, compatibilidade, logs, métrica e rollback são confirmados antes da liberação.

## Definição de pronto

Uma tarefa só pode ser concluída quando:

- o critério de aceite foi demonstrado com um projeto de exemplo;
- textos finais preservam acentos e pontuação aprovados;
- toda mudança de timing respeita as invariantes documentadas de cue e palavra;
- contratos e fixtures foram atualizados, quando aplicável;
- testes pertinentes passaram e a regressão conhecida foi coberta;
- logs permitem identificar projeto, job, artefato e falha;
- há instrução de recuperação para uma falha de job, mídia ou migration.

## Métricas de resultado

As métricas servem para melhorar o sistema, nunca para avaliar pessoas isoladamente:

| Área | Métrica |
| --- | --- |
| Editorial | tempo até aprovação, reaberturas por cue, correções após exportação |
| Mídia | sucesso de download/TTS/reel, duração de jobs, reaproveitamento de cache |
| Integração | taxa de importação válida no iHub, incompatibilidades de schema |
| Entrega | tempo da tarefa até release, falhas após release e tempo de recuperação |

## Ordem recomendada

1. Congelar e testar os contratos atuais Generator–iHub.
2. Separar domínio, infraestrutura e interface sem mudar o comportamento exportado.
3. Criar o fluxo editorial unificado para cues e palavras.
4. Implantar cache global de vídeo e jobs persistentes.
5. Substituir TTS remoto por Chatterbox local e gerar reels compatíveis.
6. Construir o modo História como produção independente.
7. Endurecer observabilidade, testes de regressão e releases.

Essa ordem reduz risco: primeiro protege a compatibilidade com o iHub; depois melhora a edição; por fim amplia produção de mídia e IA.
