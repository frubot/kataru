use std::{
    collections::HashMap,
    env, fs,
    io::{self, Read},
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::{ConnectInfo, Path as AxumPath, State},
    http::{HeaderMap, header},
};
use keyring::Entry;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    AppState,
    ai::api_client::normalize_provider_slugs,
    config::{default_data_dir, portable_data_dir},
    error::{AppError, AppResult},
};

pub const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
pub const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com/v1";
pub const DEFAULT_TYPESAFE_BASE_URL: &str = "https://api.typesafe.ai/v1";
pub const DEFAULT_VOICEVOX_BASE_URL: &str = "http://127.0.0.1:50021";
pub const DEFAULT_IRODORI_BASE_URL: &str = "http://127.0.0.1:8088";
const CONFIG_FILE_NAME: &str = "server-config.json";
const KEYRING_SERVICE: &str = "Kataru";

/// Built-in connection ids keep the old `aiApiType` values so stored data and
/// legacy requests resolve without migration.
pub const OPENROUTER_CONNECTION_ID: &str = "openrouter";
pub const OPENAI_COMPATIBLE_CONNECTION_ID: &str = "openai-compatible";
pub const ANTHROPIC_CONNECTION_ID: &str = "anthropic";
pub const TYPESAFE_CONNECTION_ID: &str = "typesafe";
pub const DEFAULT_CONNECTION_ID: &str = OPENROUTER_CONNECTION_ID;
const CUSTOM_ID_PREFIX: &str = "cx_";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ConnectionKind {
    #[serde(rename = "openrouter")]
    OpenRouter,
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "typesafe")]
    Typesafe,
    #[serde(rename = "voicevox")]
    Voicevox,
    #[serde(rename = "irodori")]
    Irodori,
}

impl ConnectionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenRouter => "openrouter",
            Self::OpenAiCompatible => "openai-compatible",
            Self::Anthropic => "anthropic",
            Self::Typesafe => "typesafe",
            Self::Voicevox => "voicevox",
            Self::Irodori => "irodori",
        }
    }

    /// Display label used as the default connection name.
    pub fn label(self) -> &'static str {
        match self {
            Self::OpenRouter => "OpenRouter",
            Self::OpenAiCompatible => "OpenAI 互換",
            Self::Anthropic => "Anthropic 互換",
            Self::Typesafe => "TypeSafe AI",
            Self::Voicevox => "VOICEVOX",
            Self::Irodori => "Irodori TTS",
        }
    }

    /// The id of the built-in connection for this kind. Built-in ids are the
    /// same strings as the legacy `aiApiType` values.
    pub fn builtin_id(self) -> &'static str {
        self.as_str()
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "openrouter" => Some(Self::OpenRouter),
            "openai-compatible" => Some(Self::OpenAiCompatible),
            "anthropic" => Some(Self::Anthropic),
            "typesafe" => Some(Self::Typesafe),
            "voicevox" => Some(Self::Voicevox),
            "irodori" => Some(Self::Irodori),
            _ => None,
        }
    }

    pub(crate) fn default_base_url(self) -> &'static str {
        match self {
            Self::OpenRouter => OPENROUTER_BASE_URL,
            Self::OpenAiCompatible => DEFAULT_OPENAI_BASE_URL,
            Self::Anthropic => DEFAULT_ANTHROPIC_BASE_URL,
            Self::Typesafe => DEFAULT_TYPESAFE_BASE_URL,
            Self::Voicevox => DEFAULT_VOICEVOX_BASE_URL,
            Self::Irodori => DEFAULT_IRODORI_BASE_URL,
        }
    }

    fn api_name(self) -> &'static str {
        match self {
            Self::OpenRouter => "OpenRouter",
            Self::OpenAiCompatible => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Typesafe => "TypeSafe",
            Self::Voicevox => "VOICEVOX",
            Self::Irodori => "Irodori TTS",
        }
    }

    /// OpenRouter connections always talk to the fixed upstream.
    pub(crate) fn has_fixed_base_url(self) -> bool {
        matches!(self, Self::OpenRouter)
    }

    /// Environment variable name that locks this built-in connection's API key.
    fn env_api_key_name(self) -> &'static str {
        match self {
            Self::OpenRouter => "OPENROUTER_API_KEY",
            Self::OpenAiCompatible => "OPENAI_API_KEY",
            Self::Anthropic => "ANTHROPIC_API_KEY",
            Self::Typesafe => "TYPESAFE_API_KEY",
            Self::Voicevox => "VOICEVOX_API_KEY",
            Self::Irodori => "IRODORI_API_KEY",
        }
    }
}

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
pub struct ConnectionStatus {
    id: String,
    name: String,
    kind: ConnectionKind,
    base_url: Option<String>,
    base_url_source: Option<ConfigSource>,
    base_url_editable: bool,
    api_key: ApiKeyStatus,
    builtin: bool,
    editable: bool,
    deletable: bool,
    embeddings_enabled: bool,
    image_generation_enabled: bool,
    tts_enabled: bool,
    ignored_providers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsStatus {
    pub connections: Vec<ConnectionStatus>,
    pub secret_store_available: bool,
}

#[derive(Clone)]
pub struct EffectiveConnection {
    pub id: String,
    pub name: String,
    pub kind: ConnectionKind,
    pub base_url: String,
    pub api_key: Option<String>,
    /// Source of the effective API key (`stored` / `environment`).
    pub source: Option<ConfigSource>,
    pub builtin: bool,
    pub editable: bool,
    pub deletable: bool,
    pub base_url_editable: bool,
    /// Whether the connection appears in the settings list. Unlisted built-ins
    /// are pristine placeholders that were never configured.
    pub listed: bool,
    pub embeddings_enabled: bool,
    pub image_generation_enabled: bool,
    pub tts_enabled: bool,
    pub ignored_providers: Vec<String>,
}

#[derive(Clone)]
pub struct EffectiveAiConfig {
    pub connections: Vec<EffectiveConnection>,
}

impl EffectiveAiConfig {
    pub fn connection(&self, id: &str) -> Option<&EffectiveConnection> {
        self.connections
            .iter()
            .find(|connection| connection.id == id)
    }
}

/// A connection record as persisted in `server-config.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PersistedConnection {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    kind: Option<ConnectionKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    embeddings_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_generation_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tts_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ignored_providers: Option<Vec<String>>,
}

/// v1 shape kept only so old files can be read and migrated.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct PersistedProviderSection {
    base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct PersistedConfig {
    /// Files written before versioning have no `version` field; the
    /// field-level default of 0 marks them as v1 so their provider base URL
    /// overrides are migrated.
    #[serde(default)]
    version: u32,
    #[serde(skip_serializing)]
    openai: PersistedProviderSection,
    #[serde(skip_serializing)]
    anthropic: PersistedProviderSection,
    connections: Vec<PersistedConnection>,
}

impl Default for PersistedConfig {
    fn default() -> Self {
        Self {
            version: 2,
            openai: PersistedProviderSection::default(),
            anthropic: PersistedProviderSection::default(),
            connections: Vec::new(),
        }
    }
}

