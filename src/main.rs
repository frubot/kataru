mod ai;
mod ai_config;
mod config;
mod conversation;
mod db;
mod doctor;
mod error;
mod logging;
mod static_assets;
mod update;

use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderValue, Method, StatusCode, header, uri::Authority},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use reqwest::Client;
use serde_json::json;
use tokio::{net::TcpListener, sync::Notify};
use tower_http::{
    compression::{
        CompressionLayer,
        predicate::{DefaultPredicate, NotForContentType, Predicate},
    },
    trace::TraceLayer,
};

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
    // 巨大な画像data URLを含むJSONは、圧縮コストの方が高い。
    // JS/CSSなどの静的アセットは従来どおり圧縮する。
    DefaultPredicate::new().and(NotForContentType::const_new("application/json"))
}

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    pub http_client: Client,
    pub model_catalog_cache: ai::ModelCatalogCache,
    pub application_origin: String,
    pub configuration_origins: Arc<[String]>,
    pub ai_config: ai_config::AiConfigManager,
    pub conversation_jobs: conversation::jobs::ConversationJobs,
    update_shutdown: Arc<Notify>,
    pending_update_marker: Arc<Mutex<Option<PathBuf>>>,
}

#[derive(Clone)]
struct SecurityState {
    authority: Option<Arc<str>>,
    port: u16,
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
    let verbose = logging::verbose_requested();
    logging::init(verbose);

    if update::run_special_command_if_requested().await? {
        return Ok(());
    }
    if ai_config::run_cli_command_if_requested()? {
        return Ok(());
    }
    if ai::run_models_cli_command_if_requested().await? {
        return Ok(());
    }
    if let Some(exit_code) = doctor::run_cli_command_if_requested().await? {
        if exit_code != 0 {
            std::process::exit(exit_code);
        }
        return Ok(());
    }

    let config = Config::from_args()?;
    let database = Database::open(&config.database_path)?;
    let ai_config = ai_config::AiConfigManager::open(&config.data_dir)?;
    let model_catalog_cache = ai::ModelCatalogCache::open(&config.data_dir)?;
    let http_client = Client::builder()
        .user_agent(format!("Kataru/{}", env!("CARGO_PKG_VERSION")))
        .build()?;
    let mut allowed_origins = vec![config.origin()];
    if let Some(origin) = &config.development_origin {
        allowed_origins.push(origin.clone());
    }
    let allowed_origins: Arc<[String]> = Arc::from(allowed_origins);
    let update_shutdown = Arc::new(Notify::new());
    let state = AppState {
        database,
        http_client,
        model_catalog_cache,
        application_origin: config.origin(),
        configuration_origins: allowed_origins.clone(),
        ai_config,
        conversation_jobs: conversation::jobs::ConversationJobs::default(),
        update_shutdown: update_shutdown.clone(),
        pending_update_marker: Arc::new(Mutex::new(None)),
    };

    let security = SecurityState {
        authority: (!config.is_wildcard_host()).then(|| Arc::from(config.authority())),
        port: config.port,
        allowed_origins,
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
                .make_span_with(logging::make_http_span)
                .on_response(logging::on_http_response),
        )
        .layer(middleware::from_fn(logging::assign_request_id));

    let listener = TcpListener::bind(config.bind_address()).await?;
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

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(update_shutdown))
    .await?;
    if let Some(marker) = state
        .pending_update_marker
        .lock()
        .map_err(|_| AppError::Internal("更新状態のロックに失敗しました。".to_owned()))?
        .take()
    {
        update::mark_update_ready(&marker)?;
    }
    Ok(())
}

