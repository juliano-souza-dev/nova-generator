# Nova Generator Desktop

O aplicativo desktop usa Tauri 2 com o frontend React existente e o backend Python executado em segundo plano.

## Desenvolvimento

Pré-requisitos para compilar a versão desktop:

- Node.js 22 ou superior
- Rust stable e toolchain MSVC
- Python 3.12 para gerar o pacote do backend
- WebView2 Runtime no Windows

A partir da raiz do repositório:

```powershell
npm ci --prefix frontend
Set-Location desktop`nnpm install
New-Item -ItemType Directory -Force desktop/src-tauri/resources/python | Out-Null
python -m pip wheel --no-deps . --wheel-dir desktop/src-tauri/resources/python
New-Item -ItemType Directory -Force desktop/src-tauri/resources/backend | Out-Null
Copy-Item alembic.ini desktop/src-tauri/resources/backend/alembic.ini
Copy-Item migrations desktop/src-tauri/resources/backend/migrations -Recurse
Compress-Archive -Path desktop/src-tauri/resources/backend/* -DestinationPath desktop/src-tauri/resources/backend-assets.zip -Force
npm run tauri -- dev
```

## Instalador Windows

O workflow `.github/workflows/desktop-windows.yml` compila os pacotes NSIS (`.exe`) e MSI e publica ambos como artefato do GitHub Actions.

## Preparação automática no primeiro uso

O instalador não inclui os ambientes Python nem os modelos de IA. Na primeira abertura, o aplicativo prepara esses componentes em `%LOCALAPPDATA%\NovaGenerator`:

- Python 3.12 e dependências do backend/ASR
- Ambiente isolado do Chatterbox Turbo e seus pesos
- FFmpeg/FFprobe
- SoX, usando WinGet quando ainda não estiver instalado
- Migrações do banco de dados

O worker é iniciado junto com a API. A instalação do Qwen3-TTS e os modelos associados continuam pela fila de preparação do worker, sem bloquear o uso das demais áreas do aplicativo.

Projetos, banco de dados, modelos, caches e logs ficam fora da pasta de instalação. Os logs de API e worker ficam em `%LOCALAPPDATA%\NovaGenerator\logs`.
