# ADR 0031: contrato editorial 1.3 reconcilia cue e word-by-word

## Contexto

O retorno editorial 1.2 podia corrigir `approved_en`, mas só devolvia `word_id` e tradução em
português para cada palavra. A superfície e o timing do word-by-word continuavam vindos do ASR.
Na validação da cena real, o áudio e o texto da cue exigiam `interests`, enquanto a palavra
persistida permaneceu `interest`. O documento era aceito e a bancada era liberada com duas fontes
de verdade incompatíveis.

## Decisão

O pacote externo e a resposta da Groq passam ao contrato editorial 1.3. A entrada inclui os tempos
da cue e, para cada palavra, separador literal (`leading`), superfície, tempos atuais e originais e
confiança do ASR quando disponível. O retorno contém uma revisão completa por palavra: ID e ordem
imutáveis, separador, superfície corrigível, intervalo e tradução contextual. `trailing` preserva o
literal posterior à última palavra.

Antes de persistir, o servidor exige todos os IDs na ordem original, intervalos inteiros,
positivos, ordenados e dentro da fala da cue. A concatenação byte a byte de `leading + surface` de
todas as palavras, seguida de `trailing`, precisa ser igual a `approved_en`. Texto, timing,
traduções, unidades semânticas e notas são gravados num único snapshot com comparação do hash da
entrada. A IA não pode inserir ou remover IDs; uma mudança de cardinalidade deve voltar à
reconciliação humana de palavras.

As versões 1.0, 1.1 e 1.2 continuam legíveis para diagnóstico e migração. Somente 1.3 pode liberar
a bancada porque as versões anteriores não comprovam a reconciliação do word-by-word.

## Consequências

- O inglês da cue e a sequência usada no iHub não podem divergir silenciosamente.
- Espaços, Unicode e pontuação tornam-se parte verificável do contrato.
- A IA pode corrigir uma palavra e seu intervalo sem trocar seu ID ou apagar o timing original.
- Respostas antigas continuam inspecionáveis, mas precisam ser regeneradas para preparar a cena.

## Recuperação

Em caso de rejeição, gere novamente o pacote 1.3 sobre a cena atual. Corrija o JSON sem alterar
`scene_id`, `input_sha256`, IDs ou ordem. Se a correção exigir inserir, remover, dividir ou unir
palavras, faça a reconciliação na bancada e gere um novo pacote; não force essa mudança pelo
contrato 1.3.
