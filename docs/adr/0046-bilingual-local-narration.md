# ADR 0046 — Narração local bilíngue por trechos marcados

## Contexto

O campo independente `narration_text` (ADR 0043) já existe no TikTok Mídia, mas o subprocesso Qwen3-TTS sempre sintetizava em português. Em microaulas de inglês, palavras e exemplos pronunciados pelo motor com idioma errado prejudicam a naturalidade da voz.

## Decisão

- Preservar Chatterbox e Qwen3-TTS atuais; não instalar XTTS, Gradio ou pesos novos.
- Reconhecer trechos literais `[pt]...[/pt]` e `[en]...[/en]` no roteiro de narração independente, aceitando alternância e ordem livres. Trechos incompletos, aninhados ou texto fora das tags são rejeitados com erro acionável.
- O Qwen3-TTS recebe `Portuguese` ou `English` a cada trecho, utilizando sempre o mesmo perfil, referência autorizada e snapshot de pesos.
- Concatenar as ondas geradas em um único WAV PCM-16 canônico, com 300 ms de silêncio apenas **entre** os trechos. Rejeitar frequências de amostragem divergentes.
- O texto sem marcação mantém o comportamento legado em português. Chatterbox, que não recebe idioma explicitamente, continua funcionando com texto comum e rejeita tags com orientação para selecionar Qwen.
- As prévias e caches dos perfis existentes permanecem intactos. No editor TikTok, o proprietário pode montar um roteiro marcado a partir dos campos EN/PT sem modificar legendas aprovadas.
- Manter cache por texto literal, perfil e parâmetros; não mudar schemas públicos, IDs, exportações antigas, contratos iHub ou modelo de jobs.

## Aceite

- Parser conserva Unicode, ordem e conteúdo dos trechos; rejeita marcações incorretas.
- Ambos os mecanismos Qwen usam idioma correto e preservam o mesmo perfil de voz.
- A forma de onda final tem uma pausa de 300 ms por transição, sem silêncio extra no fim, com amostragem única.
- Perfis antigos Chatterbox e roteiros Qwen sem tags continuam sintetizando como antes.
- A exportação TikTok usa `narration_text` existente, sem alterar os textos EN/PT do quadro.

## Recuperação

Se a síntese marcada falhar, corrigir o trecho inválido ou remover as tags para usar a narração anterior. Selecionar um perfil Chatterbox não modifica os projetos nem os WAVs já produzidos. Se um roteiro for alterado, sua nova chave de cache evita sobrescrever áudios publicados.

## Agentes portáteis

03 Mídia e TTS Local: responsável. 01 Arquitetura e 05 Integração: revisores. `agentes/MAPA_DE_USO.md` permanece válido sem alteração.
