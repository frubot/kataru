mod ai;
mod config;
mod conversation;
mod db;
mod error;
mod static_assets;

use std::sync::Arc;

use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use reqwest::Client;
use serde_json::json;
use tokio::net::TcpListener;
use tower_http::{
    compression::CompressionLayer,
    trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer},
};
use tracing::Level;
use tracing_subscriber::EnvFilter;

use crate::{
    config::Config,
    db::{Database, handle_storage_command},
    error::{AppError, AppResult},
};

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    pub http_client: Client,
    pub application_origin: String,
}

#[derive(Clone)]
struct SecurityState {
    authority: Arc<str>,
    allowed_origins: Arc<[String]>,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Kataruを起動できませんでした: {error}");
        std::process::exit(1);
    }
}

async fn run() -> AppResult<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("kataru=info,tower_http=info")),
        )
        .init();

    let config = Config::from_args()?;
    let database = Database::open(&config.database_path)?;
    let http_client = Client::builder()
        .user_agent(format!("Kataru/{}", env!("CARGO_PKG_VERSION")))
        .build()?;
    let state = AppState {
        database,
        http_client,
        application_origin: config.origin(),
    };

    let mut allowed_origins = vec![config.origin()];
    if let Some(origin) = &config.development_origin {
        allowed_origins.push(origin.clone());
    }
    let security = SecurityState {
        authority: Arc::from(config.socket_addr().to_string()),
        allowed_origins: Arc::from(allowed_origins),
    };

    let api = Router::new()
        .route("/health", get(health))
        .route("/storage", post(handle_storage_command))
        .route("/chat", post(ai::chat))
        .route("/summarize", post(ai::summarize))
        .route("/embeddings", post(ai::embeddings))
        .route("/generate-image", post(ai::generate_image))
        .route("/generate-character", post(ai::generate_character))
        .route(
            "/generate-situation-description",
            post(ai::generate_situation_description),
        )
        .route("/generate-title", post(ai::generate_title))
        .route("/extract-memories", post(ai::extract_memories))
        .route("/conversation/turn", post(conversation::turn));

    let app = Router::new()
        .nest("/api", api)
        .fallback(static_assets::serve)
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(security, security_guard))
        .layer(CompressionLayer::new())
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().include_headers(false))
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        );

    let listener = TcpListener::bind(config.socket_addr()).await?;
    let url = config.origin();
    tracing::info!(
        url = %url,
        database = %state.database.path().display(),
        "Kataru started"
    );
    println!("Kataru: {url}");
    if config.open_browser {
        webbrowser::open(&url)
            .map_err(|error| AppError::Internal(format!("ブラウザを開けませんでした: {error}")))?;
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "database": state.database.path().file_name().and_then(|name| name.to_str())
    }))
}

async fn security_guard(
    State(security): State<SecurityState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let host_matches = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case(&security.authority));
    if !host_matches {
        return (
            StatusCode::MISDIRECTED_REQUEST,
            Json(json!({ "error": "不正なHostヘッダーです。" })),
        )
            .into_response();
    }

    let unsafe_method = !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    if unsafe_method
        && let Some(origin) = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        && !security
            .allowed_origins
            .iter()
            .any(|allowed| origin == allowed)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "不正なOriginヘッダーです。" })),
        )
            .into_response();
    }
    next.run(request).await
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "failed to install Ctrl+C handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => tracing::error!(%error, "failed to install terminate handler"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
