//! .kataru キャラクターパッケージ（ZIP）のエクスポート／検査／インポート API。

use std::collections::HashSet;

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{HeaderValue, header},
    response::Response,
};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    AppState,
    db::{self, PackagePreview},
    error::{AppError, AppResult},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPackageQuery {
    #[serde(default = "default_include_vrm")]
    include_vrm: bool,
    #[serde(default)]
    builtin: String,
    #[serde(default)]
    fallback_connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPackageQuery {
    #[serde(default)]
    fallback_model: String,
    #[serde(default)]
    fallback_connection_id: String,
    #[serde(default)]
    known_connection_ids: String,
}

fn default_include_vrm() -> bool {
    true
}

fn csv_set(value: &str) -> HashSet<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}

pub async fn export_package(
    Path(character_id): Path<String>,
    State(state): State<AppState>,
    Query(query): Query<ExportPackageQuery>,
) -> AppResult<Response> {
    let builtin_ids = csv_set(&query.builtin);
    let include_vrm = query.include_vrm;
    let fallback_connection_id = query.fallback_connection_id;
    let bytes = state
        .database
        .call(move |connection| {
            db::build_character_package(
                connection,
                &character_id,
                include_vrm,
                &builtin_ids,
                &fallback_connection_id,
            )
        })
        .await?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    Ok(response)
}

pub async fn inspect_package(body: Bytes) -> AppResult<Json<PackagePreview>> {
    // ZIP解析とハッシュ照合は重いのでワーカースレッドで行う。
    let preview = tokio::task::spawn_blocking(move || db::inspect_character_package(&body))
        .await
        .map_err(|error| {
            AppError::Internal(format!("パッケージ検査タスクが失敗しました: {error}"))
        })??;
    Ok(Json(preview))
}

pub async fn import_package(
    State(state): State<AppState>,
    Query(query): Query<ImportPackageQuery>,
    body: Bytes,
) -> AppResult<Json<Value>> {
    let known_ids = csv_set(&query.known_connection_ids);
    let fallback_model = query.fallback_model;
    let fallback_connection_id = query.fallback_connection_id;
    let stored = state
        .database
        .call(move |connection| {
            db::import_character_package(
                connection,
                &body,
                &fallback_model,
                &fallback_connection_id,
                &known_ids,
            )
        })
        .await?;
    Ok(Json(stored))
}
