//! アクセストークン認証。
//!
//! 起動時に表示する `/?token=...` を開くと、トークンをHttpOnly Cookieに交換して
//! `/` へリダイレクトする。以後のリクエストはCookieで認証する。`<img>` や `Audio`
//! のようにヘッダーを付けられない読み込みも、Cookieならそのまま通る。
//! スクリプトなどからは `Authorization: Bearer <token>` でも認証できる。

use std::{
    env, fs,
    io::{ErrorKind, Write as _},
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    Json,
    body::Body,
    extract::Request,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;

use crate::{
    ai_config::parse_config_data_dir,
    config::{DEFAULT_HOST, DEFAULT_PORT, origin_for, parse_port, validate_host},
    error::{AppError, AppResult},
    hashing::sha256_hex,
};

pub const TOKEN_FILE_NAME: &str = "auth-token";
const TOKEN_BYTES: usize = 32;
const MIN_TOKEN_LENGTH: usize = 32;
const MAX_TOKEN_LENGTH: usize = 256;
// Cookieにはトークンそのものではなく派生値を入れる。トークンを再発行すると全セッションが無効になる。
const SESSION_LABEL: &str = "kataru-session-v1:";
const COOKIE_MAX_AGE_SECONDS: u32 = 365 * 24 * 60 * 60;
// 未認証でも返す静的ファイル（タブのアイコンと認証案内ページ用）。
const PUBLIC_PATHS: &[&str] = &["/favicon.ico", "/apple-touch-icon.png", "/logo.png"];

#[derive(Clone)]
pub struct Auth {
    inner: Option<Arc<AuthInner>>,
}

struct AuthInner {
    token: String,
    session_value: String,
    // Cookieはポートを区別しないため、同じホストで複数起動しても衝突しないようポートを名前に含める。
    cookie_name: String,
}

impl Auth {
    pub fn disabled() -> Self {
        Self { inner: None }
    }

    pub fn new(token: String, port: u16) -> Self {
        let session_value = session_value(&token);
        Self {
            inner: Some(Arc::new(AuthInner {
                token,
                session_value,
                cookie_name: format!("kataru_session_{port}"),
            })),
        }
    }

    pub fn token(&self) -> Option<&str> {
        self.inner.as_ref().map(|inner| inner.token.as_str())
    }

    /// 認証を通過させるなら `None`、そうでなければ返すべきレスポンスを返す。
    ///
    /// `redirect_origin` は開発UIのオリジン。指定時はトークン交換後にそちらへ戻す。
    pub fn check(
        &self,
        request: &Request<Body>,
        redirect_origin: Option<&str>,
    ) -> Option<Response> {
        let inner = self.inner.as_ref()?;
        let is_read = matches!(*request.method(), Method::GET | Method::HEAD);

        if is_read && let Some(presented) = query_token(request.uri().query()) {
            return Some(if constant_time_eq(presented, &inner.token) {
                inner.session_redirect(redirect_origin)
            } else {
                unauthorized_page("URLのトークンが正しくありません。")
            });
        }
        if inner.is_authenticated(request.headers()) {
            return None;
        }
        let path = request.uri().path();
        if is_read && PUBLIC_PATHS.contains(&path) {
            return None;
        }
        Some(if path == "/api" || path.starts_with("/api/") {
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": "認証が必要です。Kataruの起動時に表示されたURL（?token=付き）を開き直してください。"
                })),
            )
                .into_response()
        } else {
            unauthorized_page("Kataruの起動時に表示されたURL（?token=付き）を開いてください。")
        })
    }
}

impl AuthInner {
    fn is_authenticated(&self, headers: &HeaderMap) -> bool {
        let cookie = headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .any(|(name, value)| {
                name == self.cookie_name && constant_time_eq(value, &self.session_value)
            });
        cookie
            || headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
                .is_some_and(|presented| constant_time_eq(presented.trim(), &self.token))
    }

    fn session_redirect(&self, redirect_origin: Option<&str>) -> Response {
        // 任意のパスへ戻すとオープンリダイレクトになり得るため、常にトップへ戻す。
        // リダイレクトでアドレスバー・履歴・Refererからトークンを消す目的もある。
        let location = format!("{}/", redirect_origin.unwrap_or_default());
        let cookie = format!(
            "{}={}; Path=/; Max-Age={COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax",
            self.cookie_name, self.session_value
        );
        let mut response = StatusCode::SEE_OTHER.into_response();
        let headers = response.headers_mut();
        if let (Ok(location), Ok(cookie)) = (
            HeaderValue::from_str(&location),
            HeaderValue::from_str(&cookie),
        ) {
            headers.insert(header::LOCATION, location);
            headers.insert(header::SET_COOKIE, cookie);
        }
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        );
        response
    }
}

fn session_value(token: &str) -> String {
    sha256_hex(format!("{SESSION_LABEL}{token}").as_bytes())
}

fn query_token(query: Option<&str>) -> Option<&str> {
    query?
        .split('&')
        .find_map(|pair| pair.strip_prefix("token="))
}

