# Pacote ZIP completo — TikTok Mídia

Este pacote é **uma produção a revisar**, não uma publicação automática.

## Estrutura

```text
microaula-watch.zip
├── manifest.json
├── images/
│   ├── 01.png
│   ├── 02.png
│   └── ...
└── audio/
    └── narration.mp3
```

O áudio é opcional. Cada imagem é um PNG válido de **1080×1920**, com no máximo 8 MiB. O caminho é exato, inclusive maiúsculas/minúsculas. Arquivos extras não declarados são rejeitados. A ordem é definida pelo campo `order`, **não** pelo nome nem posição no ZIP.

## Manifesto mínimo

```json
{
  "contract": "nova-tiktok-package/1",
  "title": "WATCH — uma palavra, vários significados",
  "format": "lesson_video",
  "theme": "ihub",
  "animated_scenes": true,
  "duration_ms": 14000,
  "audio": "audio/narration.mp3",
  "slides": [
    {
      "order": 2,
      "kind": "example",
      "heading": "CUIDADO!",
      "en": "Watch out!",
      "pt": "Cuidado!",
      "note": "Aviso de perigo",
      "highlight": "Watch out",
      "duration_ms": 8000,
      "motion": "pan_left",
      "image": "images/02.png"
    },
    {
      "order": 1,
      "kind": "cover",
      "heading": "WATCH: SÓ ASSISTIR?",
      "en": "WATCH",
      "pt": "Uma palavra, vários significados.",
      "duration_ms": 6000,
      "motion": "zoom_in",
      "image": "images/01.png"
    }
  ]
}
```

Apesar de os quadros aparecerem fora de ordem no JSON acima, o Generator os organiza por `order`: abertura (1), exemplo (2). Para 7 quadros, use ordens 1–7 e `duration_ms` somando 55000.

`audio`, `image`, `audio_sha256` e `slides[].sha256` são opcionais. Quando hashes estiverem presentes, devem ser SHA-256 hexadecimais dos bytes exatos correspondentes.

## Como importar

1. Abra **TikTok Mídia → Importar** (mesmo sem um projeto selecionado).
2. Escolha o arquivo no campo **Pacote ZIP da microaula**.
3. Aguarde a validação. O Generator cria e abre uma **nova produção**.
4. Confira a ordem, prévia, imagens, traduções e tempos de cada quadro.
5. Se o ZIP incluiu áudio, confira-o em **Exportar → Áudio e exportação**.
6. Ajuste o que for necessário e, somente quando satisfeito, clique em **Gerar vídeo MP4**.

## Compatibilidade

Este é um formato de **entrada**, independente do JSON editorial e do contrato iHub. Projetos anteriores continuam funcionando. Ao falhar a importação, o ZIP pode ser corrigido e reenviado sem necessidade de apagar produção alguma.
