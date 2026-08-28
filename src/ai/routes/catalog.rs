use std::{
    collections::HashSet,
    env, fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{Json, extract::State};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    AppState,
    ai_config::{AiConfigManager, DEFAULT_OPENAI_BASE_URL, parse_config_data_dir},
    error::{AppError, AppResult},
};

use super::{
    super::api_client::{AiApiClient, AiApiConfig, map_request_error},
    common::{ai_api_client_for, upstream_error},
};

const MODEL_CACHE_FILE_NAME: &str = "model-cache.json";
const MODEL_CACHE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelOutputModality {
    Text,
    Image,
    Embeddings,
}

impl ModelOutputModality {
    fn from_input(input: &Value) -> AppResult<Self> {
        match input.get("outputModality").and_then(Value::as_str) {
            None | Some("text") => Ok(Self::Text),
            Some("image") => Ok(Self::Image),
            Some("embeddings") => Ok(Self::Embeddings),
            Some(_) => Err(AppError::BadRequest(
                "outputModality が不正です。".to_owned(),
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
            Self::Embeddings => "embeddings",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct AvailableModel {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedModelList {
    ai_api_type: String,
    base_url: String,
    output_modality: ModelOutputModality,
    updated_at: u64,
    data: Vec<AvailableModel>,
}

impl CachedModelList {
    fn matches(&self, api_client: &AiApiClient, output_modality: ModelOutputModality) -> bool {
        self.ai_api_type == api_client.api_type_name()
            && self.base_url == api_client.base_url()
            && self.output_modality == output_modality
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ModelCacheFile {
    version: u32,
    entries: Vec<CachedModelList>,
}

impl Default for ModelCacheFile {
    fn default() -> Self {
        Self {
            version: MODEL_CACHE_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct ModelCatalogCache {
    path: Option<PathBuf>,
    inner: Arc<Mutex<ModelCacheFile>>,
}

impl ModelCatalogCache {
    pub fn open(data_dir: &Path) -> AppResult<Self> {
        fs::create_dir_all(data_dir)?;
        let path = data_dir.join(MODEL_CACHE_FILE_NAME);
        let cache = load_model_cache(&path)?;
        Ok(Self {
            path: Some(path),
            inner: Arc::new(Mutex::new(cache)),
        })
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            path: None,
            inner: Arc::new(Mutex::new(ModelCacheFile::default())),
        }
    }

    fn get(
        &self,
        api_client: &AiApiClient,
        output_modality: ModelOutputModality,
    ) -> AppResult<Option<CachedModelList>> {
        let mut cache = self.inner.lock().map_err(|_| {
            AppError::Internal("モデル一覧キャッシュのロックに失敗しました。".to_owned())
        })?;
        if let Some(path) = &self.path {
            *cache = load_model_cache(path)?;
        }
        Ok(cache
            .entries
            .iter()
            .find(|entry| entry.matches(api_client, output_modality))
            .cloned())
    }

    fn put(&self, entry: CachedModelList) -> AppResult<()> {
        let mut cache = self.inner.lock().map_err(|_| {
            AppError::Internal("モデル一覧キャッシュのロックに失敗しました。".to_owned())
        })?;
        if let Some(path) = &self.path {
            *cache = load_model_cache(path)?;
        }
        cache.entries.retain(|cached| {
            cached.ai_api_type != entry.ai_api_type
                || cached.base_url != entry.base_url
                || cached.output_modality != entry.output_modality
        });
        cache.entries.push(entry);
        cache.entries.sort_by(|left, right| {
            left.ai_api_type
                .cmp(&right.ai_api_type)
                .then_with(|| left.base_url.cmp(&right.base_url))
                .then_with(|| {
                    left.output_modality
                        .as_str()
                        .cmp(right.output_modality.as_str())
                })
        });
        if let Some(path) = &self.path {
            save_model_cache(path, &cache)?;
        }
        Ok(())
    }
}

fn load_model_cache(path: &Path) -> AppResult<ModelCacheFile> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ModelCacheFile::default());
        }
        Err(error) => return Err(error.into()),
    };
    match serde_json::from_slice::<ModelCacheFile>(&bytes) {
        Ok(cache) if cache.version == MODEL_CACHE_VERSION => Ok(cache),
        Ok(_) => {
            tracing::warn!(path = %path.display(), "Unsupported model cache version; starting empty");
            Ok(ModelCacheFile::default())
        }
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "Invalid model cache; starting empty");
            Ok(ModelCacheFile::default())
        }
    }
}

fn save_model_cache(path: &Path, cache: &ModelCacheFile) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(cache)?;
    let temporary_path = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&temporary_path, bytes)?;
    if let Err(error) = fs::rename(&temporary_path, path) {
        if path.exists() {
            fs::remove_file(path)?;
            fs::rename(temporary_path, path)?;
        } else {
            return Err(error.into());
        }
    }
    Ok(())
}

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

    match api_client.send_get("models", Duration::from_secs(8)).await {
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

fn normalize_models_response(input: &Value) -> Vec<AvailableModel> {
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
            Some(AvailableModel {
                id: id.to_owned(),
                name: if name.is_empty() {
                    id.to_owned()
                } else {
                    name.to_owned()
                },
            })
        })
        .collect::<Vec<_>>();

    models.sort_by(|left, right| {
        let sort_key = |value: &AvailableModel| value.name.to_lowercase();
        sort_key(left)
            .cmp(&sort_key(right))
            .then_with(|| left.id.cmp(&right.id))
    });
    models
}

fn openrouter_models_path(output_modality: ModelOutputModality) -> &'static str {
    match output_modality {
        ModelOutputModality::Text => "models?output_modalities=text",
        ModelOutputModality::Image => "models?output_modalities=image",
        ModelOutputModality::Embeddings => "models?output_modalities=embeddings",
    }
}

