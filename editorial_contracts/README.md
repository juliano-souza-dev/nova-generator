# Contrato editorial v1

Este diretório é independente do legado e define o documento que o backend, a interface de revisão e futuros exportadores devem compartilhar para cues, texto EN/PT, tokens e timing palavra a palavra.

## Fonte de verdade

- `schema.json` fixa a estrutura pública `nova-generator/editorial-cues` versão `1.0`.
- `python/editorial_contract.py` valida invariantes que JSON Schema não expressa.
- `fixtures/` contém exemplos executáveis. Eles não são dados de produção.
- `tests/` roda somente com a biblioteca padrão do Python: `python -m unittest discover -s editorial_contracts/v1/tests -v`.

## Regras que não podem ser enfraquecidas

1. `original_en`, `approved_en` e `approved_pt` são textos literais. Cada um traz SHA-256 do seu UTF-8; alteração textual exige atualizar o valor e seu hash deliberadamente.
2. `tokens` cobrem **cada caractere** de `approved_en`, em ordem e sem lacunas. Espaços e pontuação são tokens próprios, portanto aspas, vírgulas, reticências, apóstrofos e acentos não são reconstruídos por `join`.
3. Apenas tokens `word` possuem timing. Cada timing está dentro de `speech_timing`, tem duração positiva e não retrocede em relação à palavra anterior.
4. Alterar timing não muda texto, superfícies nem offsets. Alterar `approved_en` exige reconciliação explícita de tokens, nova revisão e incremento de `revision`.
5. IDs de cue e token são estáveis. Split/merge é uma operação de domínio futura e deve preservar os IDs sobreviventes ou registrar proveniência; nunca deve apagar texto aprovado ou histórico.

O formato usa a timeline local do recorte (`scene_local_ms`); offsets do vídeo de origem não pertencem a cues ou tokens.

## Adoção posterior

O backend deve receber este documento, validá-lo antes de persistir e usar `validate_document`. Uma implementação Pydantic pode espelhar o schema, mas não deve substituir estas verificações sem preservar todas as invariantes.
