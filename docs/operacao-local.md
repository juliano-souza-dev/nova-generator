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
# Jornada de mídia e revisão

Na tela **Mídia**, selecione o projeto e use **Iniciar processamento**. Uma fonte já verificada no
cache global avança diretamente para o corte; caso contrário, o worker tenta as alternativas do
yt-dlp e valida o resultado com FFprobe. Depois de confirmar o intervalo, o mesmo job cria o MP4
do projeto, a waveform e a transcrição do corte. **Revisar legenda** abre o candidato correto sem
copiar IDs.

Se uma etapa falhar, o snapshot mostra `failed`. Repita a ação da etapa: cache e artefatos válidos
são reutilizados. Um candidato é recusado quando o hash da fonte atual não corresponde ao hash do
corte, evitando revisar uma transcrição obsoleta.