async fn fetch_models(
    api_client: &AiApiClient,
    output_modality: ModelOutputModality,
) -> AppResult<Vec<AvailableModel>> {
    let path = if api_client.is_anthropic() {
        "models?limit=1000"
    } else if api_client.is_openrouter() {
        openrouter_models_path(output_modality)
    } else {
        "models"
    };
    let response = api_client.send_get(path, Duration::from_secs(15)).await?;
    if !response.status().is_success() {
        return Err(upstream_error(response).await);
    }
    let data = response.json::<Value>().await.map_err(map_request_error)?;
    Ok(normalize_models_response(&data))
}

async fn refresh_models(
    cache: &ModelCatalogCache,
    api_client: &AiApiClient,
    output_modality: ModelOutputModality,
) -> AppResult<CachedModelList> {
    let data = fetch_models(api_client, output_modality).await?;
    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let entry = CachedModelList {
        ai_api_type: api_client.api_type_name().to_owned(),
        base_url: api_client.base_url().to_owned(),
        output_modality,
        updated_at,
        data,
    };
    cache.put(entry.clone())?;
    Ok(entry)
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
    let output_modality = ModelOutputModality::from_input(&input)?;
    let force_refresh = input
        .get("forceRefresh")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !force_refresh
        && let Some(entry) = state
            .model_catalog_cache
            .get(&api_client, output_modality)?
    {
        return Ok(Json(json!({
            "data": entry.data,
            "cached": true,
            "updatedAt": entry.updated_at,
        })));
    }
    let entry = refresh_models(&state.model_catalog_cache, &api_client, output_modality).await?;
    Ok(Json(json!({
        "data": entry.data,
        "cached": false,
        "updatedAt": entry.updated_at,
    })))
}

pub async fn run_models_cli_command_if_requested() -> AppResult<bool> {
    let mut args = env::args()
        .skip(1)
        .filter(|arg| arg != "--verbose")
        .collect::<Vec<_>>();
    if args.first().map(String::as_str) != Some("models") {
        return Ok(false);
    }
    args.remove(0);
    let data_dir = parse_config_data_dir(&mut args)?;
    if args.is_empty()
        || matches!(args.as_slice(), [help] if matches!(help.as_str(), "help" | "--help" | "-h"))
    {
        print_models_help();
        return Ok(true);
    }
    let provider = match args.as_slice() {
        [command] if command == "refresh" => "all",
        [command, provider] if command == "refresh" => provider.as_str(),
        _ => {
            return Err(AppError::BadRequest(
                "models コマンドの引数が不正です。kataru models --help を確認してください。"
                    .to_owned(),
            ));
        }
    };
    let manager = AiConfigManager::open(&data_dir)?;
    let effective = manager.effective();
    let providers = if provider == "all" {
        let mut providers = Vec::new();
        if effective.openrouter_api_key.is_some() {
            providers.push("openrouter");
        }
        if effective.openai_api_key.is_some()
            || effective.openai_base_url != DEFAULT_OPENAI_BASE_URL
        {
            providers.push("openai-compatible");
        }
        if effective.anthropic_api_key.is_some() {
            providers.push("anthropic");
        }
        if providers.is_empty() {
            return Err(AppError::BadRequest(
                "モデル一覧を取得できるAI接続設定がありません。先にAPIキーまたは互換APIを設定してください。"
                    .to_owned(),
            ));
        }
        providers
    } else {
        vec![normalize_cli_provider(provider)?]
    };

    let http_client = Client::builder()
        .user_agent(format!("Kataru/{}", env!("CARGO_PKG_VERSION")))
        .build()?;
    let cache = ModelCatalogCache::open(&data_dir)?;
    for provider in providers {
        let api_client = AiApiClient::resolve(
            http_client.clone(),
            "http://127.0.0.1:37371",
            &effective,
            Some(AiApiConfig {
                ai_api_type: Some(provider.to_owned()),
                ..AiApiConfig::default()
            }),
        )?;
        let modalities: &[ModelOutputModality] = if provider == "openrouter" {
            &[
                ModelOutputModality::Text,
                ModelOutputModality::Image,
                ModelOutputModality::Embeddings,
            ]
        } else {
            &[ModelOutputModality::Text]
        };
        for &modality in modalities {
            let entry = refresh_models(&cache, &api_client, modality).await?;
            println!(
                "{provider}/{}: {}件のモデルを更新しました。",
                modality.as_str(),
                entry.data.len()
            );
        }
    }
    Ok(true)
}

