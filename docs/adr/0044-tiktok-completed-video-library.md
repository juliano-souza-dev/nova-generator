# ADR 0044 — Biblioteca persistente de vídeos do TikTok Mídia

- Status: Aceita
- Contexto: a exportação MP4 salva \`final.mp4\` e \`manifest.json\` em um diretório por renderização. A interface guardava \`job_id\` e \`render_id\` apenas em estado temporário; ao navegar, o link para download desaparecia.
- Decisão: criar uma rota de leitura \`GET /api/tiktok-media/library\` que enumera manifestos de exportações concluídas e vídeos locais válidos. Uma página independente **Biblioteca** permite assistir, baixar e reabrir a produção original. O projeto usa seu identificador estável em um parâmetro de navegação.
- Integridade: somente pares \`manifest.json\` + \`final.mp4\` não vazio com cabeçalho MP4 e identidade de projeto/render válida são exibidos. Não há edição, cópia de arquivos nem exclusão pela Biblioteca. O manifesto já é publicado atomicamente pelo worker depois da validação; renderizações pendentes ou com erro não possuem manifesto final.
- Compatibilidade: biblioteca faz leitura dos renders existentes, inclusive os anteriores à funcionalidade. Mantém \`nova-tiktok-media/1\`, \`nova-tiktok-media-render/1\`, contratos iHub, banco e endpoints de exportação inalterados. O download existente ganha parâmetro opcional \`download=true\` para forçar anexo, sem alterar o comportamento atual.
- Operação e recuperação: após reiniciar API e worker, a Biblioteca reconstitui o índice diretamente do armazenamento local. Se um vídeo tiver sido removido, ele deixa de aparecer; para recuperá-lo, repetir a exportação pelo projeto original. Nenhum arquivo de mídia é apagado por esta mudança.
- Verificação: testes de múltiplas exportações, Unicode, itens incompletos/ausentes, navegação até projeto e download, além do conjunto de testes de mídia do Generator.
- Alternativa descartada: manter um segundo catálogo mutável no banco. Duplicaria o estado já garantido pelo manifesto e exigiria migration, sincronização e reconciliação em retomadas.
