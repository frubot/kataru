use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    Upstream(String, StatusCode),
    #[error("{0}")]
    Internal(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

impl AppError {
    pub fn diagnostic_class(&self) -> &'static str {
        match self {
            Self::BadRequest(_) => "bad_request",
            Self::NotFound(_) => "not_found",
            Self::Forbidden(_) => "forbidden",
            Self::Upstream(_, status) if matches!(status.as_u16(), 401 | 403) => {
                "upstream_authentication"
            }
            Self::Upstream(_, status) if status.as_u16() == 429 => "upstream_rate_limit",
            Self::Upstream(_, status) if status.is_server_error() => "upstream_unavailable",
            Self::Upstream(_, _) => "upstream_rejected",
            Self::Internal(_) => "internal",
            Self::Io(_) => "io",
            Self::Database(_) => "database",
            Self::Json(_) => "json",
            Self::Http(error) if error.is_timeout() => "upstream_timeout",
            Self::Http(error) if error.is_connect() => "upstream_unreachable",
            Self::Http(_) => "upstream_network",
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::Upstream(_, status) => *status,
            Self::Internal(_) | Self::Io(_) | Self::Database(_) | Self::Json(_) | Self::Http(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        let public_message = match self {
            Self::Io(error) => format!("ファイル処理に失敗しました: {error}"),
            Self::Database(error) => format!("データベース処理に失敗しました: {error}"),
            Self::Json(error) => format!("JSON処理に失敗しました: {error}"),
            Self::Http(error) => format!("外部APIとの通信に失敗しました: {error}"),
            error => error.to_string(),
        };
        (status, Json(json!({ "error": public_message }))).into_response()
    }
}
