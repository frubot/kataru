use std::{
    env, fs,
    io::{self, Read},
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::{HeaderMap, header},
};
use keyring::Entry;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    AppState,
    config::{default_data_dir, portable_data_dir},
    error::{AppError, AppResult},
};

pub const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com/v1";
const LEGACY_OPENAI_BASE_URL: &str = "http://localhost:1234/v1";
const CONFIG_FILE_NAME: &str = "server-config.json";
const KEYRING_SERVICE: &str = "Kataru";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigSource {
    Default,
    Stored,
    Environment,
}

impl std::fmt::Display for ConfigSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Default => "default",
            Self::Stored => "stored",
            Self::Environment => "environment",
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    configured: bool,
    source: Option<ConfigSource>,
    editable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiStatus {
    base_url: String,
    base_url_source: ConfigSource,
    base_url_editable: bool,
    api_key: ApiKeyStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicStatus {
    base_url: String,
    base_url_source: ConfigSource,
    base_url_editable: bool,
    api_key: ApiKeyStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigStatus {
    openrouter: ApiKeyStatus,
    openai: OpenAiStatus,
    anthropic: AnthropicStatus,
    secret_store_available: bool,
}

#[derive(Clone)]
pub struct EffectiveAiConfig {
    pub openrouter_api_key: Option<String>,
    pub openai_base_url: String,
    pub openai_api_key: Option<String>,
    pub anthropic_base_url: String,
    pub anthropic_api_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct PersistedOpenAiConfig {
    base_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct PersistedAnthropicConfig {
    base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct PersistedConfig {
    version: u32,
    openai: PersistedOpenAiConfig,
    anthropic: PersistedAnthropicConfig,
}

impl Default for PersistedConfig {
    fn default() -> Self {
        Self {
            version: 1,
            openai: PersistedOpenAiConfig::default(),
            anthropic: PersistedAnthropicConfig::default(),
        }
    }
}

#[derive(Clone, Default)]
struct EnvironmentConfig {
    openrouter_api_key: Option<String>,
    openai_base_url: Option<String>,
    openai_api_key: Option<String>,
    anthropic_base_url: Option<String>,
    anthropic_api_key: Option<String>,
}

impl EnvironmentConfig {
    fn load() -> AppResult<Self> {
        let openrouter_api_key = nonempty_env("OPENROUTER_API_KEY");
        let standard_openai_api_key = nonempty_env("OPENAI_API_KEY");
        let legacy_openai_api_key = nonempty_env("OPENAI_COMPAT_API_KEY");
        let openai_api_key = standard_openai_api_key
            .clone()
            .or_else(|| legacy_openai_api_key.clone());
        let explicit_base_url =
            nonempty_env("OPENAI_BASE_URL").or_else(|| nonempty_env("OPENAI_COMPAT_BASE_URL"));
        let openai_base_url = explicit_base_url
            .map(|value| normalize_openai_base_url(&value))
            .transpose()?
            .or_else(|| {
                standard_openai_api_key
                    .is_some()
                    .then(|| DEFAULT_OPENAI_BASE_URL.to_owned())
            })
            .or_else(|| {
                legacy_openai_api_key
                    .is_some()
                    .then(|| LEGACY_OPENAI_BASE_URL.to_owned())
            });
        let anthropic_api_key = nonempty_env("ANTHROPIC_API_KEY");
        let anthropic_base_url = nonempty_env("ANTHROPIC_BASE_URL")
            .map(|value| normalize_anthropic_base_url(&value))
            .transpose()?
            .or_else(|| {
                anthropic_api_key
                    .is_some()
                    .then(|| DEFAULT_ANTHROPIC_BASE_URL.to_owned())
            });

        Ok(Self {
            openrouter_api_key,
            openai_base_url,
            openai_api_key,
            anthropic_base_url,
            anthropic_api_key,
        })
    }
}

fn nonempty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

struct KeyringSecretStore {
    namespace: String,
}

impl KeyringSecretStore {
    fn new(data_dir: &Path) -> Self {
        let resolved = fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
        let digest = Sha256::digest(resolved.to_string_lossy().as_bytes());
        Self {
            namespace: format!("{:x}", digest)[..24].to_owned(),
        }
    }

    fn entry(&self, key: &str) -> Result<Entry, String> {
        Entry::new(KEYRING_SERVICE, &format!("{}:{key}", self.namespace))
            .map_err(|error| error.to_string())
    }
}

impl SecretStore for KeyringSecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        match self.entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.entry(key)?
            .set_password(value)
            .map_err(|error| error.to_string())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

struct ManagerInner {
    persisted: PersistedConfig,
    stored_openrouter_api_key: Option<String>,
    stored_openai_api_key: Option<String>,
    stored_anthropic_api_key: Option<String>,
    secret_store_available: bool,
}

#[derive(Clone)]
pub struct AiConfigManager {
    config_path: PathBuf,
    environment: EnvironmentConfig,
    secret_store: Arc<dyn SecretStore>,
    inner: Arc<Mutex<ManagerInner>>,
}

impl AiConfigManager {
    pub fn open(data_dir: &Path) -> AppResult<Self> {
        fs::create_dir_all(data_dir)?;
        let config_path = data_dir.join(CONFIG_FILE_NAME);
        let persisted = load_persisted_config(&config_path)?;
        let environment = EnvironmentConfig::load()?;
        let secret_store: Arc<dyn SecretStore> = Arc::new(KeyringSecretStore::new(data_dir));
        Self::with_parts(config_path, persisted, environment, secret_store)
    }

    fn with_parts(
        config_path: PathBuf,
        persisted: PersistedConfig,
        environment: EnvironmentConfig,
        secret_store: Arc<dyn SecretStore>,
    ) -> AppResult<Self> {
        let persisted_base_url = persisted
            .openai
            .base_url
            .as_deref()
            .map(normalize_openai_base_url)
            .transpose()?;
        let persisted_anthropic_base_url = persisted
            .anthropic
            .base_url
            .as_deref()
            .map(normalize_anthropic_base_url)
            .transpose()?;
        let persisted = PersistedConfig {
            openai: PersistedOpenAiConfig {
                base_url: persisted_base_url,
            },
            anthropic: PersistedAnthropicConfig {
                base_url: persisted_anthropic_base_url,
            },
            ..persisted
        };
        let openai_base_url = environment
            .openai_base_url
            .clone()
            .or_else(|| persisted.openai.base_url.clone())
            .unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_owned());
        let (stored_openrouter_api_key, openrouter_available) =
            read_secret(&*secret_store, "openrouter.api-key");
        let (stored_openai_api_key, openai_available) =
            read_secret(&*secret_store, &openai_secret_key(&openai_base_url));
        let anthropic_base_url = environment
            .anthropic_base_url
            .clone()
            .or_else(|| persisted.anthropic.base_url.clone())
            .unwrap_or_else(|| DEFAULT_ANTHROPIC_BASE_URL.to_owned());
        let (stored_anthropic_api_key, anthropic_available) =
            read_secret(&*secret_store, &anthropic_secret_key(&anthropic_base_url));

        Ok(Self {
            config_path,
            environment,
            secret_store,
            inner: Arc::new(Mutex::new(ManagerInner {
                persisted,
                stored_openrouter_api_key,
                stored_openai_api_key,
                stored_anthropic_api_key,
                secret_store_available: openrouter_available
                    && openai_available
                    && anthropic_available,
            })),
        })
    }

    pub fn effective(&self) -> EffectiveAiConfig {
        let inner = self.inner.lock().expect("AI config lock poisoned");
        EffectiveAiConfig {
            openrouter_api_key: self
                .environment
                .openrouter_api_key
                .clone()
                .or_else(|| inner.stored_openrouter_api_key.clone()),
            openai_base_url: self
                .environment
                .openai_base_url
                .clone()
                .or_else(|| inner.persisted.openai.base_url.clone())
                .unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_owned()),
            openai_api_key: self
                .environment
                .openai_api_key
                .clone()
                .or_else(|| inner.stored_openai_api_key.clone()),
            anthropic_base_url: self
                .environment
                .anthropic_base_url
                .clone()
                .or_else(|| inner.persisted.anthropic.base_url.clone())
                .unwrap_or_else(|| DEFAULT_ANTHROPIC_BASE_URL.to_owned()),
            anthropic_api_key: self
                .environment
                .anthropic_api_key
                .clone()
                .or_else(|| inner.stored_anthropic_api_key.clone()),
        }
    }

    pub fn status(&self) -> AiConfigStatus {
        let inner = self.inner.lock().expect("AI config lock poisoned");
        let base_url = self
            .environment
            .openai_base_url
            .clone()
            .or_else(|| inner.persisted.openai.base_url.clone())
            .unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_owned());
        let base_url_source = if self.environment.openai_base_url.is_some() {
            ConfigSource::Environment
        } else if inner.persisted.openai.base_url.is_some() {
            ConfigSource::Stored
        } else {
            ConfigSource::Default
        };
        let openrouter_source = self
            .environment
            .openrouter_api_key
            .as_ref()
            .map(|_| ConfigSource::Environment)
            .or_else(|| {
                inner
                    .stored_openrouter_api_key
                    .as_ref()
                    .map(|_| ConfigSource::Stored)
            });
        let openai_source = self
            .environment
            .openai_api_key
            .as_ref()
            .map(|_| ConfigSource::Environment)
            .or_else(|| {
                inner
                    .stored_openai_api_key
                    .as_ref()
                    .map(|_| ConfigSource::Stored)
            });
        let anthropic_base_url = self
            .environment
            .anthropic_base_url
            .clone()
            .or_else(|| inner.persisted.anthropic.base_url.clone())
            .unwrap_or_else(|| DEFAULT_ANTHROPIC_BASE_URL.to_owned());
        let anthropic_base_url_source = if self.environment.anthropic_base_url.is_some() {
            ConfigSource::Environment
        } else if inner.persisted.anthropic.base_url.is_some() {
            ConfigSource::Stored
        } else {
            ConfigSource::Default
        };
        let anthropic_source = self
            .environment
            .anthropic_api_key
            .as_ref()
            .map(|_| ConfigSource::Environment)
            .or_else(|| {
                inner
                    .stored_anthropic_api_key
                    .as_ref()
                    .map(|_| ConfigSource::Stored)
            });

        AiConfigStatus {
            openrouter: ApiKeyStatus {
                configured: openrouter_source.is_some(),
                source: openrouter_source,
                editable: self.environment.openrouter_api_key.is_none(),
            },
            openai: OpenAiStatus {
                base_url,
                base_url_source,
                base_url_editable: self.environment.openai_base_url.is_none()
                    && self.environment.openai_api_key.is_none(),
                api_key: ApiKeyStatus {
                    configured: openai_source.is_some(),
                    source: openai_source,
                    editable: self.environment.openai_api_key.is_none(),
                },
            },
            anthropic: AnthropicStatus {
                base_url: anthropic_base_url,
                base_url_source: anthropic_base_url_source,
                base_url_editable: self.environment.anthropic_base_url.is_none()
                    && self.environment.anthropic_api_key.is_none(),
                api_key: ApiKeyStatus {
                    configured: anthropic_source.is_some(),
                    source: anthropic_source,
                    editable: self.environment.anthropic_api_key.is_none(),
                },
            },
            secret_store_available: inner.secret_store_available,
        }
    }

    pub fn set_openrouter_api_key(&self, value: &str) -> AppResult<()> {
        if self.environment.openrouter_api_key.is_some() {
            return Err(environment_override("OPENROUTER_API_KEY"));
        }
        let value = required_secret(value)?;
        self.secret_store
            .set("openrouter.api-key", value)
            .map_err(secret_store_error)?;
        let mut inner = self.inner.lock().expect("AI config lock poisoned");
        inner.stored_openrouter_api_key = Some(value.to_owned());
        inner.secret_store_available = true;
        Ok(())
    }

    pub fn unset_openrouter_api_key(&self) -> AppResult<()> {
        if self.environment.openrouter_api_key.is_some() {
            return Err(environment_override("OPENROUTER_API_KEY"));
        }
        self.secret_store
            .delete("openrouter.api-key")
            .map_err(secret_store_error)?;
        self.inner
            .lock()
            .expect("AI config lock poisoned")
            .stored_openrouter_api_key = None;
        Ok(())
    }

    pub fn set_openai_base_url(&self, value: &str) -> AppResult<()> {
        if self.environment.openai_base_url.is_some() || self.environment.openai_api_key.is_some() {
            return Err(environment_override("OPENAI_BASE_URL / OPENAI_API_KEY"));
        }
        let normalized = normalize_openai_base_url(value)?;
        let old_base_url = self.effective().openai_base_url;
        let changed = old_base_url != normalized;
        {
            let mut inner = self.inner.lock().expect("AI config lock poisoned");
            let mut persisted = inner.persisted.clone();
            persisted.openai.base_url = Some(normalized);
            save_persisted_config(&self.config_path, &persisted)?;
            inner.persisted = persisted;
            if changed {
                inner.stored_openai_api_key = None;
            }
        }
        if changed && let Err(error) = self.secret_store.delete(&openai_secret_key(&old_base_url)) {
            tracing::warn!(%error, "failed to remove obsolete OpenAI credential");
        }
        Ok(())
    }

    pub fn unset_openai_base_url(&self) -> AppResult<()> {
        if self.environment.openai_base_url.is_some() || self.environment.openai_api_key.is_some() {
            return Err(environment_override("OPENAI_BASE_URL / OPENAI_API_KEY"));
        }
        let old_base_url = self.effective().openai_base_url;
        {
            let mut inner = self.inner.lock().expect("AI config lock poisoned");
            let mut persisted = inner.persisted.clone();
            persisted.openai.base_url = None;
            save_persisted_config(&self.config_path, &persisted)?;
            inner.persisted = persisted;
            if old_base_url != DEFAULT_OPENAI_BASE_URL {
                inner.stored_openai_api_key = None;
            }
        }
        if old_base_url != DEFAULT_OPENAI_BASE_URL
            && let Err(error) = self.secret_store.delete(&openai_secret_key(&old_base_url))
        {
            tracing::warn!(%error, "failed to remove obsolete OpenAI credential");
        }
        Ok(())
    }

    pub fn set_openai_api_key(&self, value: &str) -> AppResult<()> {
        if self.environment.openai_api_key.is_some() {
            return Err(environment_override("OPENAI_API_KEY"));
        }
        let value = required_secret(value)?;
        let base_url = self.effective().openai_base_url;
        self.secret_store
            .set(&openai_secret_key(&base_url), value)
            .map_err(secret_store_error)?;
        let mut inner = self.inner.lock().expect("AI config lock poisoned");
        inner.stored_openai_api_key = Some(value.to_owned());
        inner.secret_store_available = true;
        Ok(())
    }

    pub fn unset_openai_api_key(&self) -> AppResult<()> {
        if self.environment.openai_api_key.is_some() {
            return Err(environment_override("OPENAI_API_KEY"));
        }
        let base_url = self.effective().openai_base_url;
        self.secret_store
            .delete(&openai_secret_key(&base_url))
            .map_err(secret_store_error)?;
        self.inner
            .lock()
            .expect("AI config lock poisoned")
            .stored_openai_api_key = None;
        Ok(())
    }

    pub fn set_anthropic_base_url(&self, value: &str) -> AppResult<()> {
        if self.environment.anthropic_base_url.is_some()
            || self.environment.anthropic_api_key.is_some()
        {
            return Err(environment_override(
                "ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY",
            ));
        }
        let normalized = normalize_anthropic_base_url(value)?;
        let old_base_url = self.effective().anthropic_base_url;
        let changed = old_base_url != normalized;
        {
            let mut inner = self.inner.lock().expect("AI config lock poisoned");
            let mut persisted = inner.persisted.clone();
            persisted.anthropic.base_url = Some(normalized);
            save_persisted_config(&self.config_path, &persisted)?;
            inner.persisted = persisted;
            if changed {
                inner.stored_anthropic_api_key = None;
            }
        }
        if changed
            && let Err(error) = self
                .secret_store
                .delete(&anthropic_secret_key(&old_base_url))
        {
            tracing::warn!(%error, "failed to remove obsolete Anthropic credential");
        }
        Ok(())
    }

    pub fn unset_anthropic_base_url(&self) -> AppResult<()> {
        if self.environment.anthropic_base_url.is_some()
            || self.environment.anthropic_api_key.is_some()
        {
            return Err(environment_override(
                "ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY",
            ));
        }
        let old_base_url = self.effective().anthropic_base_url;
        {
            let mut inner = self.inner.lock().expect("AI config lock poisoned");
            let mut persisted = inner.persisted.clone();
            persisted.anthropic.base_url = None;
            save_persisted_config(&self.config_path, &persisted)?;
            inner.persisted = persisted;
            if old_base_url != DEFAULT_ANTHROPIC_BASE_URL {
                inner.stored_anthropic_api_key = None;
            }
        }
        if old_base_url != DEFAULT_ANTHROPIC_BASE_URL
            && let Err(error) = self
                .secret_store
                .delete(&anthropic_secret_key(&old_base_url))
        {
            tracing::warn!(%error, "failed to remove obsolete Anthropic credential");
        }
        Ok(())
    }

    pub fn set_anthropic_api_key(&self, value: &str) -> AppResult<()> {
        if self.environment.anthropic_api_key.is_some() {
            return Err(environment_override("ANTHROPIC_API_KEY"));
        }
        let value = required_secret(value)?;
        let base_url = self.effective().anthropic_base_url;
        self.secret_store
            .set(&anthropic_secret_key(&base_url), value)
            .map_err(secret_store_error)?;
        let mut inner = self.inner.lock().expect("AI config lock poisoned");
        inner.stored_anthropic_api_key = Some(value.to_owned());
        inner.secret_store_available = true;
        Ok(())
    }

    pub fn unset_anthropic_api_key(&self) -> AppResult<()> {
        if self.environment.anthropic_api_key.is_some() {
            return Err(environment_override("ANTHROPIC_API_KEY"));
        }
        let base_url = self.effective().anthropic_base_url;
        self.secret_store
            .delete(&anthropic_secret_key(&base_url))
            .map_err(secret_store_error)?;
        self.inner
            .lock()
            .expect("AI config lock poisoned")
            .stored_anthropic_api_key = None;
        Ok(())
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::with_parts(
            PathBuf::from("server-config.json"),
            PersistedConfig::default(),
            EnvironmentConfig::default(),
            Arc::new(MemorySecretStore::default()),
        )
        .expect("create in-memory AI config")
    }
}

fn read_secret(secret_store: &dyn SecretStore, key: &str) -> (Option<String>, bool) {
    match secret_store.get(key) {
        Ok(value) => (value, true),
        Err(error) => {
            tracing::warn!(%error, "OS credential store is unavailable");
            (None, false)
        }
    }
}

fn required_secret(value: &str) -> AppResult<&str> {
    let value = value.trim();
    if value.is_empty() {
        Err(AppError::BadRequest(
            "APIキーを空にはできません。削除する場合は unset を使用してください。".to_owned(),
        ))
    } else {
        Ok(value)
    }
}

fn environment_override(name: &str) -> AppError {
    AppError::BadRequest(format!(
        "{name} が環境変数で設定されているため変更できません。"
    ))
}

fn secret_store_error(error: String) -> AppError {
    AppError::Internal(format!("OSの資格情報ストアを操作できませんでした: {error}"))
}

fn openai_secret_key(base_url: &str) -> String {
    let digest = Sha256::digest(base_url.as_bytes());
    format!("openai.api-key:{:x}", digest)[..35].to_owned()
}

fn anthropic_secret_key(base_url: &str) -> String {
    let digest = Sha256::digest(base_url.as_bytes());
    format!("anthropic.api-key:{:x}", digest)[..38].to_owned()
}

pub fn normalize_openai_base_url(value: &str) -> AppResult<String> {
    normalize_provider_base_url(value, "OpenAI")
}

pub fn normalize_anthropic_base_url(value: &str) -> AppResult<String> {
    normalize_provider_base_url(value, "Anthropic")
}

fn normalize_provider_base_url(value: &str, provider: &str) -> AppResult<String> {
    let value = value.trim();
    let mut url = Url::parse(value)
        .map_err(|_| AppError::BadRequest(format!("{provider} base URLが不正です。")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::BadRequest(format!(
            "{provider} base URLには http または https を指定してください。"
        )));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::BadRequest(format!(
            "{provider} base URLに認証情報、query、fragmentは指定できません。"
        )));
    }
    if url.scheme() == "http" && !is_loopback_url(&url) {
        return Err(AppError::BadRequest(format!(
            "HTTPの{provider} base URLにはloopbackアドレスだけを指定できます。"
        )));
    }
    let normalized_path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&normalized_path);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn is_loopback_url(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    })
}