fn api_router() -> Router<AppState> {
    let uncached_api = Router::new()
        .route("/health", get(health))
        .route("/update-status", get(update_status))
        .route("/update", post(install_update))
        .route(
            "/storage",
            post(handle_storage_command).layer(DefaultBodyLimit::max(STORAGE_REQUEST_BODY_LIMIT)),
        )
        .route("/chat", post(ai::chat))
        .route("/ai/status", post(ai::connection_status))
        .route("/ai/models", post(ai::models))
        .route("/ai/providers", post(ai::providers))
        .route("/ai/config", get(ai_config::get_config))
        .route(
            "/ai/config/openrouter",
            axum::routing::put(ai_config::update_openrouter).delete(ai_config::delete_openrouter),
        )
        .route(
            "/ai/config/openai",
            axum::routing::put(ai_config::update_openai),
        )
        .route(
            "/ai/config/openai/api-key",
            axum::routing::delete(ai_config::delete_openai_api_key),
        )
        .route(
            "/ai/config/anthropic",
            axum::routing::put(ai_config::update_anthropic),
        )
        .route(
            "/ai/config/anthropic/api-key",
            axum::routing::delete(ai_config::delete_anthropic_api_key),
        )
        .route("/summarize", post(ai::summarize))
        .route("/embeddings", post(ai::embeddings))
        .route("/generate-image", post(ai::generate_image))
        .route("/generate-character", post(ai::generate_character))
        .route(
            "/generate-situation-description",
            post(ai::generate_situation_description),
        )
        .route("/generate-title", post(ai::generate_title))
        .route(
            "/generate-reply-suggestions",
            post(ai::generate_reply_suggestions),
        )
        .route("/extract-memories", post(ai::extract_memories))
        .route(
            "/conversation/turn",
            post(conversation::turn).layer(DefaultBodyLimit::max(CONVERSATION_REQUEST_BODY_LIMIT)),
        )
        .route(
            "/conversation/jobs",
            get(conversation::jobs::list)
                .post(conversation::jobs::start)
                .layer(DefaultBodyLimit::max(CONVERSATION_REQUEST_BODY_LIMIT)),
        )
        .route(
            "/conversation/jobs/{job_id}",
            get(conversation::jobs::get).delete(conversation::jobs::cancel),
        )
        .layer(middleware::from_fn(disable_api_caching));

    Router::new()
        .route("/assets/{asset_id}", get(image_asset))
        .merge(uncached_api)
}

async fn disable_api_caching(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn image_asset(
    Path(asset_id): Path<String>,
    State(state): State<AppState>,
) -> AppResult<Response> {
    if asset_id.len() != 64 || !asset_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::NotFound("保存画像が見つかりません。".to_owned()));
    }
    let asset = state
        .database
        .get_image_asset(asset_id.clone())
        .await?
        .ok_or_else(|| AppError::NotFound("保存画像が見つかりません。".to_owned()))?;
    let content_type = HeaderValue::from_str(&asset.mime_type)
        .map_err(|_| AppError::Internal("保存画像のMIME typeが不正です。".to_owned()))?;
    let etag = HeaderValue::from_str(&format!("\"{asset_id}\""))
        .map_err(|_| AppError::Internal("保存画像のETagを生成できません。".to_owned()))?;
    let mut response = Response::new(Body::from(asset.data));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    response.headers_mut().insert(header::ETAG, etag);
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "database": state.database.path().file_name().and_then(|name| name.to_str())
    }))
}

async fn update_status(State(state): State<AppState>) -> AppResult<Json<update::UpdateStatus>> {
    Ok(Json(update::check_for_update(&state.http_client).await?))
}

async fn install_update(State(state): State<AppState>) -> AppResult<Json<update::UpdateResult>> {
    let prepared = update::install_latest(
        &state.http_client,
        Some(update::server_restart_args()),
        true,
    )
    .await?;
    if let Some(marker) = prepared.ready_marker {
        *state
            .pending_update_marker
            .lock()
            .map_err(|_| AppError::Internal("更新状態のロックに失敗しました。".to_owned()))? =
            Some(marker);
        state.update_shutdown.notify_one();
    }
    Ok(Json(prepared.result))
}

fn host_matches(security: &SecurityState, value: &str) -> bool {
    security.authority.as_ref().map_or_else(
        || {
            value
                .parse::<Authority>()
                .is_ok_and(|authority| authority.port_u16() == Some(security.port))
        },
        |expected| value.eq_ignore_ascii_case(expected),
    )
}

fn origin_matches(security: &SecurityState, request_authority: &str, origin: &str) -> bool {
    security
        .allowed_origins
        .iter()
        .any(|allowed| origin.eq_ignore_ascii_case(allowed))
        || (security.authority.is_none()
            && origin.eq_ignore_ascii_case(&format!("http://{request_authority}")))
}

async fn security_guard(
    State(security): State<SecurityState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let request_authority = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if !request_authority.is_some_and(|value| host_matches(&security, value)) {
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
        && !request_authority.is_some_and(|authority| origin_matches(&security, authority, origin))
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "不正なOriginヘッダーです。" })),
        )
            .into_response();
    }
    next.run(request).await
}

