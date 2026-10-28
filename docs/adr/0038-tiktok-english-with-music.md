# ADR 0038 — Inglês na Vida Real: microaulas com música no TikTokMedia

## Contexto

O TikTokMedia já possui editor 9:16, quadros com duração editável, revisão de sugestões da Groq,
importação JSON externa e exportação MP4/carrossel. O novo segmento pedagógico precisa transformar
trechos de 30–60 s em uma mini-aula, sem presumir licenças musicais, copiar letras de terceiros ou
alterar projetos editoriais aprovados.

## Decisão

- Adicionar **Inglês na Vida Real · Música** como compositor guiado na interface do TikTokMedia.
- Exigir referência a música, artista, início/fim (`mm:ss`), expressão fornecida pelo editor,
  tradução, explicação, estrutura, exemplos originais cotidianos/profissionais e desafio.
- Criar uma **proposta**, não salvar ou sobrescrever diretamente. Sete quadros (abertura, expressão,
  explicação, estrutura, dois exemplos e desafio) somam exatamente a duração do trecho, com cada
  quadro entre 1 e 20 s. Propostas permitem inspeção de conteúdo e tempo antes de aplicar.
- Uma proposta deste modelo é aplicada como `lesson_video` e reutiliza sem alterações o canvas,
  autosave, upload de áudio autorizado, voz opcional, job FFmpeg e exportação existentes.
- Um segundo botão preenche o prompt da integração Groq atual, sem disparar geração automática.
  O resultado da IA continua sujeito à revisão humana.
- O intervalo informado é **referência editorial**: o corte físico é feito na área Mídia. Não
  baixar, transcrever ou incorporar automaticamente música/letra por esse compositor.
- Bloquear o compositor quando o projeto estiver no modo de vídeo de origem, para não descartar
  silenciosamente uma cena vinculada.

## Compatibilidade

Nenhuma mudança em `nova-tiktok-media/1`, API, banco, worker, arquivos de projetos anteriores,
contratos Generator–iHub ou `hub_final.json`. É uma fatia vertical de frontend. Voltar à versão
anterior da interface não exige migração e não remove projetos ou renders.

## Critérios de aceite

1. O exemplo de *Count on Me* de 00:15 a 01:10 gera sete quadros com 55.000 ms no total.
2. Trechos de 30 e 60 s são válidos; durações fora da faixa ou inversões são rejeitadas.
3. Textos EN/PT, acentos e contrações são preservados. O desafio exibe a pergunta em português,
   e sua resposta em inglês permanece editável.
4. A proposta não altera a produção até a ação **Aplicar proposta**; ela pode ser descartada.
5. O projeto com vídeo original vinculado permanece intacto; a publicação requer áudio autorizado.
6. Testes unitários/UI e gates de frontend passam sem regressão.

## Recuperação

Se o usuário não gostar da proposta, descartar antes de aplicar. Após aplicar, editar os quadros
e usar o autosave normal. Falhas de render continuam sendo investigadas em **Jobs**, sem
substituição de exports anteriores.

## Agentes portáteis atualizados

Sem alteração: a divisão entre os agentes 03 (mídia), 02 (UX) e 05 (integração) já cobre este
compositor frontend. Não há novo contrato, responsabilidade, artefato de exportação ou roteiro de
revisores.
