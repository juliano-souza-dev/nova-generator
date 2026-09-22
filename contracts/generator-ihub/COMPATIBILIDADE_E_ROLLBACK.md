# Compatibilidade e rollback Generator--iHub

O contrato público é lançado com SemVer no repositório do Generator. O diretório `v1` contém todas as releases compatíveis com major `1`. Os nomes dos campos externos são mantidos pelo iHub: História usa `schema_version: "1.1"`; o reel é um bloco `ankiAudio` dentro de `hub_final.json`.

## Mudanças compatíveis

Patch corrige schema, documentação ou validação sem mudar payload válido. Minor pode acrescentar campo opcional desde que o iHub ignore campos que não reconhece. Ambos exigem fixture válida e inválida, execução do runner e teste no importador do iHub.

## Mudanças incompatíveis

Remover ou renomear campos, mudar tipos ou unidades, alterar o sentido de um campo, exigir novo campo, ou introduzir enum que clientes antigos não tratam cria `v2`. A mudança deve incluir ADR, schemas e fixtures novos, janela de transição, migration/reimportação e responsável pelo aceite.

## Rollback de release

1. Interromper novas exportações da versão afetada.
2. Manter o importador do iHub aceitando o major anterior durante a janela aprovada.
3. Reexportar o pacote a partir do manifesto preservado pelo Generator; não reconstruir EN/PT nem highlights.
4. Para reel Anki, preservar o MP4 e os intervalos já publicados; reverter apenas o manifesto/JSON quando possível.
5. Para História, preservar o `youtubeVideoId` validado e publicar o envelope anterior com os mesmos textos literais e intervalos.
6. Executar `python -m nova_generator.infrastructure.integration.contract_runner` em um ambiente com o pacote instalado (ou `PYTHONPATH=src` localmente), registrar o incidente e somente encerrar após importar as fixtures válidas no iHub.

Não existe upload automático para YouTube; rollback nunca altera o vídeo remoto.
