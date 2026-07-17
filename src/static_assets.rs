use axum::{
    body::Body,
    http::{HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "out/"]
struct UiAssets;

pub async fn serve(uri: Uri) -> Response {
    let requested = uri.path().trim_start_matches('/');
    let path = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    if let Some(response) = embedded_response(path) {
        return response;
    }
    if !path.contains('.')
        && let Some(response) = embedded_response("index.html")
    {
        return response;
    }
    (StatusCode::NOT_FOUND, "Not Found").into_response()
}

fn embedded_response(path: &str) -> Option<Response> {
    let asset = UiAssets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut response = Response::new(Body::from(asset.data.into_owned()));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref()).ok()?,
    );
    let cache_control = if path == "index.html" {
        "no-cache"
    } else if path.starts_with("_next/static/") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    Some(response)
}
