use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use reqwest::{Client, RequestBuilder, Response};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::{
    AppState,
    ai_config::{DEFAULT_OPENAI_BASE_URL, EffectiveAiConfig},
    error::{AppError, AppResult},
};

use super::anthropic;

const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const LOCAL_API_KEY_FALLBACK: &str = "local";

pub fn ai_api_config_value(body: &Value) -> Option<&Value> {
    body.get("aiApiConfig")
        .filter(|value| !value.is_null())
        .or_else(|| {
            body.get("aiProviderConfig")
                .filter(|value| !value.is_null())
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiApiKind {
    OpenRouter,
    OpenAiCompatible,
    Anthropic,
}

impl AiApiKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::OpenRouter => "openrouter",
            Self::OpenAiCompatible => "openai-compatible",
            Self::Anthropic => "anthropic",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiApiConfig {
    #[serde(alias = "aiProvider")]
    pub ai_api_type: Option<String>,
    pub open_router_ignored_providers: Vec<String>,
    pub open_ai_compatible_base_url: Option<String>,
    pub open_ai_compatible_embeddings_enabled: bool,
    pub open_ai_compatible_image_generation_enabled: bool,
}

impl Default for AiApiConfig {
    fn default() -> Self {
        Self {
            ai_api_type: None,
            open_router_ignored_providers: Vec::new(),
            open_ai_compatible_base_url: None,
            open_ai_compatible_embeddings_enabled: true,
            open_ai_compatible_image_generation_enabled: false,
        }
    }
}

#[derive(Clone)]
pub struct AiApiClient {
    client: Client,
    kind: AiApiKind,
    base_url: String,
    api_key: Option<String>,
    application_origin: String,
    ignored_providers: Vec<String>,
    embeddings_enabled: bool,
    image_generation_enabled: bool,
}

impl AiApiClient {
    pub fn from_state(state: &AppState, config: Option<&Value>) -> AppResult<Self> {
        let config = config
            .cloned()
            .and_then(|value| serde_json::from_value::<AiApiConfig>(value).ok());
        Self::resolve(
            state.http_client.clone(),
            &state.application_origin,
            &state.ai_config.effective(),
            config,
        )
    }

    pub fn resolve(
        client: Client,
        application_origin: impl AsRef<str>,
        server_config: &EffectiveAiConfig,
        config: Option<AiApiConfig>,
    ) -> AppResult<Self> {
        let config = config.unwrap_or_default();
        let kind = match config.ai_api_type.as_deref() {
            Some("openai-compatible") => AiApiKind::OpenAiCompatible,
            Some("anthropic") => AiApiKind::Anthropic,
            _ => AiApiKind::OpenRouter,
        };

        let (base_url, api_key) = match kind {
            AiApiKind::OpenRouter => {
                let api_key = server_config.openrouter_api_key.clone().ok_or_else(|| {
                        AppError::Internal(
                            "OpenRouter APIキーが設定されていません。設定画面または `kataru config set openrouter.api-key` で設定してください。".to_owned(),
                        )
                    })?;
                (OPENROUTER_BASE_URL.to_owned(), Some(api_key))
            }
            AiApiKind::OpenAiCompatible => {
                // The upstream host and API key are server-owned. In particular, never use
                // openAiCompatibleBaseUrl supplied in a request, because doing so could send
                // the server API key to an attacker-controlled host.
                let base_url = server_config.openai_base_url.clone();
                let api_key = server_config.openai_api_key.clone().or_else(|| {
                    (base_url != DEFAULT_OPENAI_BASE_URL).then(|| LOCAL_API_KEY_FALLBACK.to_owned())
                });
                if api_key.is_none() {
                    return Err(AppError::Internal(
                        "OpenAI APIキーが設定されていません。設定画面または `kataru config set openai.api-key` で設定してください。".to_owned(),
                    ));
                }
                (base_url, api_key)
            }
            AiApiKind::Anthropic => {
                let api_key = server_config.anthropic_api_key.clone().ok_or_else(|| {
                    AppError::Internal(
                        "Anthropic APIキーが設定されていません。設定画面または `kataru config set anthropic.api-key` で設定してください。".to_owned(),
                    )
                })?;
                (server_config.anthropic_base_url.clone(), Some(api_key))
            }
        };

        Ok(Self {
            client,
            kind,
            base_url,
            api_key,
            application_origin: application_origin.as_ref().to_owned(),
            ignored_providers: normalize_provider_slugs(config.open_router_ignored_providers),
            embeddings_enabled: config.open_ai_compatible_embeddings_enabled,
            image_generation_enabled: config.open_ai_compatible_image_generation_enabled,
        })
    }

    pub fn is_openrouter(&self) -> bool {
        self.kind == AiApiKind::OpenRouter
    }

    pub fn is_openai_compatible(&self) -> bool {
        self.kind == AiApiKind::OpenAiCompatible
    }

    pub fn is_anthropic(&self) -> bool {
        self.kind == AiApiKind::Anthropic
    }

    pub fn embeddings_enabled(&self) -> bool {
        self.is_openrouter() || (self.is_openai_compatible() && self.embeddings_enabled)
    }

    pub fn image_generation_enabled(&self) -> bool {
        self.is_openrouter() || (self.is_openai_compatible() && self.image_generation_enabled)
    }

    pub fn endpoint(&self, path: &str) -> String {
        let path = if self.is_anthropic() && path.trim_matches('/') == "chat/completions" {
            "messages"
        } else {
            path
        };
        format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    pub fn post(&self, path: &str, timeout: Duration) -> RequestBuilder {
        let mut request = self.client.post(self.endpoint(path)).timeout(timeout);
        if self.is_anthropic() {
            request = request
                .header("x-api-key", self.api_key.as_deref().unwrap_or_default())
                .header("anthropic-version", "2023-06-01");
        } else if let Some(api_key) = &self.api_key {
            request = request.bearer_auth(api_key);
        }
        if self.is_openrouter() {
            request = request
                .header("HTTP-Referer", &self.application_origin)
                .header("X-Title", "Kataru");
        }
        request
    }

    pub fn get(&self, path: &str, timeout: Duration) -> RequestBuilder {
        let mut request = self.client.get(self.endpoint(path)).timeout(timeout);
        if self.is_anthropic() {
            request = request
                .header("x-api-key", self.api_key.as_deref().unwrap_or_default())
                .header("anthropic-version", "2023-06-01");
        } else if let Some(api_key) = &self.api_key {
            request = request.bearer_auth(api_key);
        }
        if self.is_openrouter() {
            request = request
                .header("HTTP-Referer", &self.application_origin)
                .header("X-Title", "Kataru");
        }
        request
    }

    pub fn post_json(&self, path: &str, body: &Value, timeout_secs: u64) -> RequestBuilder {
        self.post(path, Duration::from_secs(timeout_secs))
            .json(body)
    }

    fn with_openrouter_provider_preferences(&self, body: &Value) -> Value {
        if !self.is_openrouter() || self.ignored_providers.is_empty() {
            return body.clone();
        }
        let mut routed_body = body.clone();
        let Some(body_object) = routed_body.as_object_mut() else {
            return routed_body;
        };
        let mut provider_options = body_object
            .remove("provider")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_else(Map::new);
        let mut ignored_providers = self.ignored_providers.clone();
        if let Some(existing) = provider_options
            .remove("ignore")
            .and_then(|value| value.as_array().cloned())
        {
            ignored_providers.extend(
                existing
                    .into_iter()
                    .filter_map(|value| value.as_str().map(str::to_owned)),
            );
        }
        provider_options.insert(
            "ignore".to_owned(),
            Value::Array(
                normalize_provider_slugs(ignored_providers)
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ),
        );
        body_object.insert("provider".to_owned(), Value::Object(provider_options));
        routed_body
    }

    pub async fn send_json(
        &self,
        path: &str,
        body: &Value,
        timeout_secs: u64,
    ) -> AppResult<Response> {
        let routed_body = self.with_openrouter_provider_preferences(body);
        let anthropic_body = if self.is_anthropic() && path.trim_matches('/') == "chat/completions"
        {
            Some(anthropic::request_from_openai(body)?)
        } else {
            None
        };
        let started_at = Instant::now();
        let result = self
            .post_json(
                path,
                anthropic_body.as_ref().unwrap_or(&routed_body),
                timeout_secs,
            )
            .send()
            .await;
        self.finish_request(path, started_at, result)
    }

    pub async fn send_get(&self, path: &str, timeout: Duration) -> AppResult<Response> {
        let started_at = Instant::now();
        let result = self.get(path, timeout).send().await;
        self.finish_request(path, started_at, result)
    }

    fn finish_request(
        &self,
        operation: &str,
        started_at: Instant,
        result: Result<Response, reqwest::Error>,
    ) -> AppResult<Response> {
        let latency_ms = started_at.elapsed().as_millis();
        match result {
            Ok(response) => {
                tracing::debug!(
                    upstream = self.kind.as_str(),
                    operation = safe_upstream_operation(operation),
                    status = response.status().as_u16(),
                    latency_ms,
                    classification = classify_upstream_status(response.status()),
                    "Upstream request completed"
                );
                Ok(response)
            }
            Err(error) => {
                tracing::warn!(
                    upstream = self.kind.as_str(),
                    operation = safe_upstream_operation(operation),
                    latency_ms,
                    classification = classify_request_error(&error),
                    "Upstream request failed before receiving a response"
                );
                Err(mapped_request_error(error))
            }
        }
    }
}

fn normalize_provider_slugs(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && value.len() <= 128 && seen.insert(value.clone()))
        .take(256)
        .collect()
}

pub fn map_request_error(error: reqwest::Error) -> AppError {
    tracing::warn!(
        classification = classify_request_error(&error),
        "Upstream response transport failed"
    );
    mapped_request_error(error)
}

fn mapped_request_error(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        let status = StatusCode::from_u16(499).expect("499 is a valid HTTP status code");
        AppError::Upstream("Request aborted".to_owned(), status)
    } else {
        AppError::Http(error)
    }
}

pub fn classify_upstream_status(status: StatusCode) -> &'static str {
    if status.is_success() {
        return "success";
    }
    match status.as_u16() {
        400 => "bad_request",
        401 | 403 => "authentication",
        408 => "timeout",
        413 => "request_too_large",
        429 => "rate_limit",
        _ if status.is_client_error() => "client_error",
        _ if status.is_server_error() => "server_error",
        _ => "unexpected_status",
    }
}

fn classify_request_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "unreachable"
    } else if error.is_decode() {
        "decode"
    } else if error.is_body() {
        "body"
    } else if error.is_request() {
        "request"
    } else {
        "network"
    }
}

