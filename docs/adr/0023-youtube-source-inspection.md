# ADR 0023: inspeção da fonte YouTube antes da criação da produção

## Estado

Aceita em 23/09/2026.

## Contexto

Uma produção depende de uma fonte YouTube, mas o formulário permitia omitir a URL e exigia que
o operador repetisse manualmente o título. O download completo não deve ser necessário para
validar a identidade e os metadados da fonte.

## Decisão

- Produções exigem URL YouTube e aceitam título manual opcional.
- Um caso de uso consulta metadados com `yt-dlp` e `download=False`, antes de criar o projeto.
- A inspeção é armazenada por dez minutos em memória, pela identidade canônica do vídeo. A
  criação reutiliza esse resultado quando acontece no mesmo processo e volta a inspecionar com
  segurança quando o cache expira ou quando outro processo atende a requisição.
- O projeto grava no JSON de proveniência URL canônica, ID, título detectado, canal, instante da
  inspeção e a origem do título (`youtube` ou `manual`). O schema SQLite já possui proveniência
  extensível, portanto esta decisão não requer migration.
- História continua independente: a criação por ZIP não exige YouTube. A compatibilidade do
  endpoint genérico para `content_type=story` é mantida, exigindo apenas seu título.

## Recuperação

Se a inspeção falhar, nenhum projeto é gravado. O operador pode corrigir a URL ou tentar novamente.
Remover o cache em memória exige apenas reiniciar a API; nenhum dado persistido é perdido.