async fn shutdown_signal(update_shutdown: Arc<Notify>) {
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
        () = update_shutdown.notified() => {}
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use axum::http::{StatusCode, header};
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::*;

    fn security_state(authority: Option<&str>, port: u16) -> SecurityState {
        SecurityState {
            authority: authority.map(Arc::from),
            port,
            allowed_origins: Arc::from(Vec::<String>::new()),
        }
    }

    #[test]
    fn wildcard_host_accepts_any_authority_on_the_listening_port() {
        let security = security_state(None, 37371);

        assert!(host_matches(&security, "localhost:37371"));
        assert!(host_matches(&security, "192.168.1.20:37371"));
        assert!(host_matches(&security, "[::1]:37371"));
        assert!(!host_matches(&security, "localhost:3000"));
        assert!(!host_matches(&security, "invalid host:37371"));
    }

    #[test]
    fn wildcard_host_accepts_only_the_request_origin() {
        let security = security_state(None, 37371);

        assert!(origin_matches(
            &security,
            "192.168.1.20:37371",
            "http://192.168.1.20:37371"
        ));
        assert!(!origin_matches(
            &security,
            "192.168.1.20:37371",
            "http://example.com:37371"
        ));
    }

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
    async fn image_assets_keep_immutable_cache_header() {
        let state = AppState {
            database: Database::open(Path::new(":memory:")).expect("open in-memory database"),
            http_client: Client::new(),
            model_catalog_cache: ai::ModelCatalogCache::in_memory(),
            application_origin: "http://127.0.0.1".to_owned(),
            configuration_origins: Arc::from(["http://127.0.0.1".to_owned()]),
            ai_config: ai_config::AiConfigManager::in_memory(),
            conversation_jobs: conversation::jobs::ConversationJobs::default(),
            update_shutdown: Arc::new(Notify::new()),
            pending_update_marker: Arc::new(Mutex::new(None)),
        };
        let app = api_router().with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("read test server address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let image_data = b"cacheable-image";
        let asset_id = Sha256::digest(image_data)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let client = Client::new();
        let storage_response = client
            .post(format!("http://{address}/storage"))
            .json(&json!({
                "op": "bulk_write",
                "characters": [{
                    "id": "character-1",
                    "updatedAt": 1,
                    "icon": format!("data:image/png;base64,{}", BASE64.encode(image_data)),
                }],
            }))
            .send()
            .await
            .expect("store image asset");
        assert_eq!(storage_response.status(), StatusCode::OK);

        let response = client
            .get(format!("http://{address}/assets/{asset_id}"))
            .send()
            .await
            .expect("fetch image asset");

        server.abort();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL),
            Some(&HeaderValue::from_static(
                "private, max-age=31536000, immutable"
            ))
        );
    }

    #[tokio::test]
    async fn storage_route_accepts_body_above_axum_default_limit() {
        let state = AppState {
            database: Database::open(Path::new(":memory:")).expect("open in-memory database"),
            http_client: Client::new(),
            model_catalog_cache: ai::ModelCatalogCache::in_memory(),
            application_origin: "http://127.0.0.1".to_owned(),
            configuration_origins: Arc::from(["http://127.0.0.1".to_owned()]),
            ai_config: ai_config::AiConfigManager::in_memory(),
            conversation_jobs: conversation::jobs::ConversationJobs::default(),
            update_shutdown: Arc::new(Notify::new()),
            pending_update_marker: Arc::new(Mutex::new(None)),
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
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL),
            Some(&HeaderValue::from_static("no-store"))
        );
    }

    #[tokio::test]
    async fn conversation_route_accepts_body_above_axum_default_limit() {
        let state = AppState {
            database: Database::open(Path::new(":memory:")).expect("open in-memory database"),
            http_client: Client::new(),
            model_catalog_cache: ai::ModelCatalogCache::in_memory(),
            application_origin: "http://127.0.0.1".to_owned(),
            configuration_origins: Arc::from(["http://127.0.0.1".to_owned()]),
            ai_config: ai_config::AiConfigManager::in_memory(),
            conversation_jobs: conversation::jobs::ConversationJobs::default(),
            update_shutdown: Arc::new(Notify::new()),
            pending_update_marker: Arc::new(Mutex::new(None)),
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
