use axum::{
    body::Body,
    http::{HeaderValue, header},
    response::Response,
};
use serde_json::{Map, Value};

use crate::{
    AppState,
    error::{AppError, AppResult},
};

use super::super::{
    anthropic,
    api_client::{AiApiClient, ai_api_config_value, classify_upstream_status, map_request_error},
};

pub(super) fn ai_api_client_for(state: &AppState, body: &Value) -> AppResult<AiApiClient> {
    AiApiClient::from_state(state, ai_api_config_value(body))
}

pub(super) fn required_string(body: &Value, field: &str, message: &str) -> AppResult<String> {
    body.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::BadRequest(message.to_owned()))
}

pub(super) fn optional_trimmed_string(body: &Value, field: &str) -> Option<String> {
    body.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn optional_model(body: &Value, field: &str, default_field: &str) -> Option<String> {
    optional_trimmed_string(body, field).or_else(|| {
        ai_api_config_value(body)
            .and_then(|config| config.get("modelDefaults"))
            .and_then(|defaults| optional_trimmed_string(defaults, default_field))
    })
}

pub(crate) fn resolve_model(body: &Value, field: &str, default_field: &str) -> AppResult<String> {
    optional_model(body, field, default_field).ok_or_else(|| {
        AppError::BadRequest(format!(
            "{field} または aiApiConfig.modelDefaults.{default_field} が必要です。"
        ))
    })
}

pub(super) fn copy_if_present(
    target: &mut Map<String, Value>,
    source: &Value,
    from: &str,
    to: &str,
) {
    if let Some(value) = source.get(from)
        && !value.is_null()
    {
        target.insert(to.to_owned(), value.clone());
    }
}

pub(super) async fn upstream_error(response: reqwest::Response) -> AppError {
    let status = response.status();
    tracing::warn!(
        upstream_status = status.as_u16(),
        classification = classify_upstream_status(status),
        "Upstream rejected the request"
    );
    let detail = response.text().await.unwrap_or_default();
    AppError::Upstream(
        if detail.trim().is_empty() {
            "Upstream error".to_owned()
        } else {
            detail
        },
        status,
    )
}

pub(super) async fn read_upstream_json(
    api_client: &AiApiClient,
    response: reqwest::Response,
) -> AppResult<Value> {
    if !response.status().is_success() {
        return Err(upstream_error(response).await);
    }
    let data = response.json::<Value>().await.map_err(map_request_error)?;
    Ok(if api_client.is_anthropic() {
        anthropic::response_to_openai(data)
    } else {
        data
    })
}

pub(super) async fn raw_upstream_response(response: reqwest::Response) -> AppResult<Response> {
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("application/json"));
    let bytes = response.bytes().await.map_err(map_request_error)?;
    let mut output = Response::new(Body::from(bytes));
    *output.status_mut() = status;
    output
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    Ok(output)
}

pub(super) async fn successful_json_response(
    api_client: &AiApiClient,
    response: reqwest::Response,
) -> AppResult<Response> {
    if !response.status().is_success() {
        return Err(upstream_error(response).await);
    }
    let body = if api_client.is_anthropic() {
        let data = response.json::<Value>().await.map_err(map_request_error)?;
        Body::from(serde_json::to_vec(&anthropic::response_to_openai(data))?)
    } else {
        Body::from(response.bytes().await.map_err(map_request_error)?)
    };
    let mut output = Response::new(body);
    output.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(output)
}

pub(super) fn take_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn model_resolution_uses_the_active_api_type_default() {
        let input = json!({
            "model": "   ",
            "aiApiConfig": {
                "modelDefaults": {
                    "summaryModel": "api-type-default-model"
                }
            }
        });

        assert_eq!(
            resolve_model(&input, "model", "summaryModel").unwrap(),
            "api-type-default-model"
        );
    }

    #[test]
    fn model_resolution_prefers_an_explicit_model() {
        let input = json!({
            "model": "explicit-model",
            "aiProviderConfig": {
                "modelDefaults": {
                    "summaryModel": "api-type-default-model"
                }
            }
        });

        assert_eq!(
            resolve_model(&input, "model", "summaryModel").unwrap(),
            "explicit-model"
        );
    }

    #[test]
    fn model_resolution_rejects_a_missing_model_and_default() {
        assert!(resolve_model(&json!({}), "model", "summaryModel").is_err());
    }
}
