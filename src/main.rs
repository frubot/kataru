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
    extract::{DefaultBodyLimit, Request, State},
    http::{Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use reqwest::Client;
use serde_json::json;
use tokio::net::TcpListener;
use tower_http::{
    compression::{
        CompressionLayer,
        predicate::{DefaultPredicate, NotForContentType, Predicate},
    },
    trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer},
};
use tracing::Level;
use tracing_subscriber::EnvFilter;

use crate::{
    config::Config,
    db::{Database, handle_storage_command},
    error::{AppError, AppResult},
};

// JSONバックアップにはdata URL画像が含まれるため、画面側の256MiB上限に余裕を持たせる。
const STORAGE_REQUEST_BODY_LIMIT: usize = 512 * 1024 * 1024;
// 長い会話履歴を許容しつつ、画像data URLの誤送信などによる過剰なメモリ消費は制限する。
const CONVERSATION_REQUEST_BODY_LIMIT: usize = 64 * 1024 * 1024;

fn response_compression_predicate() -> impl Predicate {
    // Kataruはloopback専用のため、巨大な画像data URLを含むJSONは圧縮コストの方が高い。
    // JS/CSSなどの静的アセットは従来どおり圧縮する。
    DefaultPredicate::new().and(NotForContentType::const_new("application/json"))
}

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

    let api = api_router();

    let app = Router::new()
        .nest("/api", api)
        .fallback(static_assets::serve)
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(security, security_guard))
        .layer(CompressionLayer::new().compress_when(response_compression_predicate()))
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

fn api_router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route(
            "/storage",
            post(handle_storage_command).layer(DefaultBodyLimit::max(STORAGE_REQUEST_BODY_LIMIT)),
        )
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
        .route(
            "/conversation/turn",
            post(conversation::turn).layer(DefaultBodyLimit::max(CONVERSATION_REQUEST_BODY_LIMIT)),
        )
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use axum::http::{StatusCode, header};
    use serde_json::json;

    use super::*;

    #[test]
    fn compression_skips_json_but_keeps_static_assets() {
        let json_response = Response::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(vec![0_u8; 64]))
            .expect("build JSON response");
        assert!(!response_compression_predicate().should_compress(&json_response));

        let javascript_response = Response::builder()
            .header(header::CONTENT_TYPE, "application/javascript")
            .body(Body::from(vec![0_u8; 64]))
            .expect("build JavaScript response");
        assert!(response_compression_predicate().should_compress(&javascript_response));
    }

    #[tokio::test]
    async fn storage_route_accepts_body_above_axum_default_limit() {
        let state = AppState {
            database: Database::open(Path::new(":memory:")).expect("open in-memory database"),
            http_client: Client::new(),
            application_origin: "http://127.0.0.1".to_owned(),
        };
        let app = api_router().with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("read test server address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let response = Client::new()
            .post(format!("http://{address}/storage"))
            .json(&json!({
                "op": "bulk_write",
                "characters": [],
                "situations": [],
                "rooms": [],
                "messages": [],
                "memories": [],
                "usage_records": [],
                "padding": "x".repeat(3 * 1024 * 1024),
            }))
            .send()
            .await
            .expect("send oversized storage request");

        server.abort();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn conversation_route_accepts_body_above_axum_default_limit() {
        let state = AppState {
            database: Database::open(Path::new(":memory:")).expect("open in-memory database"),
            http_client: Client::new(),
            application_origin: "http://127.0.0.1".to_owned(),
        };
        let app = api_router().with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("read test server address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let response = Client::new()
            .post(format!("http://{address}/conversation/turn"))
            .json(&json!({
                "padding": "x".repeat(3 * 1024 * 1024),
            }))
            .send()
            .await
            .expect("send oversized conversation request");

        server.abort();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