impl PersistedConfig {
    /// Migrates v1 files and guarantees the three built-in connections exist.
    fn normalized(mut self) -> AppResult<Self> {
        if self.version < 2 {
            // v1 stored only the OpenAI / Anthropic base URL overrides.
            let openai_base_url = self.openai.base_url.take();
            let anthropic_base_url = self.anthropic.base_url.take();
            let openai = ensure_builtin(&mut self.connections, ConnectionKind::OpenAiCompatible);
            if openai.base_url.is_none() {
                openai.base_url = openai_base_url;
            }
            let anthropic = ensure_builtin(&mut self.connections, ConnectionKind::Anthropic);
            if anthropic.base_url.is_none() {
                anthropic.base_url = anthropic_base_url;
            }
        }
        ensure_builtin(&mut self.connections, ConnectionKind::OpenRouter);
        ensure_builtin(&mut self.connections, ConnectionKind::OpenAiCompatible);
        ensure_builtin(&mut self.connections, ConnectionKind::Anthropic);
        ensure_builtin(&mut self.connections, ConnectionKind::Typesafe);
        ensure_builtin(&mut self.connections, ConnectionKind::Voicevox);
        ensure_builtin(&mut self.connections, ConnectionKind::Irodori);
        self.version = 2;

        let mut seen = HashMap::new();
        self.connections.retain(|record| {
            !record.id.is_empty()
                && (record.kind.is_some() || is_builtin_id(&record.id))
                && seen.insert(record.id.clone(), ()).is_none()
        });
        for record in &mut self.connections {
            if is_builtin_id(&record.id) {
                // Built-in ids pin the kind so legacy data cannot mix kinds.
                record.kind = Some(ConnectionKind::parse(&record.id).expect("builtin id parses"));
            }
            let kind = record.kind.expect("kind checked above");
            if kind.has_fixed_base_url() {
                record.base_url = None;
            } else if let Some(base_url) = &record.base_url {
                record.base_url = Some(normalize_connection_base_url(base_url, kind)?);
            }
            if let Some(name) = &record.name {
                record.name = normalize_name(name);
            }
            if let Some(providers) = &record.ignored_providers {
                record.ignored_providers = Some(normalize_provider_slugs(providers.clone()));
            }
        }
        Ok(self)
    }
}

fn ensure_builtin(
    connections: &mut Vec<PersistedConnection>,
    kind: ConnectionKind,
) -> &mut PersistedConnection {
    let id = kind.builtin_id();
    if !connections.iter().any(|record| record.id == id) {
        connections.push(PersistedConnection {
            id: id.to_owned(),
            kind: Some(kind),
            ..PersistedConnection::default()
        });
    }
    let index = connections
        .iter()
        .position(|record| record.id == id)
        .expect("built-in connection was just inserted");
    &mut connections[index]
}

fn is_builtin_id(id: &str) -> bool {
    ConnectionKind::parse(id).is_some()
}

fn normalize_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    (!trimmed.is_empty()).then(|| trimmed.chars().take(120).collect())
}

#[derive(Clone, Default)]
struct EnvironmentConfig {
    openrouter_api_key: Option<String>,
    openai_base_url: Option<String>,
    openai_api_key: Option<String>,
    anthropic_base_url: Option<String>,
    anthropic_api_key: Option<String>,
    typesafe_base_url: Option<String>,
    typesafe_api_key: Option<String>,
    irodori_base_url: Option<String>,
    irodori_api_key: Option<String>,
}

impl EnvironmentConfig {
    fn load() -> AppResult<Self> {
        let openrouter_api_key = nonempty_env("OPENROUTER_API_KEY");
        let openai_api_key = nonempty_env("OPENAI_API_KEY");
        let openai_base_url = nonempty_env("OPENAI_BASE_URL")
            .map(|value| normalize_api_base_url(&value, "OpenAI"))
            .transpose()?
            .or_else(|| {
                openai_api_key
                    .is_some()
                    .then(|| DEFAULT_OPENAI_BASE_URL.to_owned())
            });
        let anthropic_api_key = nonempty_env("ANTHROPIC_API_KEY");
        let anthropic_base_url = nonempty_env("ANTHROPIC_BASE_URL")
            .map(|value| normalize_api_base_url(&value, "Anthropic"))
            .transpose()?
            .or_else(|| {
                anthropic_api_key
                    .is_some()
                    .then(|| DEFAULT_ANTHROPIC_BASE_URL.to_owned())
            });
        let typesafe_api_key = nonempty_env("TYPESAFE_API_KEY");
        let typesafe_base_url = nonempty_env("TYPESAFE_BASE_URL")
            .map(|value| normalize_api_base_url(&value, "TypeSafe"))
            .transpose()?
            .or_else(|| {
                typesafe_api_key
                    .is_some()
                    .then(|| DEFAULT_TYPESAFE_BASE_URL.to_owned())
            });
        let irodori_api_key = nonempty_env("IRODORI_API_KEY");
        let irodori_base_url = nonempty_env("IRODORI_BASE_URL")
            .map(|value| normalize_connection_base_url(&value, ConnectionKind::Irodori))
            .transpose()?;

        Ok(Self {
            openrouter_api_key,
            openai_base_url,
            openai_api_key,
            anthropic_base_url,
            anthropic_api_key,
            typesafe_base_url,
            typesafe_api_key,
            irodori_base_url,
            irodori_api_key,
        })
    }

    fn api_key(&self, kind: ConnectionKind) -> Option<&String> {
        match kind {
            ConnectionKind::OpenRouter => self.openrouter_api_key.as_ref(),
            ConnectionKind::OpenAiCompatible => self.openai_api_key.as_ref(),
            ConnectionKind::Anthropic => self.anthropic_api_key.as_ref(),
            ConnectionKind::Typesafe => self.typesafe_api_key.as_ref(),
            ConnectionKind::Voicevox => None,
            ConnectionKind::Irodori => self.irodori_api_key.as_ref(),
        }
    }

