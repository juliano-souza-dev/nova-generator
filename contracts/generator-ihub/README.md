# Contratos Generator–iHub

Esta pasta é a fonte de verdade versionada para os pacotes que saem do Nova Generator e entram no iHub. O proprietário é o agente **05 Integração e Release**; os agentes de Mídia e História revisam respectivamente os contratos de reel e História.

## Uso

1. Escolha a versão em `v1/` declarada pelo pacote.
2. Valide o JSON contra o schema correspondente em `v1/schemas/` antes de publicar ou importar.
3. Execute os dois exemplos em `v1/fixtures/valid/` como testes de aceitação entre os repositórios.
4. Confirme que cada arquivo em `v1/fixtures/invalid/` é recusado pelo motivo esperado no seu README.

Os schemas usam JSON Schema Draft 2020-12. Campos textuais (`en`, `pt`, `title`, `description`) são literais: consumidores não podem remover, normalizar ou reconstituir acentos, Unicode ou pontuação.

## Contratos

| Pacote | Schema | Finalidade |
| --- | --- | --- |
| Reel de áudio Anki | `hub-final.schema.json` | Faz o iHub tocar no YouTube o intervalo correspondente ao WAV usado no card Anki. |
| História texto + áudio | `immersionhub-text-audio-1.1.schema.json` | Importa a produção independente de História com vídeo publicado manualmente. |

O Generator **não envia vídeo ao YouTube**. Depois da publicação manual, recebe e valida URL/ID; o identificador entra no pacote final.

## Política de compatibilidade

- `contractVersion` é SemVer. Um pacote `1.x` é aceito pelo consumidor que suporte major `1`; campos novos opcionais em minor releases devem ser ignorados por consumidores anteriores.
- Uma alteração que mude significado, remova campo, altere tipo, torne campo opcional obrigatório ou mude unidade de tempo exige major novo (`v2/`), schema e fixtures próprios.
- O iHub deve aceitar a última minor do major anterior durante a janela de transição registrada na ADR e nas notas de release. Essa janela só termina após migração/reimportação dos pacotes pendentes e teste integrado de rollback.
- Valores enumerados novos são alteração compatível somente quando o consumidor trata valores desconhecidos de forma explícita e segura; caso contrário exigem major.
- A ordem de cues é canônica e começa em 1. Tempos são inteiros em milissegundos relativos ao início do vídeo; intervalos não podem sobrepor-se.
- Um consumidor deve rejeitar schema desconhecido, major incompatível, URL/ID divergentes, texto ausente, tempos inválidos e dados extras não previstos pelo contrato.

## Processo de mudança

1. Registrar ADR antes de mudar contrato público.
2. Criar/alterar schema, fixture válida e fixture inválida no mesmo pull request.
3. Rodar validação no Generator e no importador do iHub usando as fixtures.
4. Documentar migration, janela de transição e rollback nas notas de release.

