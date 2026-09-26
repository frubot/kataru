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
    ai_config::{
        ConnectionKind, DEFAULT_CONNECTION_ID, DEFAULT_OPENAI_BASE_URL, EffectiveAiConfig,
        EffectiveConnection,
    },
    error::{AppError, AppResult},
};

use super::anthropic;

const LOCAL_API_KEY_FALLBACK: &str = "local";

pub fn ai_api_config_value(body: &Value) -> Option<&Value> {
    body.get("aiApiConfig")
        .filter(|value| !value.is_null())
        .or_else(|| {
            body.get("aiProviderConfig")
                .filter(|value| !value.is_null())
        })
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiApiConfig {
    /// Preferred connection id. Legacy `aiApiType` / `aiProvider` values are
    /// the built-in connection ids, so they keep resolving unchanged.
    /// Provider filtering and feature flags always come from the stored
    /// connection record, never from the request body.
    #[serde(alias = "aiApiType", alias = "aiProvider", alias = "connection_id")]
    pub connection_id: Option<String>,
}

#[derive(Clone)]
pub struct AiApiClient {
    client: Client,
    connection_id: String,
    kind: ConnectionKind,
    base_url: String,
    api_key: Option<String>,
    application_origin: String,
    ignored_providers: Vec<String>,
    embeddings_enabled: bool,
    image_generation_enabled: bool,
    tts_enabled: bool,
}

impl AiApiClient {
    pub fn from_state(state: &AppState, config: Option<&Value>) -> AppResult<Self> {
        Self::from_state_for(state, config, None)
    }

    /// Builds a client for `connection_id` when given (a per-role or
    /// per-entity override), falling back to the config's `connectionId`.
    pub fn from_state_for(
        state: &AppState,
        config: Option<&Value>,
        connection_id: Option<&str>,
    ) -> AppResult<Self> {
        let config = config
            .cloned()
            .and_then(|value| serde_json::from_value::<AiApiConfig>(value).ok());
        Self::resolve_for(
            state.http_client.clone(),
            &state.application_origin,
            &state.ai_config.effective(),
            config,
            connection_id,
        )
    }

    pub fn resolve(
        client: Client,
        application_origin: impl AsRef<str>,
        server_config: &EffectiveAiConfig,
        config: Option<AiApiConfig>,
    ) -> AppResult<Self> {
        Self::resolve_for(client, application_origin, server_config, config, None)
    }

    /// Resolution order: the explicit `connection_id` argument, then
    /// `config.connection_id`, then the built-in OpenRouter connection.
    pub fn resolve_for(
        client: Client,
        application_origin: impl AsRef<str>,
        server_config: &EffectiveAiConfig,
        config: Option<AiApiConfig>,
        connection_id: Option<&str>,
    ) -> AppResult<Self> {
        let config = config.unwrap_or_default();
        let requested = connection_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                config
                    .connection_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            });
        let id = requested.unwrap_or(DEFAULT_CONNECTION_ID);
        let connection = server_config
            .connection(id)
            .ok_or_else(|| AppError::BadRequest(format!("不明な接続先です: {id}")))?;

        // The upstream host and API key are server-owned. In particular, never
        // use a base URL supplied in a request, because doing so could send the
        // server API key to an attacker-controlled host.
        let api_key = connection.api_key.clone().or_else(|| {
            (connection.kind == ConnectionKind::OpenAiCompatible
                && connection.base_url != DEFAULT_OPENAI_BASE_URL)
                .then(|| LOCAL_API_KEY_FALLBACK.to_owned())
        });
        if api_key.is_none()
            && !matches!(
                connection.kind,
                ConnectionKind::Voicevox | ConnectionKind::Irodori
            )
        {
            return Err(missing_api_key_error(connection));
        }

        Ok(Self {
            client,
            connection_id: connection.id.clone(),
            kind: connection.kind,
            base_url: connection.base_url.clone(),
            api_key,
            application_origin: application_origin.as_ref().to_owned(),
            ignored_providers: normalize_provider_slugs(connection.ignored_providers.clone()),
            embeddings_enabled: connection.embeddings_enabled,
            image_generation_enabled: connection.image_generation_enabled,
            tts_enabled: connection.tts_enabled,
        })
    }

    pub fn is_openrouter(&self) -> bool {
        self.kind == ConnectionKind::OpenRouter
    }

    pub fn is_openai_compatible(&self) -> bool {
        self.kind == ConnectionKind::OpenAiCompatible
    }

    pub fn is_anthropic(&self) -> bool {
        self.kind == ConnectionKind::Anthropic
    }

    pub fn is_typesafe(&self) -> bool {
        self.kind == ConnectionKind::Typesafe
    }

    pub fn is_voicevox(&self) -> bool {
        self.kind == ConnectionKind::Voicevox
    }

    pub fn is_irodori(&self) -> bool {
        self.kind == ConnectionKind::Irodori
    }

    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn embeddings_enabled(&self) -> bool {
        self.is_openrouter() || (self.is_openai_compatible() && self.embeddings_enabled)
    }

    pub fn image_generation_enabled(&self) -> bool {
        self.is_openrouter() || (self.is_openai_compatible() && self.image_generation_enabled)
    }

    pub fn tts_enabled(&self) -> bool {
        self.is_openrouter()
            || self.is_voicevox()
            || self.is_irodori()
            || (self.is_openai_compatible() && self.tts_enabled)
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

    /// System One (Jev) evaluations live outside the chat surface: TypeSafe
    /// serves `POST /v1/systemone`, while OpenRouter normalizes the same
    /// contract under the Decisions API at `/api/alpha/decisions`.
    pub fn decisions_endpoint(&self) -> String {
        if self.is_openrouter() {
            format!(
                "{}/alpha/decisions",
                self.base_url.trim_end_matches('/').trim_end_matches("/v1")
            )
        } else {
            self.endpoint("systemone")
        }
    }

    fn authorized_request(&self, request: RequestBuilder) -> RequestBuilder {
        let mut request = request;
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

    pub fn post(&self, path: &str, timeout: Duration) -> RequestBuilder {
        self.authorized_request(self.client.post(self.endpoint(path)).timeout(timeout))
    }

    /// Builds a POST against an absolute URL for endpoints outside the
    /// connection's versioned base path (e.g. the OpenRouter decisions API).
    pub fn post_url(&self, url: &str, timeout: Duration) -> RequestBuilder {
        self.authorized_request(self.client.post(url).timeout(timeout))
    }

    pub fn get(&self, path: &str, timeout: Duration) -> RequestBuilder {
        self.authorized_request(self.client.get(self.endpoint(path)).timeout(timeout))
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

    /// Sends a multipart/form-data POST (e.g. the OpenAI images edits API).
    pub async fn send_multipart(
        &self,
        path: &str,
        form: reqwest::multipart::Form,
        timeout_secs: u64,
    ) -> AppResult<Response> {
        let started_at = Instant::now();
        let result = self
            .post(path, Duration::from_secs(timeout_secs))
            .multipart(form)
            .send()
            .await;
        self.finish_request(path, started_at, result)
    }

    /// Sends JSON to an absolute URL. Provider routing preferences are not
    /// applied: the targets of this method (e.g. the OpenRouter decisions
    /// API) do not support them.
    pub async fn send_json_url(
        &self,
        url: &str,
        operation: &str,
        body: &Value,
        timeout_secs: u64,
    ) -> AppResult<Response> {
        let started_at = Instant::now();
        let result = self
            .post_url(url, Duration::from_secs(timeout_secs))
            .json(body)
            .send()
            .await;
        self.finish_request(operation, started_at, result)
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

fn missing_api_key_error(connection: &EffectiveConnection) -> AppError {
    let message = if connection.builtin {
        match connection.kind {
            ConnectionKind::OpenRouter => "OpenRouter APIキーが設定されていません。設定画面または `kataru config set openrouter.api-key` で設定してください。".to_owned(),
            ConnectionKind::OpenAiCompatible => "OpenAI APIキーが設定されていません。設定画面または `kataru config set openai.api-key` で設定してください。".to_owned(),
            ConnectionKind::Anthropic => "Anthropic APIキーが設定されていません。設定画面または `kataru config set anthropic.api-key` で設定してください。".to_owned(),
            ConnectionKind::Typesafe => "TypeSafe AI APIキーが設定されていません。設定画面または環境変数 TYPESAFE_API_KEY で設定してください。".to_owned(),
            ConnectionKind::Voicevox => "VOICEVOX接続の設定が不正です。".to_owned(),
            ConnectionKind::Irodori => "Irodori TTS接続の設定が不正です。".to_owned(),
        }
    } else {
        format!(
            "接続「{}」のAPIキーが設定されていません。設定画面で設定してください。",
            connection.name
        )
    };
    AppError::Internal(message)
}

pub(crate) fn normalize_provider_slugs(values: Vec<String>) -> Vec<String> {
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
        "images/edits" => "images/edits",
        "decisions" => "decisions",
        "audio/speech" => "audio/speech",
        "audio_query" => "audio_query",
        "synthesis" => "synthesis",
        "speakers" => "speakers",
        "v1/audio/speech" => "v1/audio/speech",
        "v1/audio/voices" => "v1/audio/voices",
        "v1/models" => "v1/models",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_config::{
        ANTHROPIC_CONNECTION_ID, ConfigSource, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENAI_BASE_URL,
        DEFAULT_VOICEVOX_BASE_URL, EffectiveConnection, OPENAI_COMPATIBLE_CONNECTION_ID,
        OPENROUTER_CONNECTION_ID,
    };
    use serde_json::json;

    fn builtin(
        id: &str,
        kind: ConnectionKind,
        base_url: &str,
        api_key: Option<&str>,
    ) -> EffectiveConnection {
        EffectiveConnection {
            id: id.to_owned(),
            name: kind.label().to_owned(),
            kind,
            base_url: base_url.to_owned(),
            api_key: api_key.map(str::to_owned),
            source: api_key.map(|_| ConfigSource::Stored),
            builtin: true,
            editable: true,
            deletable: false,
            base_url_editable: !kind.has_fixed_base_url(),
            listed: true,
            embeddings_enabled: true,
            image_generation_enabled: false,
            tts_enabled: false,
            ignored_providers: Vec::new(),
        }
    }

    fn server_config() -> EffectiveAiConfig {
        EffectiveAiConfig {
            connections: vec![
                builtin(
                    OPENROUTER_CONNECTION_ID,
                    ConnectionKind::OpenRouter,
                    crate::ai_config::OPENROUTER_BASE_URL,
                    Some("openrouter-secret"),
                ),
                builtin(
                    OPENAI_COMPATIBLE_CONNECTION_ID,
                    ConnectionKind::OpenAiCompatible,
                    DEFAULT_OPENAI_BASE_URL,
                    Some("openai-secret"),
                ),
                builtin(
                    ANTHROPIC_CONNECTION_ID,
                    ConnectionKind::Anthropic,
                    DEFAULT_ANTHROPIC_BASE_URL,
                    Some("anthropic-secret"),
                ),
            ],
        }
    }

    #[test]
    fn upstream_log_operation_is_allowlisted_and_strips_queries() {
        assert_eq!(
            safe_upstream_operation("models?output_modalities=text"),
            "models"
        );
        assert_eq!(safe_upstream_operation("audio/speech"), "audio/speech");
        assert_eq!(safe_upstream_operation("audio_query"), "audio_query");
        assert_eq!(safe_upstream_operation("synthesis"), "synthesis");
        assert_eq!(safe_upstream_operation("speakers"), "speakers");
        assert_eq!(
            safe_upstream_operation("private/secret-value?api_key=secret"),
            "other"
        );
    }

    #[test]
    fn openrouter_remains_the_default_connection() {
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            None,
        )
        .unwrap();

        assert!(api_client.is_openrouter());
        assert_eq!(api_client.connection_id(), "openrouter");
        assert_eq!(
            api_client.endpoint("models"),
            "https://openrouter.ai/api/v1/models"
        );
    }

    #[test]
    fn decisions_endpoint_escapes_the_versioned_openrouter_base() {
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            None,
        )
        .unwrap();

        assert_eq!(
            api_client.decisions_endpoint(),
            "https://openrouter.ai/api/alpha/decisions"
        );
    }

    #[test]
    fn decisions_endpoint_uses_systemone_elsewhere() {
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            Some(AiApiConfig {
                connection_id: Some("openai-compatible".to_owned()),
            }),
        )
        .unwrap();

        assert_eq!(
            api_client.decisions_endpoint(),
            "https://api.openai.com/v1/systemone"
        );
    }

    #[test]
    fn request_supplied_openai_base_url_is_ignored() {
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            Some(AiApiConfig {
                connection_id: Some("openai-compatible".to_owned()),
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
            connections: vec![EffectiveConnection {
                id: "cx_local".to_owned(),
                name: "ローカル".to_owned(),
                kind: ConnectionKind::OpenAiCompatible,
                base_url: "http://127.0.0.1:1234/v1".to_owned(),
                api_key: None,
                source: None,
                builtin: false,
                editable: true,
                deletable: true,
                base_url_editable: true,
                listed: true,
                embeddings_enabled: true,
                image_generation_enabled: false,
                tts_enabled: false,
                ignored_providers: Vec::new(),
            }],
        };
        let api_client = AiApiClient::resolve_for(
            Client::new(),
            "http://127.0.0.1:37371",
            &config,
            None,
            Some("cx_local"),
        )
        .unwrap();
        let request = api_client
            .get("models", Duration::from_secs(1))
            .build()
            .unwrap();

        assert_eq!(api_client.connection_id(), "cx_local");
        assert_eq!(
            request.headers().get("authorization").unwrap(),
            "Bearer local"
        );
    }

    #[test]
    fn voicevox_resolves_without_an_api_key() {
        let config = EffectiveAiConfig {
            connections: vec![EffectiveConnection {
                id: "voicevox".to_owned(),
                name: "VOICEVOX".to_owned(),
                kind: ConnectionKind::Voicevox,
                base_url: DEFAULT_VOICEVOX_BASE_URL.to_owned(),
                api_key: None,
                source: None,
                builtin: true,
                editable: true,
                deletable: false,
                base_url_editable: true,
                listed: true,
                embeddings_enabled: false,
                image_generation_enabled: false,
                tts_enabled: false,
                ignored_providers: Vec::new(),
            }],
        };

        let api_client = AiApiClient::resolve_for(
            Client::new(),
            "http://127.0.0.1:37371",
            &config,
            None,
            Some("voicevox"),
        )
        .unwrap();
        let request = api_client
            .post("synthesis", Duration::from_secs(1))
            .build()
            .unwrap();

        assert!(api_client.is_voicevox());
        assert!(api_client.tts_enabled());
        assert_eq!(request.url().as_str(), "http://127.0.0.1:50021/synthesis");
        assert!(request.headers().get("authorization").is_none());
    }

    #[test]
    fn anthropic_uses_native_endpoint_and_headers() {
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            Some(AiApiConfig {
                connection_id: Some("anthropic".to_owned()),
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
    fn api_config_accepts_connection_id_and_legacy_type_names() {
        let canonical = serde_json::from_value::<AiApiConfig>(json!({
            "connectionId": "cx_123"
        }))
        .unwrap();
        let legacy_type = serde_json::from_value::<AiApiConfig>(json!({
            "aiApiType": "anthropic"
        }))
        .unwrap();
        let legacy_provider = serde_json::from_value::<AiApiConfig>(json!({
            "aiProvider": "openai-compatible"
        }))
        .unwrap();
        let snake_case = serde_json::from_value::<AiApiConfig>(json!({
            "connection_id": "cx_abc"
        }))
        .unwrap();

        assert_eq!(canonical.connection_id.as_deref(), Some("cx_123"));
        assert_eq!(legacy_type.connection_id.as_deref(), Some("anthropic"));
        assert_eq!(
            legacy_provider.connection_id.as_deref(),
            Some("openai-compatible")
        );
        assert_eq!(snake_case.connection_id.as_deref(), Some("cx_abc"));
    }

    #[test]
    fn unknown_connection_ids_are_rejected() {
        let error = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            Some(AiApiConfig {
                connection_id: Some("cx_missing".to_owned()),
            }),
        )
        .err()
        .expect("unknown connection must fail");

        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(error.to_string().contains("cx_missing"));
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
    fn openrouter_ignored_providers_come_from_the_connection_record() {
        let mut config = server_config();
        config.connections[0].ignored_providers = vec![
            "deepinfra".to_owned(),
            " together ".to_owned(),
            "deepinfra".to_owned(),
        ];
        let api_client =
            AiApiClient::resolve(Client::new(), "http://127.0.0.1:37371", &config, None).unwrap();

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
        let mut config = server_config();
        config.connections[1].ignored_providers = vec!["deepinfra".to_owned()];
        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &config,
            Some(AiApiConfig {
                connection_id: Some("openai-compatible".to_owned()),
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