fn load_persisted_config(path: &Path) -> AppResult<PersistedConfig> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(PersistedConfig::default()),
        Err(error) => Err(error.into()),
    }
}

fn save_persisted_config(path: &Path, config: &PersistedConfig) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(config)?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, bytes)?;
    fs::rename(temporary_path, path)?;
    Ok(())
}

fn parse_config_data_dir(args: &mut Vec<String>) -> AppResult<PathBuf> {
    let mut data_dir = None;
    let mut portable = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--data-dir" => {
                if portable || data_dir.is_some() {
                    return Err(AppError::BadRequest(
                        "--data-dir と --portable は同時または複数回指定できません。".to_owned(),
                    ));
                }
                if index + 1 >= args.len() {
                    return Err(AppError::BadRequest(
                        "--data-dir には値が必要です。".to_owned(),
                    ));
                }
                data_dir = Some(PathBuf::from(args.remove(index + 1)));
                args.remove(index);
            }
            "--portable" => {
                if portable || data_dir.is_some() {
                    return Err(AppError::BadRequest(
                        "--data-dir と --portable は同時または複数回指定できません。".to_owned(),
                    ));
                }
                portable = true;
                args.remove(index);
            }
            _ => index += 1,
        }
    }
    if portable {
        portable_data_dir()
    } else {
        data_dir.map_or_else(default_data_dir, Ok)
    }
}

