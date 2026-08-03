use std::time::Duration;

use axum::http::StatusCode;
use reqwest::{Client, RequestBuilder, Response};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    AppState,
    ai_config::{DEFAULT_OPENAI_BASE_URL, EffectiveAiConfig},
    error::{AppError, AppResult},
};

use super::anthropic;

const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const LOCAL_API_KEY_FALLBACK: &str = "local";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    OpenRouter,
    OpenAiCompatible,
    Anthropic,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub ai_provider: Option<String>,
    pub open_ai_compatible_base_url: Option<String>,
    pub open_ai_compatible_embeddings_enabled: bool,
    pub open_ai_compatible_image_generation_enabled: bool,
}

impl Default for AiProviderConfig {
    fn default() -> Self {
        Self {
            ai_provider: None,
            open_ai_compatible_base_url: None,
            open_ai_compatible_embeddings_enabled: true,
            open_ai_compatible_image_generation_enabled: false,
        }
    }
}

#[derive(Clone)]
pub struct Provider {
    client: Client,
    kind: ProviderKind,
    base_url: String,
    api_key: Option<String>,
    application_origin: String,
    embeddings_enabled: bool,
    image_generation_enabled: bool,
}

impl Provider {
    pub fn from_state(state: &AppState, config: Option<&Value>) -> AppResult<Self> {
        let config = config
            .cloned()
            .and_then(|value| serde_json::from_value::<AiProviderConfig>(value).ok());
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
        config: Option<AiProviderConfig>,
    ) -> AppResult<Self> {
        let config = config.unwrap_or_default();
        let kind = match config.ai_provider.as_deref() {
            Some("openai-compatible") => ProviderKind::OpenAiCompatible,
            Some("anthropic") => ProviderKind::Anthropic,
            _ => ProviderKind::OpenRouter,
        };

        let (base_url, api_key) = match kind {
            ProviderKind::OpenRouter => {
                let api_key = server_config.openrouter_api_key.clone().ok_or_else(|| {
                        AppError::Internal(
                            "OpenRouter APIキーが設定されていません。設定画面または `kataru config set openrouter.api-key` で設定してください。".to_owned(),
                        )
                    })?;
                (OPENROUTER_BASE_URL.to_owned(), Some(api_key))
            }
            ProviderKind::OpenAiCompatible => {
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
            ProviderKind::Anthropic => {
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
            embeddings_enabled: config.open_ai_compatible_embeddings_enabled,
            image_generation_enabled: config.open_ai_compatible_image_generation_enabled,
        })
    }

    pub fn is_openrouter(&self) -> bool {
        self.kind == ProviderKind::OpenRouter
    }

    pub fn is_openai_compatible(&self) -> bool {
        self.kind == ProviderKind::OpenAiCompatible
    }

    pub fn is_anthropic(&self) -> bool {
        self.kind == ProviderKind::Anthropic
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

    pub async fn send_json(
        &self,
        path: &str,
        body: &Value,
        timeout_secs: u64,
    ) -> AppResult<Response> {
        let anthropic_body = if self.is_anthropic() && path.trim_matches('/') == "chat/completions"
        {
            Some(anthropic::request_from_openai(body)?)
        } else {
            None
        };
        self.post_json(path, anthropic_body.as_ref().unwrap_or(body), timeout_secs)
            .send()
            .await
            .map_err(map_request_error)
    }
}

pub fn map_request_error(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        let status = StatusCode::from_u16(499).expect("499 is a valid HTTP status code");
        AppError::Upstream("Request aborted".to_owned(), status)
    } else {
        AppError::Http(error)
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
    fn openrouter_remains_the_default_provider() {
        let provider = Provider::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            None,
        )
        .unwrap();

        assert!(provider.is_openrouter());
        assert_eq!(
            provider.endpoint("models"),
            "https://openrouter.ai/api/v1/models"
        );
    }

    #[test]
    fn request_supplied_openai_base_url_is_ignored() {
        let provider = Provider::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            Some(AiProviderConfig {
                ai_provider: Some("openai-compatible".to_owned()),
                open_ai_compatible_base_url: Some("https://attacker.example/v1".to_owned()),
                open_ai_compatible_embeddings_enabled: true,
                open_ai_compatible_image_generation_enabled: false,
            }),
        )
        .unwrap();

        assert!(!provider.is_openrouter());
        assert_eq!(
            provider.endpoint("chat/completions"),
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
        let provider = Provider::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &config,
            Some(AiProviderConfig {
                ai_provider: Some("openai-compatible".to_owned()),
                ..AiProviderConfig::default()
            }),
        )
        .unwrap();
        let request = provider
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
        let provider = Provider::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &server_config(),
            Some(AiProviderConfig {
                ai_provider: Some("anthropic".to_owned()),
                ..AiProviderConfig::default()
            }),
        )
        .unwrap();
        let request = provider
            .post_json(
                "chat/completions",
                &json!({"model": "claude-sonnet-4-6", "messages": []}),
                1,
            )
            .build()
            .unwrap();

        assert!(provider.is_anthropic());
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
}
