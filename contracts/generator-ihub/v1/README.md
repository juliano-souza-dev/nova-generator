# Generator–iHub v1

`v1` contém dois contratos independentes. A versão do diretório é o major do contrato; o campo `contractVersion` identifica a revisão SemVer utilizada pelo pacote.

| Artefato | Arquivo | Aceite mínimo |
| --- | --- | --- |
| Reel Anki | `schemas/hub-final.schema.json` | Cada cue aponta para um intervalo seekável no mesmo reel do YouTube e possui snapshot da voz. |
| História | `schemas/immersionhub-text-audio-1.1.schema.json` | Cada cue preserva EN/PT literal, tempos e highlights ligados a um trecho do inglês. |

Os exemplos em `fixtures/valid` usam `contractVersion: "1.0.0"`. A implementação pode expor erros por campo, mas deve recusar os exemplos inválidos abaixo:

| Fixture | Erro esperado |
| --- | --- |
| `invalid/hub-final-overlapping-cues.json` | Cues com intervalos sobrepostos. |
| `invalid/hub-final-youtube-id-mismatch.json` | `videoId` não corresponde ao ID presente em `youtubeUrl`. |
| `invalid/story-highlight-outside-text.json` | Highlight não corresponde a um trecho literal de `en`. |
| `invalid/story-unsorted-cues.json` | Ordem e tempos dos cues não são canônicos. |