pub fn run_cli_command_if_requested() -> AppResult<bool> {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) != Some("config") {
        return Ok(false);
    }
    args.remove(0);
    let data_dir = parse_config_data_dir(&mut args)?;
    if args.is_empty()
        || matches!(args.as_slice(), [help] if matches!(help.as_str(), "help" | "--help" | "-h"))
    {
        print_config_help();
        return Ok(true);
    }
    let manager = AiConfigManager::open(&data_dir)?;

    match args.as_slice() {
        [command] if command == "show" => print_config_status(&manager.status()),
        [command, key] if command == "get" && key == "openai.base-url" => {
            println!("{}", manager.status().openai.base_url);
        }
        [command, key] if command == "get" && key == "anthropic.base-url" => {
            println!("{}", manager.status().anthropic.base_url);
        }
        [command, key, value] if command == "set" && key == "openai.base-url" => {
            manager.set_openai_base_url(value)?;
            println!("openai.base-url を保存しました。Kataruが起動中の場合は再起動してください。");
        }
        [command, key, value] if command == "set" && key == "anthropic.base-url" => {
            manager.set_anthropic_base_url(value)?;
            println!(
                "anthropic.base-url を保存しました。Kataruが起動中の場合は再起動してください。"
            );
        }
        [command, key] if command == "set" && is_api_key(key) => {
            let value = rpassword::prompt_password(format!("{key}: "))?;
            set_api_key(&manager, key, &value)?;
            println!("{key} を保存しました。Kataruが起動中の場合は再起動してください。");
        }
        [command, key, option] if command == "set" && is_api_key(key) && option == "--stdin" => {
            let mut value = String::new();
            io::stdin().read_to_string(&mut value)?;
            set_api_key(&manager, key, &value)?;
            println!("{key} を保存しました。Kataruが起動中の場合は再起動してください。");
        }
        [command, key] if command == "unset" => {
            match key.as_str() {
                "openrouter.api-key" => manager.unset_openrouter_api_key()?,
                "openai.api-key" => manager.unset_openai_api_key()?,
                "openai.base-url" => manager.unset_openai_base_url()?,
                "anthropic.api-key" => manager.unset_anthropic_api_key()?,
                "anthropic.base-url" => manager.unset_anthropic_base_url()?,
                _ => return Err(unsupported_config_key(key)),
            }
            println!("{key} を削除しました。Kataruが起動中の場合は再起動してください。");
        }
        _ => {
            return Err(AppError::BadRequest(
                "config コマンドの引数が不正です。kataru config --help を確認してください。"
                    .to_owned(),
            ));
        }
    }
    Ok(true)
}

