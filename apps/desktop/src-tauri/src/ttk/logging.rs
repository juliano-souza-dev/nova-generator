use std::path::Path;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub fn initialize(log_directory: &Path) -> Result<WorkerGuard, String> {
    std::fs::create_dir_all(log_directory)
        .map_err(|error| format!("Não foi possível criar a pasta de logs: {error}"))?;

    let file_appender = tracing_appender::rolling::daily(log_directory, "tiktok-media-creator.log");
    let (writer, guard) = tracing_appender::non_blocking(file_appender);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(writer).with_ansi(false))
        .try_init()
        .map_err(|error| format!("Não foi possível iniciar o sistema de logs: {error}"))?;

    tracing::info!(log_directory = %log_directory.display(), "Logging initialized");
    Ok(guard)
}