fn normalize_cli_provider(provider: &str) -> AppResult<&'static str> {
    match provider {
        "openrouter" => Ok("openrouter"),
        "openai" | "openai-compatible" => Ok("openai-compatible"),
        "anthropic" => Ok("anthropic"),
        _ => Err(AppError::BadRequest(format!(
            "未対応のAI接続先です: {provider}"
        ))),
    }
}

fn print_models_help() {
    println!(
        "Kataru models\n\n  models refresh [all|openrouter|openai|anthropic]\n\n  --data-dir <PATH>  キャッシュを保存するデータ保存先\n  --portable         実行ファイル横の kataru-data を使用"
    );
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
        .send_get("providers", Duration::from_secs(15))
        .await?;
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
                AvailableModel {
                    id: "claude-sonnet-4-6".to_owned(),
                    name: "Claude Sonnet 4.6".to_owned()
                },
                AvailableModel {
                    id: "openai/gpt-5".to_owned(),
                    name: "GPT-5".to_owned()
                },
                AvailableModel {
                    id: "plain-model".to_owned(),
                    name: "plain-model".to_owned()
                },
            ]
        );
    }

    #[test]
    fn model_list_drops_blank_and_duplicate_ids() {
        let models = normalize_models_response(&json!({
            "data": ["model-b", { "id": "model-b", "name": "Duplicate" }, { "id": "  " }]
        }));

        assert_eq!(
            models,
            vec![AvailableModel {
                id: "model-b".to_owned(),
                name: "model-b".to_owned(),
            }]
        );
    }

    #[test]
    fn openrouter_model_list_path_filters_by_output_modality() {
        assert_eq!(
            openrouter_models_path(ModelOutputModality::Text),
            "models?output_modalities=text"
        );
        assert_eq!(
            openrouter_models_path(ModelOutputModality::Image),
            "models?output_modalities=image"
        );
        assert_eq!(
            openrouter_models_path(ModelOutputModality::Embeddings),
            "models?output_modalities=embeddings"
        );
    }

    #[test]
    fn openrouter_model_list_path_rejects_unknown_output_modality() {
        assert!(ModelOutputModality::from_input(&json!({ "outputModality": "audio" })).is_err());
    }

    #[test]
    fn model_cache_persists_and_scopes_entries() {
        let directory = tempfile::tempdir().unwrap();
        let cache = ModelCatalogCache::open(directory.path()).unwrap();
        cache
            .put(CachedModelList {
                ai_api_type: "openrouter".to_owned(),
                base_url: "https://openrouter.ai/api/v1".to_owned(),
                output_modality: ModelOutputModality::Text,
                updated_at: 123,
                data: vec![AvailableModel {
                    id: "model-a".to_owned(),
                    name: "Model A".to_owned(),
                }],
            })
            .unwrap();

        let api_client = AiApiClient::resolve(
            Client::new(),
            "http://127.0.0.1:37371",
            &crate::ai_config::EffectiveAiConfig {
                openrouter_api_key: Some("secret".to_owned()),
                openai_base_url: DEFAULT_OPENAI_BASE_URL.to_owned(),
                openai_api_key: None,
                anthropic_base_url: "https://api.anthropic.com/v1".to_owned(),
                anthropic_api_key: None,
            },
            None,
        )
        .unwrap();
        let reopened = ModelCatalogCache::open(directory.path()).unwrap();
        let stored = reopened
            .get(&api_client, ModelOutputModality::Text)
            .unwrap()
            .unwrap();

        assert_eq!(stored.data[0].id, "model-a");
        assert_eq!(stored.updated_at, 123);
        assert!(
            reopened
                .get(&api_client, ModelOutputModality::Image)
                .unwrap()
                .is_none()
        );
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
