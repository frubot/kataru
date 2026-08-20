use std::{
    env,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use axum::{
    extract::{MatchedPath, Request},
    http::{HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};
use tracing::Span;
use tracing_subscriber::EnvFilter;

const NORMAL_FILTER: &str = "kataru=info,tower_http=warn";
const VERBOSE_FILTER: &str = "kataru=debug,tower_http=debug";
const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-kataru-request-id");
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
struct RequestId(Arc<str>);

pub fn verbose_requested() -> bool {
    env::args_os().any(|arg| arg == "--verbose")
}

pub fn init(verbose: bool) {
    let filter = filter_from_rust_log(env::var("RUST_LOG").ok().as_deref(), verbose);
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_thread_ids(verbose)
        .init();
}

fn filter_from_rust_log(rust_log: Option<&str>, verbose: bool) -> EnvFilter {
    if let Some(rust_log) = rust_log {
        match EnvFilter::try_new(rust_log) {
            Ok(filter) => return filter,
            Err(_) => {
                eprintln!("warning: RUST_LOGが不正なため、Kataruの既定ログ設定を使用します。")
            }
        }
    }
    EnvFilter::new(if verbose {
        VERBOSE_FILTER
    } else {
        NORMAL_FILTER
    })
}

fn next_request_id() -> Arc<str> {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    Arc::from(format!("{:x}-{sequence:x}", std::process::id()))
}

pub async fn assign_request_id(mut request: Request, next: Next) -> Response {
    let request_id = RequestId(next_request_id());
    request.extensions_mut().insert(request_id.clone());
    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(&request_id.0) {
        response.headers_mut().insert(REQUEST_ID_HEADER, value);
    }
    response
}

pub fn make_http_span<B>(request: &axum::http::Request<B>) -> Span {
    let request_id = request
        .extensions()
        .get::<RequestId>()
        .map(|value| value.0.as_ref())
        .unwrap_or("missing");
    let route = route_name(request);
    tracing::debug_span!(
        "http_request",
        request_id,
        method = %request.method(),
        route,
    )
}

fn route_name<B>(request: &axum::http::Request<B>) -> &str {
    request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .unwrap_or("<unmatched>")
}

pub fn on_http_response<B>(response: &axum::http::Response<B>, latency: Duration, span: &Span) {
    tracing::debug!(
        parent: span,
        status = response.status().as_u16(),
        latency_ms = latency.as_millis(),
        "HTTP request completed"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, routing::get};
    use tokio::net::TcpListener;

    #[test]
    fn explicit_rust_log_overrides_verbose_default() {
        let filter = filter_from_rust_log(Some("kataru=trace"), false);
        assert_eq!(filter.to_string(), "kataru=trace");
    }

    #[test]
    fn verbose_default_enables_debug_diagnostics() {
        let normal = filter_from_rust_log(None, false).to_string();
        let verbose = filter_from_rust_log(None, true).to_string();
        assert!(normal.contains("kataru=info"));
        assert!(verbose.contains("kataru=debug"));
        assert_ne!(normal, verbose);
    }

    #[test]
    fn request_ids_are_unique_and_header_safe() {
        let first = next_request_id();
        let second = next_request_id();
        assert_ne!(first, second);
        assert!(HeaderValue::from_str(&first).is_ok());
        assert!(
            first
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        );
    }

    #[test]
    fn http_span_does_not_use_an_unmatched_path_or_query() {
        let mut request = axum::http::Request::builder()
            .uri("/api/health?token=must-not-be-logged")
            .body(Body::empty())
            .expect("build request");
        request
            .extensions_mut()
            .insert(RequestId(Arc::from("test-1")));

        let span = make_http_span(&request);

        assert_eq!(route_name(&request), "<unmatched>");
        assert!(!route_name(&request).contains("token"));
        assert_eq!(
            span.metadata().expect("span metadata").name(),
            "http_request"
        );
    }

    #[tokio::test]
    async fn middleware_returns_the_same_safe_request_id_to_the_caller() {
        let app = Router::new()
            .route("/health", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(assign_request_id));
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("read test address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let response = reqwest::get(format!("http://{address}/health"))
            .await
            .expect("request health endpoint");
        server.abort();
        let request_id = response
            .headers()
            .get(REQUEST_ID_HEADER)
            .expect("request ID header")
            .to_str()
            .expect("ASCII request ID");

        assert!(
            request_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        );
    }
}