fn is_api_key(key: &str) -> bool {
    matches!(
        key,
        "openrouter.api-key" | "openai.api-key" | "anthropic.api-key"
    )
}

fn set_api_key(manager: &AiConfigManager, key: &str, value: &str) -> AppResult<()> {
    match key {
        "openrouter.api-key" => manager.set_openrouter_api_key(value),
        "openai.api-key" => manager.set_openai_api_key(value),
        "anthropic.api-key" => manager.set_anthropic_api_key(value),
        _ => Err(unsupported_config_key(key)),
    }
}

fn unsupported_config_key(key: &str) -> AppError {
    AppError::BadRequest(format!("未対応の設定キーです: {key}"))
}

fn print_config_status(status: &AiConfigStatus) {
    println!(
        "openrouter.api-key: {}{}",
        if status.openrouter.configured {
            "configured"
        } else {
            "not configured"
        },
        status
            .openrouter
            .source
            .map(|source| format!(" ({source})"))
            .unwrap_or_default()
    );
    println!(
        "openai.base-url: {} ({})",
        status.openai.base_url, status.openai.base_url_source
    );
    println!(
        "openai.api-key: {}{}",
        if status.openai.api_key.configured {
            "configured"
        } else {
            "not configured"
        },
        status
            .openai
            .api_key
            .source
            .map(|source| format!(" ({source})"))
            .unwrap_or_default()
    );
    println!(
        "anthropic.base-url: {} ({})",
        status.anthropic.base_url, status.anthropic.base_url_source
    );
    println!(
        "anthropic.api-key: {}{}",
        if status.anthropic.api_key.configured {
            "configured"
        } else {
            "not configured"
        },
        status
            .anthropic
            .api_key
            .source
            .map(|source| format!(" ({source})"))
            .unwrap_or_default()
    );
    if !status.secret_store_available {
        println!("warning: OSの資格情報ストアを利用できません。");
    }
}