    fn base_url(&self, kind: ConnectionKind) -> Option<&String> {
        match kind {
            ConnectionKind::OpenRouter => None,
            ConnectionKind::OpenAiCompatible => self.openai_base_url.as_ref(),
            ConnectionKind::Anthropic => self.anthropic_base_url.as_ref(),
            ConnectionKind::Typesafe => self.typesafe_base_url.as_ref(),
            ConnectionKind::Voicevox => None,
            ConnectionKind::Irodori => self.irodori_base_url.as_ref(),
        }
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

/// A connection with every override resolved (environment > stored > default).
struct ResolvedConnection {
    id: String,
    name: String,
    kind: ConnectionKind,
    base_url: String,
    base_url_source: ConfigSource,
    base_url_editable: bool,
    api_key: Option<String>,
    api_key_source: Option<ConfigSource>,
    api_key_editable: bool,
    builtin: bool,
    editable: bool,
    deletable: bool,
    /// Whether the connection appears in `status()` (the settings list).
    listed: bool,
    embeddings_enabled: bool,
    image_generation_enabled: bool,
    tts_enabled: bool,
    ignored_providers: Vec<String>,
}

struct ManagerInner {
    persisted: PersistedConfig,
    /// Stored API keys indexed by connection id.
    stored_api_keys: HashMap<String, String>,
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
        let persisted = persisted.normalized()?;
        let mut stored_api_keys = HashMap::new();
        let mut secret_store_available = true;
        for record in &persisted.connections {
            let base_url = effective_base_url(record, &environment);
            let secret_key = secret_key_name(&record.id, &base_url);
            let (value, available) = read_secret(&*secret_store, &secret_key);
            secret_store_available &= available;
            if let Some(value) = value {
                stored_api_keys.insert(record.id.clone(), value);
            }
        }

        Ok(Self {
            config_path,
            environment,
            secret_store,
            inner: Arc::new(Mutex::new(ManagerInner {
                persisted,
                stored_api_keys,
                secret_store_available,
            })),
        })
    }

    fn resolve(&self, inner: &ManagerInner, record: &PersistedConnection) -> ResolvedConnection {
        let kind = record.kind.expect("normalized connections have a kind");
        let builtin = is_builtin_id(&record.id);
        let env_base_url = builtin.then(|| self.environment.base_url(kind)).flatten();
        let env_api_key = builtin.then(|| self.environment.api_key(kind)).flatten();
        let (base_url, base_url_source) = if let Some(value) = env_base_url {
            (value.clone(), ConfigSource::Environment)
        } else if kind.has_fixed_base_url() {
            (kind.default_base_url().to_owned(), ConfigSource::Default)
        } else if let Some(value) = &record.base_url {
            (value.clone(), ConfigSource::Stored)
        } else {
            (kind.default_base_url().to_owned(), ConfigSource::Default)
        };
        let base_url_editable = !kind.has_fixed_base_url()
            && (!builtin || (env_base_url.is_none() && env_api_key.is_none()));
        let (api_key, api_key_source) = if let Some(value) = env_api_key {
            (Some(value.clone()), Some(ConfigSource::Environment))
        } else {
            (
                inner.stored_api_keys.get(&record.id).cloned(),
                inner
                    .stored_api_keys
                    .contains_key(&record.id)
                    .then_some(ConfigSource::Stored),
            )
        };
        let api_key_editable = env_api_key.is_none();
        let editable = !builtin || (env_base_url.is_none() && env_api_key.is_none());
        // Unconfigured built-ins stay hidden from the connection list: their
        // records always exist so legacy ids and environment overrides keep
        // resolving, but they are only listed once something (stored fields,
        // a stored API key, or environment variables) actually configures them.
        let listed = !builtin
            || env_base_url.is_some()
            || env_api_key.is_some()
            || inner.stored_api_keys.contains_key(&record.id)
            || record.name.is_some()
            || record.base_url.is_some()
            || record.embeddings_enabled.is_some()
            || record.image_generation_enabled.is_some()
            || record.tts_enabled.is_some()
            || record.ignored_providers.is_some();
        ResolvedConnection {
            id: record.id.clone(),
            name: record
                .name
                .clone()
                .unwrap_or_else(|| kind.label().to_owned()),
            kind,
            base_url,
            base_url_source,
            base_url_editable,
            api_key,
            api_key_source,
            api_key_editable,
            builtin,
            editable,
            deletable: editable,
            listed,
            embeddings_enabled: record.embeddings_enabled.unwrap_or(true),
            image_generation_enabled: record.image_generation_enabled.unwrap_or(false),
            tts_enabled: record.tts_enabled.unwrap_or(false),
            ignored_providers: record.ignored_providers.clone().unwrap_or_default(),
        }
    }

    fn resolve_all(&self, inner: &ManagerInner) -> Vec<ResolvedConnection> {
        inner
            .persisted
            .connections
            .iter()
            .map(|record| self.resolve(inner, record))
            .collect()
    }

    pub fn effective(&self) -> EffectiveAiConfig {
        let inner = self.inner.lock().expect("AI config lock poisoned");
        EffectiveAiConfig {
            connections: self
                .resolve_all(&inner)
                .into_iter()
                .map(|resolved| EffectiveConnection {
                    id: resolved.id,
                    name: resolved.name,
                    kind: resolved.kind,
                    base_url: resolved.base_url,
                    api_key: resolved.api_key,
                    source: resolved.api_key_source,
                    builtin: resolved.builtin,
                    editable: resolved.editable,
                    deletable: resolved.deletable,
                    base_url_editable: resolved.base_url_editable,
                    listed: resolved.listed,
                    embeddings_enabled: resolved.embeddings_enabled,
                    image_generation_enabled: resolved.image_generation_enabled,
                    tts_enabled: resolved.tts_enabled,
                    ignored_providers: resolved.ignored_providers,
                })
                .collect(),
        }
    }

    pub fn status(&self) -> ConnectionsStatus {
        let inner = self.inner.lock().expect("AI config lock poisoned");
        ConnectionsStatus {
            connections: self
                .resolve_all(&inner)
                .into_iter()
                .filter(|resolved| resolved.listed)
                .map(|resolved| ConnectionStatus {
                    id: resolved.id,
                    name: resolved.name,
                    kind: resolved.kind,
                    base_url: Some(resolved.base_url),
                    base_url_source: Some(resolved.base_url_source),
                    base_url_editable: resolved.base_url_editable,
                    api_key: ApiKeyStatus {
                        configured: resolved.api_key.is_some(),
                        source: resolved.api_key_source,
                        editable: resolved.api_key_editable,
                    },
                    builtin: resolved.builtin,
                    editable: resolved.editable,
                    deletable: resolved.deletable,
                    embeddings_enabled: resolved.embeddings_enabled,
                    image_generation_enabled: resolved.image_generation_enabled,
                    tts_enabled: resolved.tts_enabled,
                    ignored_providers: resolved.ignored_providers,
                })
                .collect(),
            secret_store_available: inner.secret_store_available,
        }
    }

    pub(crate) fn secret_store_available(&self) -> bool {
        self.inner
            .lock()
            .expect("AI config lock poisoned")
            .secret_store_available
    }

    fn connection_index(inner: &ManagerInner, id: &str) -> AppResult<usize> {
        inner
            .persisted
            .connections
            .iter()
            .position(|record| record.id == id)
            .ok_or_else(|| AppError::BadRequest(format!("不明な接続先です: {id}")))
    }

    fn check_api_key_editable(&self, record: &PersistedConnection) -> AppResult<()> {
        let kind = record.kind.expect("normalized connections have a kind");
        if is_builtin_id(&record.id) && self.environment.api_key(kind).is_some() {
            return Err(environment_override(kind.env_api_key_name()));
        }
        Ok(())
    }

    fn check_base_url_editable(&self, record: &PersistedConnection) -> AppResult<()> {
        let kind = record.kind.expect("normalized connections have a kind");
        if kind.has_fixed_base_url() {
            return Err(AppError::BadRequest(
                "この接続のbase URLは固定のため変更できません。".to_owned(),
            ));
        }
        if is_builtin_id(&record.id)
            && (self.environment.base_url(kind).is_some()
                || self.environment.api_key(kind).is_some())
        {
            let names = match kind {
                ConnectionKind::OpenAiCompatible => "OPENAI_BASE_URL / OPENAI_API_KEY",
                ConnectionKind::Anthropic => "ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY",
                ConnectionKind::OpenRouter | ConnectionKind::Voicevox => kind.env_api_key_name(),
                ConnectionKind::Irodori => "IRODORI_BASE_URL / IRODORI_API_KEY",
                ConnectionKind::Typesafe => "TYPESAFE_BASE_URL / TYPESAFE_API_KEY",
            };
            return Err(environment_override(names));
        }
        Ok(())
    }

    pub fn create_connection(&self, input: NewConnection) -> AppResult<String> {
        if input.kind.has_fixed_base_url()
            && input
                .base_url
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(AppError::BadRequest(
                "OpenRouter接続のbase URLは固定です。".to_owned(),
            ));
        }
        let base_url = input
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| normalize_connection_base_url(value, input.kind))
            .transpose()?;
        let api_key = input
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let id = {
            let inner = self.inner.lock().expect("AI config lock poisoned");
            generate_connection_id(&inner.persisted)
        };
        let record = PersistedConnection {
            id: id.clone(),
            name: input.name.as_deref().and_then(normalize_name),
            kind: Some(input.kind),
            base_url,
            embeddings_enabled: input.embeddings_enabled,
            image_generation_enabled: input.image_generation_enabled,
            tts_enabled: input.tts_enabled,
            ignored_providers: (!input.ignored_providers.is_empty())
                .then(|| normalize_provider_slugs(input.ignored_providers)),
        };
        // Write the credential before persisting so a secret-store failure
        // leaves no half-created connection behind. Secret-store IO is slow,
        // so it always happens outside the `inner` lock.
        let secret_key = api_key
            .as_ref()
            .map(|_| secret_key_name(&id, &effective_base_url(&record, &self.environment)));
        if let (Some(secret_key), Some(api_key)) = (&secret_key, &api_key) {
            self.secret_store
                .set(secret_key, api_key)
                .map_err(secret_store_error)?;
        }
        let save_result = {
            let mut inner = self.inner.lock().expect("AI config lock poisoned");
            let mut persisted = inner.persisted.clone();
            persisted.connections.push(record);
            let save_result = save_persisted_config(&self.config_path, &persisted);
            if save_result.is_ok() {
                inner.persisted = persisted;
                if let Some(api_key) = api_key {
                    inner.stored_api_keys.insert(id.clone(), api_key);
                    inner.secret_store_available = true;
                }
            }
            save_result
        };
        if let Err(save_error) = save_result {
            // Best-effort rollback of the credential written above.
            if let Some(secret_key) = &secret_key
                && let Err(error) = self.secret_store.delete(secret_key)
            {
                tracing::warn!(%error, "failed to roll back credential of unsaved connection");
            }
            return Err(save_error);
        }
        Ok(id)
    }

    pub fn update_connection(&self, id: &str, update: ConnectionUpdate) -> AppResult<()> {
        if update.clear_api_key && update.api_key.is_some() {
            return Err(AppError::BadRequest(
                "apiKey と clearApiKey は同時に指定できません。".to_owned(),
            ));
        }
        enum KeyOperation {
            None,
            Set(String),
            Clear,
        }
        let (key_operation, removed_secret_key) = {
            let mut inner = self.inner.lock().expect("AI config lock poisoned");
            let index = Self::connection_index(&inner, id)?;
            let mut record = inner.persisted.connections[index].clone();
            let kind = record.kind.expect("normalized connections have a kind");
            let old_base_url = effective_base_url(&record, &self.environment);

            if let Some(name) = &update.name {
                record.name = normalize_name(name);
            }
            if let Some(embeddings_enabled) = update.embeddings_enabled {
                record.embeddings_enabled = Some(embeddings_enabled);
            }
            if let Some(image_generation_enabled) = update.image_generation_enabled {
                record.image_generation_enabled = Some(image_generation_enabled);
            }
            if let Some(tts_enabled) = update.tts_enabled {
                record.tts_enabled = Some(tts_enabled);
            }
            if let Some(ignored_providers) = &update.ignored_providers {
                record.ignored_providers =
                    Some(normalize_provider_slugs(ignored_providers.clone()));
            }

            let mut removed_secret_key = None;
            if let Some(base_url) = &update.base_url {
                self.check_base_url_editable(&record)?;
                let normalized = if base_url.trim().is_empty() {
                    None
                } else {
                    Some(normalize_connection_base_url(base_url, kind)?)
                };
                if normalized != record.base_url {
                    record.base_url = normalized;
                    let new_base_url = effective_base_url(&record, &self.environment);
                    if new_base_url != old_base_url {
                        removed_secret_key = Some(secret_key_name(&record.id, &old_base_url));
                    }
                }
            }

            let mut key_operation = KeyOperation::None;
            if update.clear_api_key || update.api_key.is_some() {
                self.check_api_key_editable(&record)?;
                key_operation = if let Some(api_key) = &update.api_key {
                    KeyOperation::Set(required_secret(api_key)?.to_owned())
                } else {
                    KeyOperation::Clear
                };
            }

            let mut persisted = inner.persisted.clone();
            persisted.connections[index] = record;
            save_persisted_config(&self.config_path, &persisted)?;
            inner.persisted = persisted;
            (key_operation, removed_secret_key)
        };

        if let Some(secret_key) = removed_secret_key {
            if let Err(error) = self.secret_store.delete(&secret_key) {
                tracing::warn!(%error, "failed to remove obsolete credential");
            }
            self.inner
                .lock()
                .expect("AI config lock poisoned")
                .stored_api_keys
                .remove(id);
        }
        match key_operation {
            KeyOperation::None => {}
            KeyOperation::Clear => self.clear_stored_api_key(id)?,
            KeyOperation::Set(value) => self.set_api_key(id, &value)?,
        }
        Ok(())
    }

    fn stored_secret_key_name(&self, id: &str) -> AppResult<String> {
        let inner = self.inner.lock().expect("AI config lock poisoned");
        let index = Self::connection_index(&inner, id)?;
        let record = &inner.persisted.connections[index];
        let base_url = effective_base_url(record, &self.environment);
        Ok(secret_key_name(id, &base_url))
    }

    fn clear_stored_api_key(&self, id: &str) -> AppResult<()> {
        let secret_key = self.stored_secret_key_name(id)?;
        self.secret_store
            .delete(&secret_key)
            .map_err(secret_store_error)?;
        self.inner
            .lock()
            .expect("AI config lock poisoned")
            .stored_api_keys
            .remove(id);
        Ok(())
    }

    pub fn set_api_key(&self, id: &str, value: &str) -> AppResult<()> {
        {
            let inner = self.inner.lock().expect("AI config lock poisoned");
            let index = Self::connection_index(&inner, id)?;
            self.check_api_key_editable(&inner.persisted.connections[index])?;
        }
        let value = required_secret(value)?;
        let secret_key = self.stored_secret_key_name(id)?;
        self.secret_store
            .set(&secret_key, value)
            .map_err(secret_store_error)?;
        let mut inner = self.inner.lock().expect("AI config lock poisoned");
        inner
            .stored_api_keys
            .insert(id.to_owned(), value.to_owned());
        inner.secret_store_available = true;
        Ok(())
    }

    pub fn unset_api_key(&self, id: &str) -> AppResult<()> {
        {
            let inner = self.inner.lock().expect("AI config lock poisoned");
            let index = Self::connection_index(&inner, id)?;
            self.check_api_key_editable(&inner.persisted.connections[index])?;
        }
        self.clear_stored_api_key(id)
    }

    pub fn set_base_url(&self, id: &str, value: &str) -> AppResult<()> {
        self.update_connection(
            id,
            ConnectionUpdate {
                base_url: Some(value.to_owned()),
                ..ConnectionUpdate::default()
            },
        )
    }

    pub fn unset_base_url(&self, id: &str) -> AppResult<()> {
        self.update_connection(
            id,
            ConnectionUpdate {
                base_url: Some(String::new()),
                ..ConnectionUpdate::default()
            },
        )
    }

    pub fn delete_connection(&self, id: &str) -> AppResult<()> {
        let secret_key = {
            let mut inner = self.inner.lock().expect("AI config lock poisoned");
            let index = Self::connection_index(&inner, id)?;
            let record = &inner.persisted.connections[index];
            let builtin = is_builtin_id(&record.id);
            let kind = record.kind.expect("normalized connections have a kind");
            if builtin
                && (self.environment.base_url(kind).is_some()
                    || self.environment.api_key(kind).is_some())
            {
                return Err(AppError::BadRequest(
                    "環境変数で設定されている組み込み接続は削除できません。".to_owned(),
                ));
            }
            let base_url = effective_base_url(record, &self.environment);
            let secret_key = secret_key_name(&record.id, &base_url);
            let mut persisted = inner.persisted.clone();
            if builtin {
                // The reserved id keeps resolving so stored model references
                // do not break; the pristine record drops out of the
                // connection list again.
                persisted.connections[index] = PersistedConnection {
                    id: record.id.clone(),
                    kind: Some(kind),
                    ..PersistedConnection::default()
                };
            } else {
                persisted.connections.remove(index);
            }
            save_persisted_config(&self.config_path, &persisted)?;
            inner.persisted = persisted;
            inner.stored_api_keys.remove(id);
            secret_key
        };
        if let Err(error) = self.secret_store.delete(&secret_key) {
            tracing::warn!(%error, "failed to remove deleted connection credential");
        }
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

fn effective_base_url(record: &PersistedConnection, environment: &EnvironmentConfig) -> String {
    let kind = record.kind.expect("normalized connections have a kind");
    if is_builtin_id(&record.id)
        && let Some(value) = environment.base_url(kind)
    {
        return value.clone();
    }
    if kind.has_fixed_base_url() {
        return kind.default_base_url().to_owned();
    }
    record
        .base_url
        .clone()
        .unwrap_or_else(|| kind.default_base_url().to_owned())
}

fn secret_key_name(id: &str, effective_base_url: &str) -> String {
    match id {
        OPENROUTER_CONNECTION_ID => "openrouter.api-key".to_owned(),
        OPENAI_COMPATIBLE_CONNECTION_ID => openai_secret_key(effective_base_url),
        ANTHROPIC_CONNECTION_ID => anthropic_secret_key(effective_base_url),
        id => format!("conn.api-key:{id}"),
    }
}

fn generate_connection_id(persisted: &PersistedConfig) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    loop {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let seed = format!(
            "{nanos}:{}:{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let digest = format!("{:x}", Sha256::digest(seed.as_bytes()));
        let id = format!("{CUSTOM_ID_PREFIX}{}", &digest[..16]);
        if !persisted.connections.iter().any(|record| record.id == id) {
            return id;
        }
    }
}

#[derive(Debug, Clone)]
pub struct NewConnection {
    pub name: Option<String>,
    pub kind: ConnectionKind,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub embeddings_enabled: Option<bool>,
    pub image_generation_enabled: Option<bool>,
    pub tts_enabled: Option<bool>,
    pub ignored_providers: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ConnectionUpdate {
    /// `Some("")` clears the custom name back to the kind label.
    pub name: Option<String>,
    /// `Some("")` resets the base URL to the kind default.
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub clear_api_key: bool,
    pub embeddings_enabled: Option<bool>,
    pub image_generation_enabled: Option<bool>,
    pub tts_enabled: Option<bool>,
    pub ignored_providers: Option<Vec<String>>,
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
            "APIキーを空にはできません。削除する場合は clearApiKey / unset を使用してください。"
                .to_owned(),
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

fn normalize_api_base_url(value: &str, api_name: &str) -> AppResult<String> {
    let value = value.trim();
    let mut url = Url::parse(value)
        .map_err(|_| AppError::BadRequest(format!("{api_name} base URLが不正です。")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::BadRequest(format!(
            "{api_name} base URLには http または https を指定してください。"
        )));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::BadRequest(format!(
            "{api_name} base URLに認証情報、query、fragmentは指定できません。"
        )));
    }
    if url.scheme() == "http" && !is_loopback_url(&url) {
        return Err(AppError::BadRequest(format!(
            "HTTPの{api_name} base URLにはloopbackアドレスだけを指定できます。"
        )));
    }
    let normalized_path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&normalized_path);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

/// Per-kind base URL normalization. Irodori serves its API under `/v1`, so a
/// user-supplied `/v1` suffix is folded away and routes re-append it; other
/// kinds keep the value as entered.
fn normalize_connection_base_url(value: &str, kind: ConnectionKind) -> AppResult<String> {
    let normalized = normalize_api_base_url(value, kind.api_name())?;
    if kind != ConnectionKind::Irodori {
        return Ok(normalized);
    }
    let mut url = normalized.as_str();
    while let Some(stripped) = url.strip_suffix("/v1") {
        url = stripped;
    }
    Ok(url.to_owned())
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

pub(crate) fn parse_config_data_dir(args: &mut Vec<String>) -> AppResult<PathBuf> {
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

/// Maps the legacy `config` keys to built-in connection ids.
fn legacy_api_key_connection(key: &str) -> Option<&'static str> {
    match key {
        "openrouter.api-key" => Some(OPENROUTER_CONNECTION_ID),
        "openai.api-key" => Some(OPENAI_COMPATIBLE_CONNECTION_ID),
        "anthropic.api-key" => Some(ANTHROPIC_CONNECTION_ID),
        _ => None,
    }
}

fn legacy_base_url_connection(key: &str) -> Option<&'static str> {
    match key {
        "openai.base-url" => Some(OPENAI_COMPATIBLE_CONNECTION_ID),
        "anthropic.base-url" => Some(ANTHROPIC_CONNECTION_ID),
        _ => None,
    }
}

fn is_api_key(key: &str) -> bool {
    legacy_api_key_connection(key).is_some()
}

fn set_api_key(manager: &AiConfigManager, key: &str, value: &str) -> AppResult<()> {
    match legacy_api_key_connection(key) {
        Some(id) => manager.set_api_key(id, value),
        None => Err(unsupported_config_key(key)),
    }
}

fn unsupported_config_key(key: &str) -> AppError {
    AppError::BadRequest(format!("未対応の設定キーです: {key}"))
}

fn read_secret_value(prompt: &str, stdin: bool) -> AppResult<String> {
    if stdin {
        let mut value = String::new();
        io::stdin().read_to_string(&mut value)?;
        Ok(value)
    } else {
        Ok(rpassword::prompt_password(prompt.to_owned())?)
    }
}

fn run_connection_cli(manager: &AiConfigManager, args: &[String]) -> AppResult<()> {
    match args {
        [command, kind, options @ ..] if command == "add" => {
            let kind = ConnectionKind::parse(kind)
                .ok_or_else(|| AppError::BadRequest(format!("未対応の接続種別です: {kind}")))?;
            let mut name = None;
            let mut base_url = None;
            let mut index = 0;
            while index < options.len() {
                match options[index].as_str() {
                    "--name" => {
                        index += 1;
                        name = Some(
                            options
                                .get(index)
                                .ok_or_else(|| {
                                    AppError::BadRequest("--name には値が必要です。".to_owned())
                                })?
                                .clone(),
                        );
                    }
                    "--base-url" => {
                        index += 1;
                        base_url = Some(
                            options
                                .get(index)
                                .ok_or_else(|| {
                                    AppError::BadRequest("--base-url には値が必要です。".to_owned())
                                })?
                                .clone(),
                        );
                    }
                    option => {
                        return Err(AppError::BadRequest(format!(
                            "connection add の未対応の引数です: {option}"
                        )));
                    }
                }
                index += 1;
            }
            let id = manager.create_connection(NewConnection {
                name,
                kind,
                base_url,
                api_key: None,
                embeddings_enabled: None,
                image_generation_enabled: None,
                tts_enabled: None,
                ignored_providers: Vec::new(),
            })?;
            println!("接続 {id} を追加しました。Kataruが起動中の場合は再起動してください。");
        }
        [command, id] if command == "remove" => {
            manager.delete_connection(id)?;
            println!("接続 {id} を削除しました。Kataruが起動中の場合は再起動してください。");
        }
        [command, id] if command == "set-key" => {
            let value = read_secret_value(&format!("{id} api-key: "), false)?;
            manager.set_api_key(id, &value)?;
            println!("{id} のAPIキーを保存しました。Kataruが起動中の場合は再起動してください。");
        }
        [command, id, option] if command == "set-key" && option == "--stdin" => {
            let value = read_secret_value("", true)?;
            manager.set_api_key(id, &value)?;
            println!("{id} のAPIキーを保存しました。Kataruが起動中の場合は再起動してください。");
        }
        _ => {
            return Err(AppError::BadRequest(
                "config connection コマンドの引数が不正です。kataru config --help を確認してください。"
                    .to_owned(),
            ));
        }
    }
    Ok(())
}

pub fn run_cli_command_if_requested() -> AppResult<bool> {
    let mut args = env::args()
        .skip(1)
        .filter(|arg| arg != "--verbose")
        .collect::<Vec<_>>();
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
        [command, key] if command == "get" => {
            if let Some(id) = legacy_base_url_connection(key) {
                // Built-ins are hidden from `status()` until configured, so
                // look them up in the full effective config instead.
                let effective = manager.effective();
                let connection = effective
                    .connection(id)
                    .ok_or_else(|| unsupported_config_key(key))?;
                println!("{}", connection.base_url);
            } else {
                return Err(unsupported_config_key(key));
            }
        }
        [command, key, value] if command == "set" => {
            if let Some(id) = legacy_base_url_connection(key) {
                manager.set_base_url(id, value)?;
            } else if is_api_key(key) {
                return Err(AppError::BadRequest(
                    "config set <key> には値が必要です（--stdin または対話入力を使用してください）。"
                        .to_owned(),
                ));
            } else {
                return Err(unsupported_config_key(key));
            }
            println!("{key} を保存しました。Kataruが起動中の場合は再起動してください。");
        }
        [command, key] if command == "set" && is_api_key(key) => {
            let value = read_secret_value(&format!("{key}: "), false)?;
            set_api_key(&manager, key, &value)?;
            println!("{key} を保存しました。Kataruが起動中の場合は再起動してください。");
        }
        [command, key, option] if command == "set" && is_api_key(key) && option == "--stdin" => {
            let value = read_secret_value("", true)?;
            set_api_key(&manager, key, &value)?;
            println!("{key} を保存しました。Kataruが起動中の場合は再起動してください。");
        }
        [command, key] if command == "unset" => {
            if let Some(id) = legacy_api_key_connection(key) {
                manager.unset_api_key(id)?;
            } else if let Some(id) = legacy_base_url_connection(key) {
                manager.unset_base_url(id)?;
            } else {
                return Err(unsupported_config_key(key));
            }
            println!("{key} を削除しました。Kataruが起動中の場合は再起動してください。");
        }
        [command, rest @ ..] if command == "connection" => {
            run_connection_cli(&manager, rest)?;
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

fn print_config_status(status: &ConnectionsStatus) {
    if status.connections.is_empty() {
        println!("設定済みの接続はありません。kataru config connection add で追加できます。");
    }
    for connection in &status.connections {
        println!(
            "{} [{}]{}",
            connection.id,
            connection.kind.as_str(),
            if connection.builtin { " builtin" } else { "" }
        );
        println!("  name: {}", connection.name);
        println!(
            "  base-url: {} ({})",
            connection.base_url.as_deref().unwrap_or("-"),
            connection
                .base_url_source
                .map(|source| source.to_string())
                .unwrap_or_else(|| "-".to_owned())
        );
        println!(
            "  api-key: {}{}",
            if connection.api_key.configured {
                "configured"
            } else {
                "not configured"
            },
            connection
                .api_key
                .source
                .map(|source| format!(" ({source})"))
                .unwrap_or_default()
        );
    }
    if !status.secret_store_available {
        println!("warning: OSの資格情報ストアを利用できません。");
    }
}

fn print_config_help() {
    println!(
        "Kataru config\n\n  config show\n  config get openai.base-url\n  config get anthropic.base-url\n  config set openrouter.api-key [--stdin]\n  config set openai.api-key [--stdin]\n  config set openai.base-url <URL>\n  config set anthropic.api-key [--stdin]\n  config set anthropic.base-url <URL>\n  config unset <KEY>\n  config connection add <openrouter|openai-compatible|anthropic|typesafe|voicevox|irodori> --name <NAME> [--base-url <URL>]\n  config connection remove <ID>\n  config connection set-key <ID> [--stdin]\n\n  --data-dir <PATH>  設定対象のデータ保存先\n  --portable         実行ファイル横の kataru-data を使用"
    );
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConnectionRequest {
    name: Option<String>,
    kind: String,
    base_url: Option<String>,
    api_key: Option<String>,
    embeddings_enabled: Option<bool>,
    image_generation_enabled: Option<bool>,
    tts_enabled: Option<bool>,
    ignored_providers: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionRequest {
    name: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    clear_api_key: Option<bool>,
    embeddings_enabled: Option<bool>,
    image_generation_enabled: Option<bool>,
    tts_enabled: Option<bool>,
    ignored_providers: Option<Vec<String>>,
}

pub async fn list_connections(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
) -> AppResult<Json<ConnectionsStatus>> {
    require_loopback(peer)?;
    Ok(Json(state.ai_config.status()))
}

pub async fn create_connection(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateConnectionRequest>,
) -> AppResult<Json<ConnectionsStatus>> {
    require_config_write(peer, &headers, &state)?;
    let kind = ConnectionKind::parse(&input.kind)
        .ok_or_else(|| AppError::BadRequest(format!("未対応の接続種別です: {}", input.kind)))?;
    state.ai_config.create_connection(NewConnection {
        name: input.name,
        kind,
        base_url: input.base_url,
        api_key: input.api_key,
        embeddings_enabled: input.embeddings_enabled,
        image_generation_enabled: input.image_generation_enabled,
        tts_enabled: input.tts_enabled,
        ignored_providers: input.ignored_providers.unwrap_or_default(),
    })?;
    Ok(Json(state.ai_config.status()))
}

pub async fn update_connection(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<UpdateConnectionRequest>,
) -> AppResult<Json<ConnectionsStatus>> {
    require_config_write(peer, &headers, &state)?;
    state.ai_config.update_connection(
        &id,
        ConnectionUpdate {
            name: input.name,
            base_url: input.base_url,
            api_key: input.api_key,
            clear_api_key: input.clear_api_key.unwrap_or(false),
            embeddings_enabled: input.embeddings_enabled,
            image_generation_enabled: input.image_generation_enabled,
            tts_enabled: input.tts_enabled,
            ignored_providers: input.ignored_providers,
        },
    )?;
    Ok(Json(state.ai_config.status()))
}

pub async fn delete_connection(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<ConnectionsStatus>> {
    require_config_write(peer, &headers, &state)?;
    state.ai_config.delete_connection(&id)?;
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
struct FailingSecretStore;

#[cfg(test)]
impl SecretStore for FailingSecretStore {
    fn get(&self, _key: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn set(&self, _key: &str, _value: &str) -> Result<(), String> {
        Err("simulated credential store failure".to_owned())
    }

    fn delete(&self, _key: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager(directory: &Path) -> AiConfigManager {
        AiConfigManager::with_parts(
            directory.join(CONFIG_FILE_NAME),
            PersistedConfig::default(),
            EnvironmentConfig::default(),
            Arc::new(MemorySecretStore::default()),
        )
        .unwrap()
    }

    fn connection<'a>(status: &'a ConnectionsStatus, id: &str) -> &'a ConnectionStatus {
        status
            .connections
            .iter()
            .find(|connection| connection.id == id)
            .unwrap_or_else(|| panic!("connection {id} must exist"))
    }

    #[test]
    fn normalizes_supported_base_urls() {
        assert_eq!(
            normalize_api_base_url(" https://api.openai.com/v1/ ", "OpenAI").unwrap(),
            DEFAULT_OPENAI_BASE_URL
        );
        assert_eq!(
            normalize_api_base_url("http://127.0.0.1:1234/v1/", "OpenAI").unwrap(),
            "http://127.0.0.1:1234/v1"
        );
    }

    #[test]
    fn rejects_unsafe_base_urls() {
        assert!(normalize_api_base_url("ftp://localhost/v1", "OpenAI").is_err());
        assert!(normalize_api_base_url("http://example.com/v1", "OpenAI").is_err());
        assert!(normalize_api_base_url("https://user:secret@example.com/v1", "OpenAI").is_err());
        assert!(normalize_api_base_url("https://example.com/v1?key=value", "OpenAI").is_err());
    }

    #[test]
    fn builtin_connections_stay_unlisted_until_configured() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());

        // Nothing has been configured yet: the built-ins resolve internally
        // but none of them are listed.
        assert!(manager.status().connections.is_empty());
        let effective = manager.effective();
        assert_eq!(effective.connections.len(), 6);
        let openrouter = effective.connection("openrouter").unwrap();
        assert_eq!(openrouter.name, "OpenRouter");
        assert_eq!(openrouter.base_url, OPENROUTER_BASE_URL);
        assert!(!openrouter.base_url_editable);
        assert!(openrouter.builtin);
        assert!(openrouter.editable);
        assert!(openrouter.deletable);
        assert_eq!(
            effective.connection("openai-compatible").unwrap().base_url,
            DEFAULT_OPENAI_BASE_URL
        );
        assert_eq!(
            effective.connection("anthropic").unwrap().base_url,
            DEFAULT_ANTHROPIC_BASE_URL
        );
        assert_eq!(
            effective.connection("typesafe").unwrap().base_url,
            DEFAULT_TYPESAFE_BASE_URL
        );
        assert_eq!(
            effective.connection("voicevox").unwrap().base_url,
            DEFAULT_VOICEVOX_BASE_URL
        );
        assert_eq!(
            effective.connection("irodori").unwrap().base_url,
            DEFAULT_IRODORI_BASE_URL
        );

        // Any stored configuration lists the built-in again.
        manager.set_api_key("openrouter", "secret").unwrap();
        let status = manager.status();
        assert_eq!(status.connections.len(), 1);
        assert_eq!(status.connections[0].id, "openrouter");
    }

    #[test]
    fn changing_base_url_unbinds_the_stored_key() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());
        manager.set_api_key("openai-compatible", "secret").unwrap();
        assert!(
            connection(&manager.status(), "openai-compatible")
                .api_key
                .configured
        );

        manager
            .set_base_url("openai-compatible", "http://127.0.0.1:1234/v1")
            .unwrap();
        assert!(
            !connection(&manager.status(), "openai-compatible")
                .api_key
                .configured
        );

        manager
            .set_api_key("openai-compatible", "replacement")
            .unwrap();
        manager
            .set_base_url("openai-compatible", "http://127.0.0.1:1234/v1/")
            .unwrap();
        assert!(
            connection(&manager.status(), "openai-compatible")
                .api_key
                .configured
        );

        manager
            .set_base_url("openai-compatible", "http://127.0.0.1:1235/v1")
            .unwrap();
        assert!(
            !connection(&manager.status(), "openai-compatible")
                .api_key
                .configured
        );
    }

    #[test]
    fn environment_values_are_effective_and_read_only() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AiConfigManager::with_parts(
            directory.path().join(CONFIG_FILE_NAME),
            PersistedConfig {
                openai: PersistedProviderSection {
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
                typesafe_base_url: Some(DEFAULT_TYPESAFE_BASE_URL.to_owned()),
                typesafe_api_key: Some("typesafe-env".to_owned()),
                ..EnvironmentConfig::default()
            },
            Arc::new(MemorySecretStore::default()),
        )
        .unwrap();

        let effective = manager.effective();
        let openrouter = effective.connection("openrouter").unwrap();
        let openai = effective.connection("openai-compatible").unwrap();
        let anthropic = effective.connection("anthropic").unwrap();
        let typesafe = effective.connection("typesafe").unwrap();
        assert_eq!(openrouter.api_key.as_deref(), Some("openrouter-env"));
        assert_eq!(openai.base_url, DEFAULT_OPENAI_BASE_URL);
        assert_eq!(openai.api_key.as_deref(), Some("openai-env"));
        assert_eq!(anthropic.base_url, DEFAULT_ANTHROPIC_BASE_URL);
        assert_eq!(anthropic.api_key.as_deref(), Some("anthropic-env"));
        assert_eq!(typesafe.base_url, DEFAULT_TYPESAFE_BASE_URL);
        assert_eq!(typesafe.api_key.as_deref(), Some("typesafe-env"));

        let status = manager.status();
        let openai = connection(&status, "openai-compatible");
        assert_eq!(openai.base_url_source, Some(ConfigSource::Environment));
        assert!(!openai.base_url_editable);
        assert!(!openai.api_key.editable);
        assert!(!openai.editable);
        assert!(!connection(&status, "openrouter").editable);
        assert!(!connection(&status, "anthropic").editable);
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
                .set_base_url("openai-compatible", "http://127.0.0.1:1234/v1")
                .is_err()
        );
        assert_eq!(
            manager
                .effective()
                .connection("openai-compatible")
                .unwrap()
                .base_url,
            DEFAULT_OPENAI_BASE_URL
        );
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
        let manager = manager(directory.path());
        manager
            .set_api_key("openrouter", "openrouter-do-not-return")
            .unwrap();
        manager
            .set_api_key("openai-compatible", "openai-do-not-return")
            .unwrap();
        manager
            .set_api_key("anthropic", "anthropic-do-not-return")
            .unwrap();

        let serialized = serde_json::to_string(&manager.status()).unwrap();
        assert!(!serialized.contains("openrouter-do-not-return"));
        assert!(!serialized.contains("openai-do-not-return"));
        assert!(!serialized.contains("anthropic-do-not-return"));
    }

    #[test]
    fn changing_anthropic_base_url_unbinds_the_stored_key() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());
        manager.set_api_key("anthropic", "secret").unwrap();
        assert!(
            connection(&manager.status(), "anthropic")
                .api_key
                .configured
        );

        manager
            .set_base_url("anthropic", "http://127.0.0.1:8080/v1")
            .unwrap();
        assert!(
            !connection(&manager.status(), "anthropic")
                .api_key
                .configured
        );
    }

    #[test]
    fn v1_config_migrates_builtin_base_urls_to_v2() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CONFIG_FILE_NAME);
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "openai": {"base_url": "http://127.0.0.1:1234/v1"},
                "anthropic": {"base_url": "https://anthropic.example/v1"}
            }))
            .unwrap(),
        )
        .unwrap();

        let manager = AiConfigManager::open(directory.path()).unwrap();
        let effective = manager.effective();
        assert_eq!(effective.connections.len(), 6);
        assert_eq!(
            effective.connection("openai-compatible").unwrap().base_url,
            "http://127.0.0.1:1234/v1"
        );
        assert_eq!(
            effective.connection("anthropic").unwrap().base_url,
            "https://anthropic.example/v1"
        );

        // The next persisted write must save the v2 shape (API key writes only
        // touch the keyring, so update a stored field instead).
        manager
            .update_connection(
                "openrouter",
                ConnectionUpdate {
                    name: Some("Renamed".to_owned()),
                    ..ConnectionUpdate::default()
                },
            )
            .unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["version"], 2);
        assert!(saved["connections"].as_array().unwrap().len() == 6);
        assert!(saved.get("openai").is_none());
    }

    #[test]
    fn custom_connections_support_crud_and_their_own_key() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());

        let id = manager
            .create_connection(NewConnection {
                name: Some("ローカルLLM".to_owned()),
                kind: ConnectionKind::OpenAiCompatible,
                base_url: Some("http://127.0.0.1:1234/v1".to_owned()),
                api_key: Some("custom-secret".to_owned()),
                embeddings_enabled: Some(false),
                image_generation_enabled: Some(true),
                tts_enabled: Some(true),
                ignored_providers: Vec::new(),
            })
            .unwrap();
        assert!(id.starts_with(CUSTOM_ID_PREFIX));

        let status = manager.status();
        let custom = connection(&status, &id);
        assert_eq!(custom.name, "ローカルLLM");
        assert_eq!(custom.base_url.as_deref(), Some("http://127.0.0.1:1234/v1"));
        assert_eq!(custom.base_url_source, Some(ConfigSource::Stored));
        assert!(custom.api_key.configured);
        assert_eq!(custom.api_key.source, Some(ConfigSource::Stored));
        assert!(!custom.builtin);
        assert!(custom.editable);
        assert!(custom.deletable);
        assert!(!custom.embeddings_enabled);
        assert!(custom.image_generation_enabled);
        assert!(custom.tts_enabled);

        // Renaming, clearing the name and toggling flags.
        manager
            .update_connection(
                &id,
                ConnectionUpdate {
                    name: Some("  ".to_owned()),
                    embeddings_enabled: Some(true),
                    ..ConnectionUpdate::default()
                },
            )
            .unwrap();
        let status = manager.status();
        let custom = connection(&status, &id);
        assert_eq!(custom.name, "OpenAI 互換");
        assert!(custom.embeddings_enabled);

        // Base URL changes drop the stored key.
        manager
            .update_connection(
                &id,
                ConnectionUpdate {
                    base_url: Some("http://127.0.0.1:9999/v1".to_owned()),
                    ..ConnectionUpdate::default()
                },
            )
            .unwrap();
        assert!(!connection(&manager.status(), &id).api_key.configured);

        // Deleting removes the connection and its key.
        manager.delete_connection(&id).unwrap();
        assert!(
            manager
                .status()
                .connections
                .iter()
                .all(|connection| connection.id != id)
        );
        assert!(manager.delete_connection(&id).is_err());
    }

    #[test]
    fn deleting_a_builtin_connection_resets_it_to_unlisted() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());
        manager.set_api_key("openrouter", "secret").unwrap();
        manager
            .update_connection(
                "openrouter",
                ConnectionUpdate {
                    ignored_providers: Some(vec!["deepinfra".to_owned()]),
                    ..ConnectionUpdate::default()
                },
            )
            .unwrap();
        assert_eq!(manager.status().connections.len(), 1);

        manager.delete_connection("openrouter").unwrap();
        assert!(manager.status().connections.is_empty());
        // The reserved id keeps resolving, back to a pristine state.
        let effective = manager.effective();
        let openrouter = effective.connection("openrouter").unwrap();
        assert!(openrouter.api_key.is_none());
        assert!(openrouter.ignored_providers.is_empty());
    }

    #[test]
    fn voicevox_builtin_is_unlisted_until_configured() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());
        // VOICEVOX needs no credential, so nothing configures the built-in
        // record by default and it stays out of the connection list.
        assert!(manager.status().connections.is_empty());

        manager
            .update_connection(
                "voicevox",
                ConnectionUpdate {
                    base_url: Some("http://127.0.0.1:50022".to_owned()),
                    ..ConnectionUpdate::default()
                },
            )
            .unwrap();
        let status = manager.status();
        assert_eq!(status.connections.len(), 1);
        assert_eq!(status.connections[0].id, "voicevox");
        assert!(status.connections[0].deletable);

        manager.delete_connection("voicevox").unwrap();
        assert!(manager.status().connections.is_empty());
        // The reserved id keeps resolving with the default endpoint.
        assert_eq!(
            manager.effective().connection("voicevox").unwrap().base_url,
            DEFAULT_VOICEVOX_BASE_URL
        );
    }

    #[test]
    fn environment_locked_builtins_cannot_be_deleted() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AiConfigManager::with_parts(
            directory.path().join(CONFIG_FILE_NAME),
            PersistedConfig::default(),
            EnvironmentConfig {
                openrouter_api_key: Some("env-key".to_owned()),
                ..EnvironmentConfig::default()
            },
            Arc::new(MemorySecretStore::default()),
        )
        .unwrap();

        assert_eq!(manager.status().connections.len(), 1);
        assert!(manager.delete_connection("openrouter").is_err());
        assert_eq!(manager.status().connections.len(), 1);
        // Built-ins without an environment override can be deleted.
        manager.delete_connection("openai-compatible").unwrap();
    }

    #[test]
    fn openrouter_base_url_is_fixed() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());
        assert!(
            manager
                .set_base_url("openrouter", "https://example.com")
                .is_err()
        );
        assert!(
            manager
                .create_connection(NewConnection {
                    name: None,
                    kind: ConnectionKind::OpenRouter,
                    base_url: Some("https://example.com".to_owned()),
                    api_key: None,
                    embeddings_enabled: None,
                    image_generation_enabled: None,
                    tts_enabled: None,
                    ignored_providers: Vec::new(),
                })
                .is_err()
        );
    }

    #[test]
    fn environment_locked_connections_reject_key_changes() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AiConfigManager::with_parts(
            directory.path().join(CONFIG_FILE_NAME),
            PersistedConfig::default(),
            EnvironmentConfig {
                openrouter_api_key: Some("env-key".to_owned()),
                ..EnvironmentConfig::default()
            },
            Arc::new(MemorySecretStore::default()),
        )
        .unwrap();

        assert!(manager.set_api_key("openrouter", "key").is_err());
        assert!(manager.unset_api_key("openrouter").is_err());
        // Custom connections are never environment-locked.
        let id = manager
            .create_connection(NewConnection {
                name: None,
                kind: ConnectionKind::OpenRouter,
                base_url: None,
                api_key: Some("custom-key".to_owned()),
                embeddings_enabled: None,
                image_generation_enabled: None,
                tts_enabled: None,
                ignored_providers: vec!["deepinfra".to_owned()],
            })
            .unwrap();
        let effective = manager.effective();
        let custom = effective.connection(&id).unwrap();
        assert_eq!(custom.api_key.as_deref(), Some("custom-key"));
        assert_eq!(custom.ignored_providers, ["deepinfra"]);
        assert_eq!(custom.base_url, OPENROUTER_BASE_URL);
    }

    #[test]
    fn connection_ids_are_unique_across_creations() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());
        let mut ids = std::collections::HashSet::new();
        for _ in 0..8 {
            let id = manager
                .create_connection(NewConnection {
                    name: None,
                    kind: ConnectionKind::Anthropic,
                    base_url: None,
                    api_key: None,
                    embeddings_enabled: None,
                    image_generation_enabled: None,
                    tts_enabled: None,
                    ignored_providers: Vec::new(),
                })
                .unwrap();
            assert!(ids.insert(id));
        }
    }

    #[test]
    fn failed_secret_store_write_leaves_no_connection_behind() {
        let directory = tempfile::tempdir().unwrap();
        let manager = AiConfigManager::with_parts(
            directory.path().join(CONFIG_FILE_NAME),
            PersistedConfig::default(),
            EnvironmentConfig::default(),
            Arc::new(FailingSecretStore),
        )
        .unwrap();

        assert!(
            manager
                .create_connection(NewConnection {
                    name: None,
                    kind: ConnectionKind::Anthropic,
                    base_url: None,
                    api_key: Some("secret".to_owned()),
                    embeddings_enabled: None,
                    image_generation_enabled: None,
                    tts_enabled: None,
                    ignored_providers: Vec::new(),
                })
                .is_err()
        );
        // Only the unlisted built-ins exist and nothing was persisted.
        assert!(manager.status().connections.is_empty());
        assert_eq!(manager.effective().connections.len(), 6);
        assert!(!directory.path().join(CONFIG_FILE_NAME).exists());
    }

    #[test]
    fn failed_connection_save_rolls_back_the_stored_key() {
        let directory = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        let manager = AiConfigManager::with_parts(
            // A missing directory makes save_persisted_config fail.
            directory.path().join("missing").join(CONFIG_FILE_NAME),
            PersistedConfig::default(),
            EnvironmentConfig::default(),
            secrets.clone(),
        )
        .unwrap();

        assert!(
            manager
                .create_connection(NewConnection {
                    name: None,
                    kind: ConnectionKind::Anthropic,
                    base_url: None,
                    api_key: Some("secret".to_owned()),
                    embeddings_enabled: None,
                    image_generation_enabled: None,
                    tts_enabled: None,
                    ignored_providers: Vec::new(),
                })
                .is_err()
        );
        assert!(manager.status().connections.is_empty());
        assert!(
            secrets
                .values
                .lock()
                .expect("memory secrets lock")
                .is_empty(),
            "the pre-written credential must be rolled back"
        );
    }
}
