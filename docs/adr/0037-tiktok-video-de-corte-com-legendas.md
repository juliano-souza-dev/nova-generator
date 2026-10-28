# ADR 0037 — TikTok Mídia com vídeo original e legendas sincronizadas

## Contexto

O estúdio inicial (`nova-tiktok-media/1`) exporta slides e carrosséis, mas o fluxo
**YouTube → recorte → transcrição → revisão EN/PT → legendas → vídeo vertical**
estava separado entre as áreas Mídia, Editorial e TikTok Mídia. Para publicações
de lyrics, o usuário precisa ver o próprio vídeo ao fundo e conservar a posição
temporal exata de cada fala. Reconstruir a transcrição ou traduzir automaticamente
no render criaria divergência com a revisão humana.

## Decisão

1. **A fonte é um corte já preparado no Generator.** O estúdio TikTok não recebe
   caminho absoluto, não executa download arbitrário e não altera a fonte. A
   interface encaminha à área Mídia quando o download, recorte ou ASR ainda não
   existe; a revisão EN/PT ocorre na bancada Editorial e é importada por IDs.
2. **O contrato de projeto `nova-tiktok-media/1` é ampliado por campos opcionais.**
   O projeto armazena identificação do projeto/cena de origem, cópias explícitas
   das legendas (IDs de cues, EN/PT, milissegundos relativos ao corte, ativação e
   destaque) e estilo visual. Projetos antigos continuam válidos e mantêm o
   comportamento dos carrosséis e vídeos de slides.
3. **Edição não aprova legenda editorial.** A cópia no TikTok pode ser ajustada
   manualmente para o vídeo; o texto aprovado no Generator não é regravado.
   Nunca copiar palavras do ASR que estejam pendentes de aprovação como finais.
4. **Vídeo real é uma modalidade separada de render.** O modo de slides mantém a
   exportação original; o modo vídeo compõe a fonte com corte central 9:16,
   legendas bilíngues sobrepostas em janelas temporais reais e áudio original
   como opção explícita. Os estilos têm variantes visuais e animações discretas.
5. **O job é congelado antes de executar.** Ele registra revisão, SHA-256 da
   fonte, texto e tempos de cada legenda e opções de render. O worker valida os
   hashes antes de processar, usa FFmpeg com argumentos estruturados e escreve
   resultados isolados por render. Falhas preservam a revisão e o MP4 anterior.

## Garantias de texto e tempo

- Tempos sempre relativos ao início do MP4 recortado, nunca ao vídeo completo.
- Cada linha só aparece entre seu início e fim; gaps permanecem sem legenda.
- Pontuação, Unicode, acentos e contrações são mantidos literalmente do material
  escolhido pelo usuário. O render não retraduz nem normaliza falas aprovadas.
- O modo de vídeo não exige áudio de narração; manter o áudio original é o padrão
  natural para uma cena ou música. Upload de áudio e vozes permanecem disponíveis
  no modo de slides, sem alterar o comportamento existente.
- O vídeo final é 1080×1920, com informações de origem, duração e hashes no
  manifesto do render, mas nunca divulga texto integral nos logs operacionais.

## Compatibilidade e rollback

- Nenhuma mudança em `hub_final.json`, contratos iHub, áudio Anki ou migração SQL.
- Campos novos são opcionais e usam defaults: arquivos de projetos anteriores
  são aceitos sem migração. Um rollback de serviço mantém os JSONs antigos;
  projetos que tiverem campos novos devem ser abertos na versão que os suporta.
- Para recuperar falha de render, usar **Jobs**, revisar legendas/corte e executar
  nova exportação. Nenhuma exportação apaga outra.
- Somente arquivos com autorização de uso devem ser publicados; o Generator não
  automatiza a publicação no TikTok nem presume direitos sobre músicas/vídeos.

## Critérios de aceite

1. Um projeto anterior abre, edita e exporta o carrossel sem regressão.
2. O vídeo original proveniente de um corte validado aparece na prévia e pode
   ser exportado em formato vertical.
3. Duas cues separadas por silêncio exibem um intervalo sem texto, tanto na
   prévia quanto no MP4.
4. EN/PT incluindo Unicode e pontuação permanecem iguais ao material escolhido.
5. O render mantém o áudio original quando solicitado e rejeita cortes ausentes,
   tempos inválidos, revisão obsoleta e arquivos alterados.
6. Um erro de FFmpeg não corrompe o projeto nem qualquer render anterior.
7. Testes de domínio, API, renderização, frontend e verificação em dispositivo
   real devem ocorrer antes de afirmar que o fluxo está pronto para produção.
