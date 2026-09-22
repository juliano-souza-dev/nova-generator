# Operação local

Copie `.env.example` para `.env`, instale `python -m pip install ".[dev]"` e inicie com
`python -m uvicorn nova_generator.main:app`. As URLs e paths relativos usam o diretório de
execução. Instale FFmpeg/FFprobe e yt-dlp no `PATH`, ou configure os nomes dos executáveis.
Ative `NOVA_GENERATOR_CLOUDFLARED_ENABLED=true` somente quando o túnel for usado.
O startup valida os executáveis e a criação dos diretórios de cache/projetos; a mensagem de
erro informa o setting a corrigir. Modelos Whisper e Chatterbox são carregados somente nas
operações que os usam.

## Diagnóstico

Logs são linhas JSON em stdout. `X-Request-ID` aparece na resposta e nos eventos HTTP.
Procure `job_id` para acompanhar `job_started`, `job_succeeded` e `job_failed`.
Eventos `metric_recorded` contam duração/falha dos jobs, hits de cache e exportações Anki.
Os contadores são locais ao processo e reiniciam com ele. Os logs não incluem corpo HTTP,
texto editorial, URL privada, token nem mensagem de exceção; use o tipo da falha e a ID do job
para localizar o registro persistido quando for necessário investigar.

## Backup e recuperação

Pare API e worker antes de copiar o banco SQLite, `media_cache/` e `data/projects/`.
Confirme espaço livre e copie os três para um diretório de backup com data. Para restaurar,
pare os processos, guarde uma cópia do estado atual, reponha banco e diretórios do mesmo
backup e inicie novamente. Rode `python -m alembic upgrade head` após restaurar uma versão
anterior do banco. Jobs abandonados voltam a `retryable` quando o worker reinicia; inspecione
o job antes de solicitar retry manual para evitar repetir uma publicação externa.