/// 長さ以外の情報が比較時間から漏れないように比較する。
fn constant_time_eq(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

fn unauthorized_page(message: &str) -> Response {
    let body = format!(
        r#"<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kataru</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f5f3; color: #222; }}
main {{ max-width: 32rem; padding: 2rem 1.5rem; text-align: center; line-height: 1.7; }}
img {{ height: 32px; }}
code {{ background: #e9e7e3; padding: 0.1em 0.4em; border-radius: 4px; }}
@media (prefers-color-scheme: dark) {{ body {{ background: #1c1b1a; color: #eee; }} code {{ background: #333; }} }}
</style>
</head>
<body>
<main>
<img src="/logo.png" alt="Kataru">
<p>{message}</p>
<p>URLが分からない場合は、ターミナルで <code>kataru token</code> を実行すると再表示できます。</p>
</main>
</body>
</html>"#
    );
    let mut response = (StatusCode::UNAUTHORIZED, body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// URLにそのまま埋め込める文字だけで構成された、十分な長さのトークンか。
pub fn validate_token(token: &str) -> AppResult<()> {
    let valid_length = (MIN_TOKEN_LENGTH..=MAX_TOKEN_LENGTH).contains(&token.len());
    let valid_chars = token
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'));
    if valid_length && valid_chars {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "トークンは{MIN_TOKEN_LENGTH}〜{MAX_TOKEN_LENGTH}文字の英数字と - _ . ~ で指定してください。"
        )))
    }
}

fn generate_token() -> AppResult<String> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes)
        .map_err(|error| AppError::Internal(format!("乱数を生成できませんでした: {error}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TOKEN_FILE_NAME)
}

fn read_token(path: &Path) -> AppResult<String> {
    let token = fs::read_to_string(path)?.trim().to_owned();
    validate_token(&token).map_err(|_| {
        AppError::Internal(format!(
            "{} の内容が不正です。`kataru token --rotate` で再発行してください。",
            path.display()
        ))
    })?;
    Ok(token)
}

/// 自分だけが読めるファイルとして新規作成する（既存なら `AlreadyExists`）。
fn create_private_file(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)
}

/// 保存済みのトークンを読み、なければ生成して保存する。
///
/// 再起動（自動更新を含む）でブラウザやスマホのセッションが切れないよう、永続化する。
pub fn load_or_create_token(data_dir: &Path) -> AppResult<String> {
    let path = token_path(data_dir);
    match read_token(&path) {
        Ok(token) => return Ok(token),
        Err(AppError::Io(error)) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let token = generate_token()?;
    match create_private_file(&path) {
        Ok(mut file) => {
            file.write_all(token.as_bytes())?;
            file.sync_all()?;
            Ok(token)
        }
        // 同時に起動した別プロセスが先に作成した場合は、そちらを使う。
        Err(error) if error.kind() == ErrorKind::AlreadyExists => read_token(&path),
        Err(error) => Err(error.into()),
    }
}

pub fn rotate_token(data_dir: &Path) -> AppResult<String> {
    fs::create_dir_all(data_dir)?;
    let path = token_path(data_dir);
    let temporary = data_dir.join(format!("{TOKEN_FILE_NAME}.{}.tmp", uuid::Uuid::new_v4()));
    let token = generate_token()?;
    let mut file = create_private_file(&temporary)?;
    file.write_all(token.as_bytes())?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(token)
}

pub fn launch_url(origin: &str, token: &str) -> String {
    format!("{origin}/?token={token}")
}

/// `kataru token [--rotate] [--host H] [--port P] [--data-dir D | --portable]`
pub fn run_cli_command_if_requested() -> AppResult<bool> {
    let mut args = env::args()
        .skip(1)
        .filter(|arg| arg != "--verbose")
        .collect::<Vec<_>>();
    if args.first().map(String::as_str) != Some("token") {
        return Ok(false);
    }
    args.remove(0);
    let data_dir = parse_config_data_dir(&mut args)?;

    let mut rotate = false;
    let mut host = DEFAULT_HOST.to_owned();
    let mut port = DEFAULT_PORT;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--rotate" => rotate = true,
            "--host" => {
                host = args
                    .next()
                    .ok_or_else(|| AppError::BadRequest("--host には値が必要です。".to_owned()))?;
                validate_host(&host)?;
            }
            "--port" => {
                let value = args
                    .next()
                    .ok_or_else(|| AppError::BadRequest("--port には値が必要です。".to_owned()))?;
                port = parse_port(&value)?;
            }
            "--help" | "-h" | "help" => {
                println!(
                    "kataru token [--rotate] [--host <HOST>] [--port <PORT>] [--data-dir <PATH> | --portable]\n\n  アクセス用URLを表示します。\n  --rotate  トークンを再発行（ログイン済みのブラウザはすべて再認証が必要）\n  --host/--port は表示するURLにだけ使います（起動時と同じ値を指定してください）。"
                );
                return Ok(true);
            }
            _ => return Err(AppError::BadRequest(format!("未対応の引数です: {arg}"))),
        }
    }

    let token = if rotate {
        let token = rotate_token(&data_dir)?;
        eprintln!("トークンを再発行しました。起動中のKataruには再起動後に反映されます。");
        token
    } else {
        fs::create_dir_all(&data_dir)?;
        load_or_create_token(&data_dir)?
    };
    println!("{}", launch_url(&origin_for(&host, port), &token));
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn auth() -> Auth {
        Auth::new(TOKEN.to_owned(), 37371)
    }

    fn request(method: Method, uri: &str, headers: &[(header::HeaderName, &str)]) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            builder = builder.header(name, *value);
        }
        builder.body(Body::empty()).unwrap()
    }

    fn cookie() -> String {
        format!("other=1; kataru_session_37371={}", session_value(TOKEN))
    }

    #[test]
    fn valid_query_token_sets_cookie_and_redirects_to_top() {
        let response = auth()
            .check(
                &request(Method::GET, &format!("/?token={TOKEN}"), &[]),
                None,
            )
            .expect("token exchange responds");
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers()[header::LOCATION], "/");
        let set_cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(set_cookie.starts_with(&format!("kataru_session_37371={}", session_value(TOKEN))));
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Lax"));
        assert!(!set_cookie.contains(TOKEN));
    }

    #[test]
    fn token_exchange_redirects_to_development_origin() {
        let response = auth()
            .check(
                &request(Method::GET, &format!("/?token={TOKEN}"), &[]),
                Some("http://127.0.0.1:3000"),
            )
            .unwrap();
        assert_eq!(
            response.headers()[header::LOCATION],
            "http://127.0.0.1:3000/"
        );
    }

    #[test]
    fn wrong_query_token_is_rejected() {
        let response = auth()
            .check(&request(Method::GET, "/?token=wrong", &[]), None)
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
    }

    #[test]
    fn session_cookie_and_bearer_token_are_accepted() {
        let auth = auth();
        assert!(
            auth.check(
                &request(Method::POST, "/api/storage", &[(header::COOKIE, &cookie())]),
                None
            )
            .is_none()
        );
        let bearer = format!("Bearer {TOKEN}");
        assert!(
            auth.check(
                &request(
                    Method::GET,
                    "/api/health",
                    &[(header::AUTHORIZATION, &bearer)]
                ),
                None
            )
            .is_none()
        );
    }

    #[test]
    fn token_itself_is_not_a_valid_cookie() {
        let raw = format!("kataru_session_37371={TOKEN}");
        let response = auth()
            .check(
                &request(Method::GET, "/api/health", &[(header::COOKIE, &raw)]),
                None,
            )
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn cookie_for_another_port_is_rejected() {
        let other_port = format!("kataru_session_8080={}", session_value(TOKEN));
        let response = auth()
            .check(
                &request(Method::GET, "/", &[(header::COOKIE, &other_port)]),
                None,
            )
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn unauthenticated_requests_get_json_for_api_and_html_for_pages() {
        let auth = auth();
        let api = auth
            .check(&request(Method::GET, "/api/health", &[]), None)
            .unwrap();
        assert_eq!(api.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(api.headers()[header::CONTENT_TYPE], "application/json");

        let page = auth.check(&request(Method::GET, "/", &[]), None).unwrap();
        assert_eq!(page.status(), StatusCode::UNAUTHORIZED);
        assert!(
            page.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
    }

    #[test]
    fn icons_are_public_but_other_assets_are_not() {
        let auth = auth();
        assert!(
            auth.check(&request(Method::GET, "/favicon.ico", &[]), None)
                .is_none()
        );
        assert!(
            auth.check(&request(Method::GET, "/logo.png", &[]), None)
                .is_none()
        );
        assert!(
            auth.check(&request(Method::GET, "/assets/index.js", &[]), None)
                .is_some()
        );
        assert!(
            auth.check(&request(Method::POST, "/logo.png", &[]), None)
                .is_some()
        );
    }

    #[test]
    fn disabled_auth_allows_everything() {
        assert!(
            Auth::disabled()
                .check(&request(Method::POST, "/api/storage", &[]), None)
                .is_none()
        );
    }

    #[test]
    fn token_is_created_once_and_rotated() {
        let directory = tempfile::tempdir().unwrap();
        let first = load_or_create_token(directory.path()).unwrap();
        assert_eq!(first.len(), TOKEN_BYTES * 2);
        assert_eq!(load_or_create_token(directory.path()).unwrap(), first);
        let rotated = rotate_token(directory.path()).unwrap();
        assert_ne!(rotated, first);
        assert_eq!(load_or_create_token(directory.path()).unwrap(), rotated);
    }

    #[test]
    fn corrupted_token_file_is_an_error() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join(TOKEN_FILE_NAME), "short").unwrap();
        assert!(load_or_create_token(directory.path()).is_err());
    }

    #[test]
    fn token_validation_requires_url_safe_long_values() {
        assert!(validate_token(TOKEN).is_ok());
        assert!(validate_token("short").is_err());
        assert!(validate_token(&format!("{TOKEN}&x=1")).is_err());
    }
}
