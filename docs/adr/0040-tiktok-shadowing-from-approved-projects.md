# ADR 0040 — TikTok Shadowing a partir de planos aprovados do Generator

## Contexto

Os projetos já possuem grupos de Shadowing selecionados por cena, com falas EN/PT
aprovadas, tempo do corte, locutor e pausa de prática. O TikTok Media deve
reaproveitá-los sem fabricar novo texto ou alterar a publicação do iHub.

## Decisão

- Adicionar `shadowing_video` ao formato opcional de `nova-tiktok-media/1` e um
  campo `shadowing_clip` com hashes do editorial, do plano e IDs dos blocos. O
  modelo antigo permanece legível e a mudança é exclusivamente aditiva.
- A área Shadowing do TikTok permite escolher projeto/cena, selecionar até 12
  blocos em ordem cronológica, sugerir uma seleção e pré-visualizar a sequência
  **fala original → pausa silenciosa para repetição**. O total validado no servidor
  deve ficar entre 35.000 e 60.000 ms, somando fala e pausa de cada bloco.
- Ao exportar, exigir o plano de Shadowing aprovado, pertencente à cena informada,
  hashes atuais e um corte verificado com áudio. Congelar uma cópia do corte, da
  seleção, do plano e da revisão no snapshot do job `tiktok.render`.
- O worker revalida a aprovação e o snapshot antes e depois da renderização.
  Cada fala usa os milissegundos e o áudio original; em seguida insere vídeo
  didático sem áudio da fonte, com uma janela de silêncio exatamente do tamanho
  previsto pelo plano. O MP4 é 9:16, H.264/AAC e possui manifesto SHA-256.
- O modo Shadowing é uma produção independente; não regrava cues, traduções,
  blocos de Shadowing, pacote Anki ou contratos Generator–iHub.

## Recuperação e compatibilidade

- Se o plano ou sua aprovação mudou, a interface solicita nova seleção e o job
  anterior falha com motivo claro; reimportar a cena e renderizar novamente.
- Se o recorte ou FFmpeg estiver indisponível, corrigir a origem e gerar outro
  render. O último MP4 concluído permanece sob seu ID e não é sobrescrito.
- Clientes antigos podem ignorar o novo formato e o campo opcional. Nenhuma
  migração, alteração de schema iHub ou download automático é necessária.

## Verificação

- `tests/test_tiktok_shadowing.py`: formato, duração, aprovação/hash e comandos
  de áudio original/pausa silenciosa no FFmpeg.
- `frontend/src/features/tiktok-media/shadowing-clip.test.ts`: sugestão,
  cronologia e duração. Gates gerais da UI/API/mídia permanecem exigidos.

## Agentes portáteis atualizados

`agentes/02-estudio-editorial-ux-qa.md`, `03-midia-e-tts-local.md` e
`05-integracao-e-release.md` registram os limites e critérios novos; o
`MAPA_DE_USO.md` mantém o mesmo roteamento de TikTok Mídia.