fn print_config_help() {
    println!(
        "Kataru config\n\n  config show\n  config get openai.base-url\n  config get anthropic.base-url\n  config set openrouter.api-key [--stdin]\n  config set openai.api-key [--stdin]\n  config set openai.base-url <URL>\n  config set anthropic.api-key [--stdin]\n  config set anthropic.base-url <URL>\n  config unset <KEY>\n\n  --data-dir <PATH>  設定対象のデータ保存先\n  --portable         実行ファイル横の kataru-data を使用"
    );
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyUpdate {
    api_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiUpdate {
    base_url: Option<String>,
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicUpdate {
    base_url: Option<String>,
    api_key: Option<String>,
}

pub async fn get_config(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
) -> AppResult<Json<AiConfigStatus>> {
    require_loopback(peer)?;
    Ok(Json(state.ai_config.status()))
}

pub async fn update_openrouter(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ApiKeyUpdate>,
) -> AppResult<Json<AiConfigStatus>> {
    require_config_write(peer, &headers, &state)?;
    state.ai_config.set_openrouter_api_key(&input.api_key)?;
    Ok(Json(state.ai_config.status()))
}

pub async fn delete_openrouter(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<AiConfigStatus>> {
    require_config_write(peer, &headers, &state)?;
    state.ai_config.unset_openrouter_api_key()?;
    Ok(Json(state.ai_config.status()))
}

pub async fn update_openai(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<OpenAiUpdate>,
) -> AppResult<Json<AiConfigStatus>> {
    require_config_write(peer, &headers, &state)?;
    if input.base_url.is_none() && input.api_key.is_none() {
        return Err(AppError::BadRequest(
            "baseUrl または apiKey を指定してください。".to_owned(),
        ));
    }
    if let Some(base_url) = input.base_url {
        state.ai_config.set_openai_base_url(&base_url)?;
    }
    if let Some(api_key) = input.api_key {
        state.ai_config.set_openai_api_key(&api_key)?;
    }
    Ok(Json(state.ai_config.status()))
}

pub async fn delete_openai_api_key(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<AiConfigStatus>> {
    require_config_write(peer, &headers, &state)?;
    state.ai_config.unset_openai_api_key()?;
    Ok(Json(state.ai_config.status()))
}

pub async fn update_anthropic(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AnthropicUpdate>,
) -> AppResult<Json<AiConfigStatus>> {
    require_config_write(peer, &headers, &state)?;
    if input.base_url.is_none() && input.api_key.is_none() {
        return Err(AppError::BadRequest(
            "baseUrl または apiKey を指定してください。".to_owned(),
        ));
    }
    if let Some(base_url) = input.base_url {
        state.ai_config.set_anthropic_base_url(&base_url)?;
    }
    if let Some(api_key) = input.api_key {
        state.ai_config.set_anthropic_api_key(&api_key)?;
    }
    Ok(Json(state.ai_config.status()))
}

pub async fn delete_anthropic_api_key(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<AiConfigStatus>> {
    require_config_write(peer, &headers, &state)?;
    state.ai_config.unset_anthropic_api_key()?;
    Ok(Json(state.ai_config.status()))
}

fn require_loopback(peer: std::net::SocketAddr) -> AppResult<()> {
    if peer.ip().is_loopback() {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "AI接続設定はこの端末からのみ変更できます。".to_owned(),
        ))
    }
}

fn require_config_write(
    peer: std::net::SocketAddr,
    headers: &HeaderMap,
    state: &AppState,
) -> AppResult<()> {
    require_loopback(peer)?;
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Forbidden("Originヘッダーが必要です。".to_owned()))?;
    if configuration_origin_allowed(origin, &state.configuration_origins) {
        Ok(())
    } else {
        Err(AppError::Forbidden("不正なOriginヘッダーです。".to_owned()))
    }
}

fn configuration_origin_allowed(origin: &str, allowed_origins: &[String]) -> bool {
    allowed_origins
        .iter()
        .any(|allowed| origin.eq_ignore_ascii_case(allowed))
}

#[cfg(test)]
#[derive(Default)]
struct MemorySecretStore {
    values: Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl SecretStore for MemorySecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self
            .values
            .lock()
            .expect("memory secrets lock")
            .get(key)
            .cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.values
            .lock()
            .expect("memory secrets lock")
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.values.lock().expect("memory secrets lock").remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_base_urls() {
        assert_eq!(
            normalize_openai_base_url(" https://api.openai.com/v1/ ").unwrap(),
            DEFAULT_OPENAI_BASE_URL
        );
        assert_eq!(
            normalize_openai_base_url("http://127.0.0.1:1234/v1/").unwrap(),
            "http://127.0.0.1:1234/v1"
        );
    }

    #[test]
    fn rejects_unsafe_base_urls() {
        assert!(normalize_openai_base_url("ftp://localhost/v1").is_err());
        assert!(normalize_openai_base_url("http://example.com/v1").is_err());
        assert!(normalize_openai_base_url("https://user:secret@example.com/v1").is_err());
        assert!(normalize_openai_base_url("https://example.com/v1?key=value").is_err());
    }

    #[test]
    fn changing_base_url_unbinds_the_stored_key() {
        let directory = tempfile::tempdir().unwrap();
        let secret_store: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::default());
        let manager = AiConfigManager::with_parts(
            directory.path().join(CONFIG_FILE_NAME),
            PersistedConfig::default(),
            EnvironmentConfig::default(),
            secret_store,
        )
        .unwrap();
        manager.set_openai_api_key("secret").unwrap();
        assert!(manager.status().openai.api_key.configured);

        manager
            .set_openai_base_url("http://127.0.0.1:1234/v1")
            .unwrap();
        assert!(!manager.status().openai.api_key.configured);

        manager.set_openai_api_key("replacement").unwrap();
        manager
            .set_openai_base_url("http://127.0.0.1:1234/v1/")
            .unwrap();
        assert!(manager.status().openai.api_key.configured);

        manager
            .set_openai_base_url("http://127.0.0.1:1235/v1")
            .unwrap();
        assert!(!manager.status().openai.api_key.configured);
    }

    #[test]
    fn environment_values_are_effective_and_read_only() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AiConfigManager::with_parts(
            directory.path().join(CONFIG_FILE_NAME),
            PersistedConfig {
                openai: PersistedOpenAiConfig {
                    base_url: Some("http://127.0.0.1:1234/v1".to_owned()),
                },
                ..PersistedConfig::default()
            },
            EnvironmentConfig {
                openrouter_api_key: Some("openrouter-env".to_owned()),
                openai_base_url: Some(DEFAULT_OPENAI_BASE_URL.to_owned()),
                openai_api_key: Some("openai-env".to_owned()),
                anthropic_base_url: Some(DEFAULT_ANTHROPIC_BASE_URL.to_owned()),
                anthropic_api_key: Some("anthropic-env".to_owned()),
            },
            Arc::new(MemorySecretStore::default()),
        )
        .unwrap();

        let effective = manager.effective();
        assert_eq!(
            effective.openrouter_api_key.as_deref(),
            Some("openrouter-env")
        );
        assert_eq!(effective.openai_base_url, DEFAULT_OPENAI_BASE_URL);
        assert_eq!(effective.openai_api_key.as_deref(), Some("openai-env"));
        assert_eq!(effective.anthropic_base_url, DEFAULT_ANTHROPIC_BASE_URL);
        assert_eq!(
            effective.anthropic_api_key.as_deref(),
            Some("anthropic-env")
        );
        let status = manager.status();
        assert_eq!(status.openai.base_url_source, ConfigSource::Environment);
        assert!(!status.openai.base_url_editable);
        assert!(!status.openai.api_key.editable);
        assert!(!status.openrouter.editable);
        assert!(!status.anthropic.base_url_editable);
        assert!(!status.anthropic.api_key.editable);
    }

    #[test]
    fn failed_file_write_does_not_change_the_effective_base_url() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AiConfigManager::with_parts(
            directory.path().join("missing").join(CONFIG_FILE_NAME),
            PersistedConfig::default(),
            EnvironmentConfig::default(),
            Arc::new(MemorySecretStore::default()),
        )
        .unwrap();

        assert!(
            manager
                .set_openai_base_url("http://127.0.0.1:1234/v1")
                .is_err()
        );
        assert_eq!(manager.effective().openai_base_url, DEFAULT_OPENAI_BASE_URL);
    }

    #[test]
    fn config_writes_require_loopback_and_an_allowed_origin() {
        assert!(require_loopback("127.0.0.1:1234".parse().unwrap()).is_ok());
        assert!(require_loopback("192.168.1.20:1234".parse().unwrap()).is_err());
        let allowed = [
            "http://127.0.0.1:37371".to_owned(),
            "http://127.0.0.1:3000".to_owned(),
        ];
        assert!(configuration_origin_allowed(
            "http://127.0.0.1:3000",
            &allowed
        ));
        assert!(!configuration_origin_allowed(
            "https://attacker.example",
            &allowed
        ));
    }

    #[test]
    fn status_serialization_never_contains_api_keys() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AiConfigManager::with_parts(
            directory.path().join(CONFIG_FILE_NAME),
            PersistedConfig::default(),
            EnvironmentConfig::default(),
            Arc::new(MemorySecretStore::default()),
        )
        .unwrap();
        manager
            .set_openrouter_api_key("openrouter-do-not-return")
            .unwrap();
        manager.set_openai_api_key("openai-do-not-return").unwrap();
        manager
            .set_anthropic_api_key("anthropic-do-not-return")
            .unwrap();

        let serialized = serde_json::to_string(&manager.status()).unwrap();
        assert!(!serialized.contains("openrouter-do-not-return"));
        assert!(!serialized.contains("openai-do-not-return"));
        assert!(!serialized.contains("anthropic-do-not-return"));
    }

    #[test]
    fn changing_anthropic_base_url_unbinds_the_stored_key() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AiConfigManager::with_parts(
            directory.path().join(CONFIG_FILE_NAME),
            PersistedConfig::default(),
            EnvironmentConfig::default(),
            Arc::new(MemorySecretStore::default()),
        )
        .unwrap();
        manager.set_anthropic_api_key("secret").unwrap();
        assert!(manager.status().anthropic.api_key.configured);

        manager
            .set_anthropic_base_url("http://127.0.0.1:8080/v1")
            .unwrap();
        assert!(!manager.status().anthropic.api_key.configured);
    }
}
