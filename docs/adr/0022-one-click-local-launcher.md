# ADR 0022: Inicialização local por um único clique

## Decisão

`INICIAR.bat`, na raiz do repositório, é o ponto de entrada local para Windows. Ele chama
`scripts/start-local.ps1`, que verifica Python 3.12+, Node.js e FFmpeg/FFprobe; quando algum
pré-requisito está ausente, tenta instalá-lo pelo Winget. O inicializador cria ambientes Python
separados para a aplicação e para Chatterbox, instala dependências backend/ASR e frontend,
aplica `alembic upgrade head`, inicia API, worker e Vite e abre a interface.

Hashes de `pyproject.toml`, `package.json` e `package-lock.json` ficam em `.local-runtime/`.
Assim, execuções seguintes reutilizam as instalações e refazem somente o ambiente cujo
manifesto mudou. Artefatos transitórios permanecem fora do Git. Logs separados ficam em
`data/logs/`; a janela do inicializador supervisiona os três processos e os encerra em conjunto.

O parâmetro `-CheckOnly` prepara e valida tudo sem iniciar serviços. Ele existe para diagnóstico
e automação; o operador comum não precisa usá-lo.

## Recuperação

Uma falha deixa a janela aberta e aponta o componente e os logs. Corrija conectividade,
espaço em disco ou o pré-requisito indicado e clique novamente em `INICIAR.bat`; instalações
concluídas são reutilizadas. Se um ambiente virtual estiver corrompido, renomeie apenas `.venv`
ou `.venv-tts` para preservar uma cópia e execute o inicializador novamente.
