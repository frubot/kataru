use std::{collections::HashSet, time::Duration};

use axum::{Json, extract::State};
use serde_json::{Value, json};

use crate::{
    AppState,
    error::{AppError, AppResult},
};

use super::{
    super::api_client::map_request_error,
    common::{ai_api_client_for, upstream_error},
};

pub async fn connection_status(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> Json<Value> {
    let api_client = match ai_api_client_for(&state, &input) {
        Ok(api_client) => api_client,
        Err(_) => {
            return Json(json!({
                "ready": false,
                "code": "missing_configuration",
                "message": "会話に使うAIの設定が見つかりません。"
            }));
        }
    };

    match api_client
        .get("models", Duration::from_secs(8))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => Json(json!({
            "ready": true,
            "code": "ready",
            "message": "準備できています。"
        })),
        Ok(_) => Json(json!({
            "ready": false,
            "code": "connection_rejected",
            "message": "AIに接続できませんでした。設定を確認してください。"
        })),
        Err(_) => Json(json!({
            "ready": false,
            "code": "unreachable",
            "message": "AIに接続できませんでした。起動状態と設定を確認してください。"
        })),
    }
}

fn normalize_models_response(input: &Value) -> Vec<Value> {
    let entries = input
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| input.as_array())
        .into_iter()
        .flatten();
    let mut seen = HashSet::new();
    let mut models = entries
        .filter_map(|entry| {
            let (id, name) = if let Some(id) = entry.as_str() {
                (id, id)
            } else {
                let record = entry.as_object()?;
                let id = record.get("id")?.as_str()?;
                let name = record
                    .get("display_name")
                    .or_else(|| record.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(id);
                (id, name)
            };
            let id = id.trim();
            if id.is_empty() || !seen.insert(id.to_owned()) {
                return None;
            }
            let name = name.trim();
            Some(json!({
                "id": id,
                "name": if name.is_empty() { id } else { name }
            }))
        })
        .collect::<Vec<_>>();

    models.sort_by(|left, right| {
        let sort_key = |value: &Value| {
            value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_lowercase()
        };
        sort_key(left).cmp(&sort_key(right)).then_with(|| {
            left.get("id")
                .and_then(Value::as_str)
                .cmp(&right.get("id").and_then(Value::as_str))
        })
    });
    models
}

fn openrouter_models_path(input: &Value) -> AppResult<&'static str> {
    match input.get("outputModality").and_then(Value::as_str) {
        None | Some("text") => Ok("models?output_modalities=text"),
        Some("image") => Ok("models?output_modalities=image"),
        Some("embeddings") => Ok("models?output_modalities=embeddings"),
        Some(_) => Err(AppError::BadRequest(
            "outputModality が不正です。".to_owned(),
        )),
    }
}

fn normalize_providers_response(input: &Value) -> Vec<Value> {
    let entries = input
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    let mut seen = HashSet::new();
    let mut providers = entries
        .filter_map(|entry| {
            let record = entry.as_object()?;
            let slug = record.get("slug")?.as_str()?.trim();
            if slug.is_empty() || !seen.insert(slug.to_owned()) {
                return None;
            }
            let name = record
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(slug);
            Some(json!({ "slug": slug, "name": name }))
        })
        .collect::<Vec<_>>();
    providers.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase()
            .cmp(
                &right
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_lowercase(),
            )
    });
    providers
}

pub async fn models(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Json<Value>> {
    let api_client = ai_api_client_for(&state, &input)?;
    let path = if api_client.is_anthropic() {
        "models?limit=1000"
    } else if api_client.is_openrouter() {
        openrouter_models_path(&input)?
    } else {
        "models"
    };
    let response = api_client
        .get(path, Duration::from_secs(15))
        .send()
        .await
        .map_err(map_request_error)?;
    if !response.status().is_success() {
        return Err(upstream_error(response).await);
    }
    let data = response.json::<Value>().await.map_err(map_request_error)?;
    Ok(Json(json!({ "data": normalize_models_response(&data) })))
}

pub async fn providers(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Json<Value>> {
    let api_client = ai_api_client_for(&state, &input)?;
    if !api_client.is_openrouter() {
        return Err(AppError::BadRequest(
            "プロバイダー一覧はOpenRouterでのみ利用できます。".to_owned(),
        ));
    }
    let response = api_client
        .get("providers", Duration::from_secs(15))
        .send()
        .await
        .map_err(map_request_error)?;
    if !response.status().is_success() {
        return Err(upstream_error(response).await);
    }
    let data = response.json::<Value>().await.map_err(map_request_error)?;
    Ok(Json(json!({ "data": normalize_providers_response(&data) })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_list_normalizes_openai_and_anthropic_names() {
        let models = normalize_models_response(&json!({
            "data": [
                { "id": "openai/gpt-5", "name": "GPT-5" },
                { "id": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6" },
                { "id": "plain-model" }
            ]
        }));

        assert_eq!(
            models,
            vec![
                json!({ "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" }),
                json!({ "id": "openai/gpt-5", "name": "GPT-5" }),
                json!({ "id": "plain-model", "name": "plain-model" }),
            ]
        );
    }

    #[test]
    fn model_list_drops_blank_and_duplicate_ids() {
        let models = normalize_models_response(&json!({
            "data": ["model-b", { "id": "model-b", "name": "Duplicate" }, { "id": "  " }]
        }));

        assert_eq!(models, vec![json!({ "id": "model-b", "name": "model-b" })]);
    }

    #[test]
    fn openrouter_model_list_path_filters_by_output_modality() {
        assert_eq!(
            openrouter_models_path(&json!({})).unwrap(),
            "models?output_modalities=text"
        );
        assert_eq!(
            openrouter_models_path(&json!({ "outputModality": "text" })).unwrap(),
            "models?output_modalities=text"
        );
        assert_eq!(
            openrouter_models_path(&json!({ "outputModality": "image" })).unwrap(),
            "models?output_modalities=image"
        );
        assert_eq!(
            openrouter_models_path(&json!({ "outputModality": "embeddings" })).unwrap(),
            "models?output_modalities=embeddings"
        );
    }

    #[test]
    fn openrouter_model_list_path_rejects_unknown_output_modality() {
        assert!(openrouter_models_path(&json!({ "outputModality": "audio" })).is_err());
    }

    #[test]
    fn provider_list_uses_names_and_slugs_and_drops_invalid_entries() {
        let providers = normalize_providers_response(&json!({
            "data": [
                { "slug": "together", "name": "Together" },
                { "slug": "deepinfra", "name": "DeepInfra" },
                { "slug": "together", "name": "Duplicate" },
                { "slug": "blank-name", "name": "  " },
                { "name": "Missing slug" }
            ]
        }));

        assert_eq!(
            providers,
            vec![
                json!({ "slug": "blank-name", "name": "blank-name" }),
                json!({ "slug": "deepinfra", "name": "DeepInfra" }),
                json!({ "slug": "together", "name": "Together" }),
            ]
        );
    }
}
