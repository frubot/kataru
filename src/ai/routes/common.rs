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

/// Builds a client for an explicit connection override, falling back to the
/// config's top-level `connectionId` when `connection_id` is `None`.
pub(crate) fn ai_api_client_for_connection(
    state: &AppState,
    body: &Value,
    connection_id: Option<&str>,
) -> AppResult<AiApiClient> {
    AiApiClient::from_state_for(state, ai_api_config_value(body), connection_id)
}

/// Builds a client for the connection chosen by a resolved role/entity selection.
pub(crate) fn ai_api_client_for_selection(
    state: &AppState,
    body: &Value,
    selection: &RoleSelection,
) -> AppResult<AiApiClient> {
    ai_api_client_for_connection(state, body, selection.connection_id.as_deref())
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

/// A resolved model name plus the connection it should run on.
/// `connection_id` is `None` when the request should use the config's
/// top-level `connectionId` (the global default connection).
pub(crate) struct RoleSelection {
    pub model: String,
    pub connection_id: Option<String>,
}

/// Reads a model field that may be either a plain string or a
/// `{ "model": string, "connectionId"?: string }` object. The legacy
/// `aiApiType` field name is accepted as a connection id.
pub(crate) fn model_selection_parts(value: &Value) -> Option<(String, Option<String>)> {
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
    Some((
        model,
        optional_trimmed_string(value, "connectionId")
            .or_else(|| optional_trimmed_string(value, "aiApiType")),
    ))
}

/// Reads just the model name from a field that may be a plain string or a
/// model selection object.
pub(crate) fn model_string(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(model_selection_parts)
        .map(|(model, _)| model)
        .unwrap_or_default()
}

/// Reads an entity-level connection override (`connectionId`, legacy
/// `aiApiType`, or the entity's own model selection object).
pub(crate) fn entity_connection_id(entity: &Value) -> Option<String> {
    optional_trimmed_string(entity, "connectionId")
        .or_else(|| optional_trimmed_string(entity, "aiApiType"))
        .or_else(|| {
            entity
                .get("model")
                .and_then(model_selection_parts)
                .and_then(|(_, connection_id)| connection_id)
        })
}

/// Per-role connection override carried on `aiApiConfig.roleApiTypes`.
/// Keys are the `modelDefaults` field names (e.g. `summaryModel`) and values
/// are connection ids.
pub(crate) fn role_connection(body: &Value, role: &str) -> Option<String> {
    ai_api_config_value(body)
        .and_then(|config| config.get("roleApiTypes"))
        .and_then(|overrides| optional_trimmed_string(overrides, role))
}

/// Resolves only the connection side of a role selection, without requiring a
/// model to be present.
pub(crate) fn role_selection_connection(body: &Value, field: &str, role: &str) -> Option<String> {
    body.get(field)
        .and_then(model_selection_parts)
        .and_then(|(_, connection_id)| connection_id)
        .or_else(|| {
            ai_api_config_value(body)
                .and_then(|config| config.get("modelDefaults"))
                .and_then(|defaults| defaults.get(role))
                .and_then(model_selection_parts)
                .and_then(|(_, connection_id)| connection_id)
        })
        .or_else(|| role_connection(body, role))
}

/// Resolves a role's `modelDefaults` entry without consulting a top-level
/// request field.
pub(crate) fn role_default_selection(body: &Value, role: &str) -> Option<RoleSelection> {
    let (model, connection_id) = ai_api_config_value(body)
        .and_then(|config| config.get("modelDefaults"))
        .and_then(|defaults| defaults.get(role))
        .and_then(model_selection_parts)?;
    Some(RoleSelection {
        model,
        connection_id: connection_id.or_else(|| role_connection(body, role)),
    })
}

pub(crate) fn optional_role_selection(
    body: &Value,
    field: &str,
    role: &str,
) -> Option<RoleSelection> {
    if let Some((model, connection_id)) = body.get(field).and_then(model_selection_parts) {
        return Some(RoleSelection {
            model,
            connection_id: connection_id.or_else(|| role_connection(body, role)),
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

pub(crate) async fn upstream_error(response: reqwest::Response) -> AppError {
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
    fn selection_object_carries_a_connection_override() {
        for connection_key in ["connectionId", "aiApiType"] {
            let input = json!({
                "model": {"model": "claude-sonnet-4-6", connection_key: "anthropic"}
            });

            let selection = resolve_role_selection(&input, "model", "summaryModel").unwrap();
            assert_eq!(selection.model, "claude-sonnet-4-6");
            assert_eq!(selection.connection_id.as_deref(), Some("anthropic"));
        }
    }

    #[test]
    fn model_string_reads_selection_objects() {
        let input = json!({
            "model": {"model": "claude-sonnet-4-6", "connectionId": "anthropic"},
            "plain": "plain-model"
        });

        assert_eq!(model_string(&input, "model"), "claude-sonnet-4-6");
        assert_eq!(model_string(&input, "plain"), "plain-model");
        assert_eq!(model_string(&input, "missing"), "");
    }

    #[test]
    fn entity_connection_id_accepts_new_and_legacy_fields() {
        assert_eq!(
            entity_connection_id(&json!({"connectionId": "cx_1"})).as_deref(),
            Some("cx_1")
        );
        assert_eq!(
            entity_connection_id(&json!({"aiApiType": "anthropic"})).as_deref(),
            Some("anthropic")
        );
        assert_eq!(
            entity_connection_id(&json!({"model": {"model": "m", "connectionId": "cx_2"}}))
                .as_deref(),
            Some("cx_2")
        );
        assert_eq!(entity_connection_id(&json!({"model": "m"})), None);
    }

    #[test]
    fn role_api_types_override_the_global_connection() {
        let input = json!({
            "aiApiConfig": {
                "connectionId": "openrouter",
                "roleApiTypes": {"summaryModel": "anthropic"},
                "modelDefaults": {"summaryModel": "claude-sonnet-4-6"}
            }
        });

        let selection = resolve_role_selection(&input, "model", "summaryModel").unwrap();
        assert_eq!(selection.connection_id.as_deref(), Some("anthropic"));
    }
}
