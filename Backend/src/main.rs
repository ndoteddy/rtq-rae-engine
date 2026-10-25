//! Thin bootstrap: config, logging, workers, server.

use queue_engine::{api, config::Config, state::Shared, worker};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=debug".into()))
        .init();

    let config = Config::from_env();
    if config.api_keys.is_empty() {
        tracing::warn!("API_KEYS not set: write endpoints are OPEN (development mode)");
    }

    let state = Shared::new(config.api_keys.clone());
    worker::spawn_workers(&state, config.workers);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr).await.expect("bind address");
    tracing::info!("listening on http://{} (Swagger UI at /swagger-ui)", config.bind_addr);
    axum::serve(listener, api::router(state)).await.expect("server error");
}