fn safe_upstream_operation(operation: &str) -> &'static str {
    match operation
        .trim_matches('/')
        .split_once('?')
        .map_or(operation.trim_matches('/'), |(path, _)| path)
    {
        "models" => "models",
        "providers" => "providers",
        "chat/completions" => "chat/completions",
        "embeddings" => "embeddings",
        "images/generations" => "images/generations",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_config::DEFAULT_OPENAI_BASE_URL;
    use serde_json::json;

    fn server_config() -> EffectiveAiConfig {
        EffectiveAiConfig {
            openrouter_api_key: Some("openrouter-secret".to_owned()),
            openai_base_url: DEFAULT_OPENAI_BASE_URL.to_owned(),
            openai_api_key: Some("openai-secret".to_owned()),
            anthropic_base_url: "https://api.anthropic.com/v1".to_owned(),
            anthropic_api_key: Some("anthropic-secret".to_owned()),
        }
    }

    #[test]
    fn upstream_status_classification_is_stable_and_content_free() {
        assert_eq!(classify_upstream_status(StatusCode::OK), "success");
        assert_eq!(
            classify_upstream_status(StatusCode::UNAUTHORIZED),
            "authentication"
        );
        assert_eq!(
            classify_upstream_status(StatusCode::TOO_MANY_REQUESTS),
            "rate_limit"
        );
        assert_eq!(
            classify_upstream_status(StatusCode::INTERNAL_SERVER_ERROR),
            "server_error"
        );
    }

    #[test]
    fn upstream_log_operation_is_allowlisted_and_strips_queries() {
        assert_eq!(
            safe_upstream_operation("models?output_modalities=text"),
            "models"
        );
        assert_eq!(
            safe_upstream_operation("private/secret-value?api_key=secret"),
            "other"
        );
    }

    #[test]
    fn openrouter_remains_the_default_api_type() {
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            None,
        )
        .unwrap();

        assert!(api_client.is_openrouter());
        assert_eq!(
            api_client.endpoint("models"),
            "https://openrouter.ai/api/v1/models"
        );
    }

    #[test]
    fn request_supplied_openai_base_url_is_ignored() {
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            Some(AiApiConfig {
                ai_api_type: Some("openai-compatible".to_owned()),
                open_ai_compatible_base_url: Some("https://attacker.example/v1".to_owned()),
                open_ai_compatible_embeddings_enabled: true,
                open_ai_compatible_image_generation_enabled: false,
                ..AiApiConfig::default()
            }),
        )
        .unwrap();

        assert!(!api_client.is_openrouter());
        assert_eq!(
            api_client.endpoint("chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn custom_openai_endpoint_keeps_local_key_fallback() {
        let config = EffectiveAiConfig {
            openrouter_api_key: None,
            openai_base_url: "http://127.0.0.1:1234/v1".to_owned(),
            openai_api_key: None,
            anthropic_base_url: "https://api.anthropic.com/v1".to_owned(),
            anthropic_api_key: None,
        };
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &config,
            Some(AiApiConfig {
                ai_api_type: Some("openai-compatible".to_owned()),
                ..AiApiConfig::default()
            }),
        )
        .unwrap();
        let request = api_client
            .get("models", Duration::from_secs(1))
            .build()
            .unwrap();

        assert_eq!(
            request.headers().get("authorization").unwrap(),
            "Bearer local"
        );
    }

    #[test]
    fn anthropic_uses_native_endpoint_and_headers() {
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            Some(AiApiConfig {
                ai_api_type: Some("anthropic".to_owned()),
                ..AiApiConfig::default()
            }),
        )
        .unwrap();
        let request = api_client
            .post_json(
                "chat/completions",
                &json!({"model": "claude-sonnet-4-6", "messages": []}),
                1,
            )
            .build()
            .unwrap();

        assert!(api_client.is_anthropic());
        assert_eq!(
            request.url().as_str(),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            request.headers().get("x-api-key").unwrap(),
            "anthropic-secret"
        );
        assert_eq!(
            request.headers().get("anthropic-version").unwrap(),
            "2023-06-01"
        );
        assert!(request.headers().get("authorization").is_none());
    }

    #[test]
    fn api_config_accepts_canonical_and_legacy_type_names() {
        let canonical = serde_json::from_value::<AiApiConfig>(json!({
            "aiApiType": "anthropic"
        }))
        .unwrap();
        let legacy = serde_json::from_value::<AiApiConfig>(json!({
            "aiProvider": "openai-compatible"
        }))
        .unwrap();

        assert_eq!(canonical.ai_api_type.as_deref(), Some("anthropic"));
        assert_eq!(legacy.ai_api_type.as_deref(), Some("openai-compatible"));
    }

    #[test]
    fn request_config_accepts_the_legacy_envelope_without_changing_openrouter_fields() {
        let body = json!({
            "aiProviderConfig": {"aiProvider": "openrouter"},
            "provider": {"ignore": ["some-upstream-provider"]}
        });

        assert_eq!(
            ai_api_config_value(&body)
                .and_then(|value| value.get("aiProvider"))
                .and_then(Value::as_str),
            Some("openrouter")
        );
        assert_eq!(body["provider"]["ignore"][0], "some-upstream-provider");
    }

    #[test]
    fn openrouter_ignored_providers_merge_with_existing_routing_options() {
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            Some(AiApiConfig {
                open_router_ignored_providers: vec![
                    "deepinfra".to_owned(),
                    " together ".to_owned(),
                    "deepinfra".to_owned(),
                ],
                ..AiApiConfig::default()
            }),
        )
        .unwrap();

        let body = api_client.with_openrouter_provider_preferences(&json!({
            "model": "example/model",
            "provider": {
                "data_collection": "deny",
                "ignore": ["openai", "deepinfra"]
            }
        }));

        assert_eq!(body["provider"]["data_collection"], "deny");
        assert_eq!(
            body["provider"]["ignore"],
            json!(["deepinfra", "together", "openai"])
        );
    }

    #[test]
    fn non_openrouter_requests_do_not_receive_provider_preferences() {
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            Some(AiApiConfig {
                ai_api_type: Some("openai-compatible".to_owned()),
                open_router_ignored_providers: vec!["deepinfra".to_owned()],
                ..AiApiConfig::default()
            }),
        )
        .unwrap();
        let original = json!({"model": "example/model"});

        assert_eq!(
            api_client.with_openrouter_provider_preferences(&original),
            original
        );
    }
}
