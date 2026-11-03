# ADR 0042 — Importação de pacotes ZIP completos no TikTok Mídia

## Contexto

Microaulas podem ser produzidas fora do Generator com roteiro, imagens e narração separados.
Importar cada quadro e seu recurso manualmente gera erros de ordem e consome tempo editorial.

## Decisão

- Aceitar um ZIP versionado `nova-tiktok-package/1` pela ferramenta **Importar → Pacote ZIP da microaula**.
- O `manifest.json` contém título, formato, tema, duração total, `slides[]` com ordem explícita (1..N), duração, EN/PT, destaque, movimento e caminho exato da imagem, além de um áudio opcional.
- A ordem dos arquivos no ZIP nunca determina a ordem dos quadros; somente `slides[].order`.
- O serviço valida todo o ZIP antes de criar uma produção nova: contrato, 1–30 quadros, durações 1–20 s, caminhos declarados e seguros, ausência de arquivos inesperados, tamanho por arquivo e total, PNG íntegro 1080×1920 e narração validada por FFprobe. Hashes SHA-256 opcionais, quando declarados, devem conferir.
- A importação registra imagens com nomes internos únicos e coloca áudio enviado na trilha da produção; nenhum caminho do ZIP é utilizado diretamente como caminho no servidor.
- O projeto novo nasce editável e sem publicação ou exportação automática. A responsabilidade do operador é rever textos, imagens, tempo e áudio.
- Escrita ocorre em pasta temporária de uma produção inédita, seguida por troca atômica. Falha descarta apenas essa pasta e nunca altera produção preexistente.
- O contrato `nova-tiktok-media/1` e o Generator–iHub permanecem inalterados.

## Limites e recuperação

- ZIP até 90 MiB, conteúdo descompactado até 120 MiB, até 32 membros, imagem até 8 MiB, áudio até 50 MiB.
- Somente PNG de 1080×1920 no pacote; fontes JPG/WebP devem ser normalizadas antes da montagem do ZIP.
- Áudio MP3/WAV/OGG é opcional; se ausente, a produção pode receber voz/áudio no editor depois.
- O manifesto não executa instruções, não incorpora URLs externas e não substitui projetos existentes.
- Se a importação falhar, o erro identifica o membro/campo inválido. Corrigir o ZIP e reenviar; nenhuma produção parcial é apresentada.

## Verificação

`tests/test_tiktok_package_import.py`: ordenação mesmo com entradas fora de ordem, integridade das imagens, unicode, isolamento de projetos e rejeição de pacote incompleto ou adulterado.

## Agentes portáteis atualizados

`agentes/03-midia-e-tts-local.md` e `agentes/05-integracao-e-release.md` registram validação e compatibilidade do pacote. O mapa de uso mantém o TikTok Mídia sob 03 com revisão de 01, 02 e 05.
