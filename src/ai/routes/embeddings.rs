use axum::{
    Json,
    extract::State,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::{
    AppState,
    error::{AppError, AppResult},
};

use super::common::{ai_api_client_for, raw_upstream_response, resolve_model};

pub async fn embeddings(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let api_client = ai_api_client_for(&state, &input)?;
    if !api_client.embeddings_enabled() {
        return Ok(Json(json!({ "data": [], "disabled": true })).into_response());
    }
    let embedding_input = input.get("input").cloned().ok_or_else(|| {
        AppError::BadRequest("input は文字列、または入力配列である必要があります。".to_owned())
    })?;
    let valid_input = embedding_input.is_string()
        || embedding_input.as_array().is_some_and(|values| {
            values
                .iter()
                .all(|value| value.is_string() || value.is_object())
        });
    if !valid_input {
        return Err(AppError::BadRequest(
            "input は文字列、または入力配列である必要があります。".to_owned(),
        ));
    }
    let model = resolve_model(&input, "model", "memoryEmbeddingModel")?;
    let input_type = input
        .get("inputType")
        .or_else(|| input.get("input_type"))
        .and_then(Value::as_str);
    let mut body = json!({
        "input": embedding_input,
        "model": model,
        "encoding_format": "float"
    });
    if let Some(dimensions) = input.get("dimensions").and_then(Value::as_u64)
        && dimensions > 0
    {
        body["dimensions"] = json!(dimensions);
    }
    if api_client.is_openrouter() {
        if let Some(input_type) = input_type {
            body["input_type"] = json!(input_type);
        }
        body["provider"] = input
            .get("provider")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({ "data_collection": "deny" }));
    }
    let upstream = api_client.send_json("embeddings", &body, 60).await?;
    raw_upstream_response(upstream).await
}
