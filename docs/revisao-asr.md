# Revisão de um candidato ASR

1. Crie um projeto com fonte autorizada e conclua o job de ingestão da cena na área de mídia.
2. Abra **Revisão editorial** pelo link da mídia ou selecione o projeto e informe o ID do
   job de ingestão concluído. Clique em **Criar rascunho do ASR**.
3. Ouça o corte da cena e confira a waveform real na timeline. Compare `ASR original` com o
   áudio e preencha os campos EN/PT literalmente. Clique em
   **Aprovar texto** para cada cue. Aspas, acentos, reticências, espaços e pontuação são
   preservados como digitados; nenhum ajuste de timing altera esses campos.
4. Se necessário, ajuste limites do cue na timeline e salve o timing; selecione palavras para
   ajustar seus intervalos. Erros de sobreposição ou palavras fora do cue são rejeitados.
5. Recarregue a página e confira o texto aprovado. Repetir a importação do mesmo job é seguro:
   ela retorna a cena existente sem descartar revisões. Rascunhos sem EN/PT não entram em
   cards ou exportações.

Para recuperar uma aprovação incorreta, use o histórico de revisões editorial e o comando
`POST /api/editorial/scenes/{scene_id}/undo` com o ID da revisão. A entrada original do ASR
permanece no job para inspeção e nova comparação. A fixture
`tests/fixtures/asr_candidate_job_output.json` cobre aspas, contração, acento e reticências.
