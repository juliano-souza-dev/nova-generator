# Contrato editorial externo 1.3

O Generator cria `editorial_input.json` e um modelo de
`nova-generator-editorial-suggestions/1.3`. A IA externa devolve somente o JSON do modelo
preenchido. O servidor também aplica as invariantes semânticas que JSON Schema não expressa:

- cena e hash iguais ao pacote atual;
- todos os cues e palavras uma vez, nos mesmos IDs e ordem;
- palavras ordenadas, sem sobreposição e dentro de `speech_start_ms..speech_end_ms`;
- `approved_en` idêntico à concatenação de `leading + surface` e `trailing`;
- unidades semânticas contíguas e sem sobreposição.

Versões 1.0–1.2 permanecem legíveis, porém não liberam a bancada. Se a correção exigir mudar a
quantidade de palavras, faça split/merge na bancada e gere outro pacote.

