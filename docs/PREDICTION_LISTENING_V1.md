# Prediction Listening 1.0

## Objetivo

Prediction Listening é um módulo editorial independente do Nova Generator. Ele identifica oportunidades para o aluno prever uma palavra, expressão ou resposta de diálogo antes de ouvir a continuação do vídeo.

O módulo não altera a tradução editorial nem o editor de mídia. Ele reutiliza o padrão de IA externa já existente: TXT enumerado, processamento em qualquer IA, importação de JSON, validação local e revisão humana.

## Pré-requisitos

A geração só fica disponível quando:

1. A seleção do Shadowing foi salva.
2. A seleção continua vinculada à versão atual da transcrição e da tradução.
3. Todos os blocos selecionados possuem alinhamento palavra por palavra do WhisperX.

O terceiro requisito é necessário porque os instantes de pausa e retomada são reconstruídos a partir dos tempos originais das palavras. O módulo não aceita timestamps inventados pela IA.

## Fluxo

1. O Nova Generator prepara prediction-listening-entrada.txt.
2. O TXT inclui instruções pedagógicas, hash da origem, cues numeradas e palavras numeradas.
3. A IA externa devolve JSON no contrato nova-generator-prediction-listening-output/1.0.
4. O importador confere o hash, os números, os tipos, a continuidade do trecho original e as quatro alternativas.
5. O Nova Generator recupera os timestamps das palavras alinhadas e cria desafios em estado draft.
6. O editor aprova, rejeita ou devolve cada desafio para revisão.
7. Somente desafios aprovados podem ser exportados em nova-generator-prediction-listening-materials/1.0.

## Tipos de desafio

- word: previsão de uma palavra.
- expression: previsão de uma expressão ou sequência curta e contígua.
- dialogue: previsão de uma resposta ou continuação conversacional.

Cada desafio contém quatro alternativas distintas e exatamente uma resposta correta. A alternativa correta precisa corresponder ao trecho original normalizado, desconsiderando apenas caixa e pontuação.

## Integridade e armazenamento

- O hash usa o mecanismo FNV-1a já utilizado pelo contrato editorial.
- A IA recebe números de cues e palavras, nunca IDs internos ou timestamps.
- Os timestamps são reconstruídos localmente a partir do alinhamento WhisperX.
- Os resultados ficam em uma pasta própria prediction-listening dentro dos dados do projeto.
- A aprovação é manual e individual.
- O JSON exportado contém apenas desafios aprovados e não inclui a justificativa editorial interna.

## Contratos

- Entrada: nova-generator-prediction-listening-input/1.0
- Saída externa: nova-generator-prediction-listening-output/1.0
- Revisão interna: nova-generator-prediction-listening-review/1.0
- Materiais aprovados: nova-generator-prediction-listening-materials/1.0
