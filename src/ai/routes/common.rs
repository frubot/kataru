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

/// Builds a client for an explicit service override, falling back to the
/// config's top-level `aiApiType` when `api_type` is `None`.
pub(crate) fn ai_api_client_for_api_type(
    state: &AppState,
    body: &Value,
    api_type: Option<&str>,
) -> AppResult<AiApiClient> {
    AiApiClient::from_state_for(state, ai_api_config_value(body), api_type)
}

/// Builds a client for the service chosen by a resolved role/entity selection.
pub(crate) fn ai_api_client_for_selection(
    state: &AppState,
    body: &Value,
    selection: &RoleSelection,
) -> AppResult<AiApiClient> {
    ai_api_client_for_api_type(state, body, selection.api_type.as_deref())
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

/// A resolved model name plus the service it should run on.
/// `api_type` is `None` when the request should use the config's top-level
/// `aiApiType` (the global default service).
pub(crate) struct RoleSelection {
    pub model: String,
    pub api_type: Option<String>,
}

/// Reads a model field that may be either a plain string or a
/// `{ "model": string, "aiApiType"?: string }` object.
fn model_selection_parts(value: &Value) -> Option<(String, Option<String>)> {
    if let Some(model) = value
        .as_str()
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        return Some((model.to_owned(), None));
    }
    if !value.is_object() {
        return None;
    }
    let model = optional_trimmed_string(value, "model")?;
    Some((model, optional_trimmed_string(value, "aiApiType")))
}

/// Per-role service override carried on `aiApiConfig.roleApiTypes`.
/// Keys are the `modelDefaults` field names (e.g. `summaryModel`).
pub(crate) fn role_api_type(body: &Value, role: &str) -> Option<String> {
    ai_api_config_value(body)
        .and_then(|config| config.get("roleApiTypes"))
        .and_then(|overrides| optional_trimmed_string(overrides, role))
}

/// Resolves only the service side of a role selection, without requiring a
/// model to be present.
pub(crate) fn role_selection_api_type(
    body: &Value,
    field: &str,
    role: &str,
) -> Option<String> {
    body.get(field)
        .and_then(model_selection_parts)
        .and_then(|(_, api_type)| api_type)
        .or_else(|| {
            ai_api_config_value(body)
                .and_then(|config| config.get("modelDefaults"))
                .and_then(|defaults| defaults.get(role))
                .and_then(model_selection_parts)
                .and_then(|(_, api_type)| api_type)
        })
        .or_else(|| role_api_type(body, role))
}

/// Resolves a role's `modelDefaults` entry without consulting a top-level
/// request field.
pub(crate) fn role_default_selection(body: &Value, role: &str) -> Option<RoleSelection> {
    let (model, api_type) = ai_api_config_value(body)
        .and_then(|config| config.get("modelDefaults"))
        .and_then(|defaults| defaults.get(role))
        .and_then(model_selection_parts)?;
    Some(RoleSelection {
        model,
        api_type: api_type.or_else(|| role_api_type(body, role)),
    })
}

pub(crate) fn optional_role_selection(
    body: &Value,
    field: &str,
    role: &str,
) -> Option<RoleSelection> {
    if let Some((model, api_type)) = body.get(field).and_then(model_selection_parts) {
        return Some(RoleSelection {
            model,
            api_type: api_type.or_else(|| role_api_type(body, role)),
        });
    }
    role_default_selection(body, role)
}

pub(crate) fn resolve_role_selection(
    body: &Value,
    field: &str,
    role: &str,
) -> AppResult<RoleSelection> {
    optional_role_selection(body, field, role).ok_or_else(|| {
        AppError::BadRequest(format!(
            "{field} または aiApiConfig.modelDefaults.{role} が必要です。"
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
            resolve_role_selection(&input, "model", "summaryModel")
                .unwrap()
                .model,
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
            resolve_role_selection(&input, "model", "summaryModel")
                .unwrap()
                .model,
            "explicit-model"
        );
    }

    #[test]
    fn model_resolution_rejects_a_missing_model_and_default() {
        assert!(resolve_role_selection(&json!({}), "model", "summaryModel").is_err());
    }

    #[test]
    fn selection_object_carries_a_service_override() {
        let input = json!({
            "model": {"model": "claude-sonnet-4-6", "aiApiType": "anthropic"}
        });

        let selection = resolve_role_selection(&input, "model", "summaryModel").unwrap();
        assert_eq!(selection.model, "claude-sonnet-4-6");
        assert_eq!(selection.api_type.as_deref(), Some("anthropic"));
    }

    #[test]
    fn role_api_types_override_the_global_service() {
        let input = json!({
            "aiApiConfig": {
                "aiApiType": "openrouter",
                "roleApiTypes": {"summaryModel": "anthropic"},
                "modelDefaults": {"summaryModel": "claude-sonnet-4-6"}
            }
        });

        let selection = resolve_role_selection(&input, "model", "summaryModel").unwrap();
        assert_eq!(selection.api_type.as_deref(), Some("anthropic"));
    }
}
