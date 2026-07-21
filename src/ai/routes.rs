use axum::{
    Json,
    body::Body,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Value, json};
use std::time::Duration;

use crate::{
    AppState,
    error::{AppError, AppResult},
};

use super::provider::{Provider, map_request_error};

const DEFAULT_AUTO_GENERATION_MODEL: &str = "z-ai/glm-5.2";
const DEFAULT_TITLE_GENERATION_MODEL: &str = "deepseek/deepseek-v4-flash";
const DEFAULT_MEMORY_EXTRACTION_MODEL: &str = "deepseek/deepseek-v4-flash";
const DEFAULT_MEMORY_EMBEDDING_MODEL: &str = "qwen/qwen3-embedding-8b";

fn provider_for(state: &AppState, body: &Value) -> AppResult<Provider> {
    Provider::from_state(state, body.get("aiProviderConfig"))
}

pub async fn connection_status(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> Json<Value> {
    let provider = match provider_for(&state, &input) {
        Ok(provider) => provider,
        Err(_) => {
            return Json(json!({
                "ready": false,
                "code": "missing_configuration",
                "message": "会話に使うAIの設定が見つかりません。"
            }));
        }
    };

    match provider.get("models", Duration::from_secs(8)).send().await {
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

fn required_string(body: &Value, field: &str, message: &str) -> AppResult<String> {
    body.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::BadRequest(message.to_owned()))
}

fn optional_trimmed_string(body: &Value, field: &str) -> Option<String> {
    body.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn copy_if_present(target: &mut Map<String, Value>, source: &Value, from: &str, to: &str) {
    if let Some(value) = source.get(from)
        && !value.is_null()
    {
        target.insert(to.to_owned(), value.clone());
    }
}

async fn upstream_error(response: reqwest::Response) -> AppError {
    let status = response.status();
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

async fn read_upstream_json(response: reqwest::Response) -> AppResult<Value> {
    if !response.status().is_success() {
        return Err(upstream_error(response).await);
    }
    response.json::<Value>().await.map_err(map_request_error)
}

async fn raw_upstream_response(response: reqwest::Response) -> AppResult<Response> {
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

async fn successful_json_response(response: reqwest::Response) -> AppResult<Response> {
    if !response.status().is_success() {
        return Err(upstream_error(response).await);
    }
    let bytes = response.bytes().await.map_err(map_request_error)?;
    let mut output = Response::new(Body::from(bytes));
    output.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(output)
}

fn build_chat_body(
    input: &Value,
    provider: &Provider,
    use_required_parameters: bool,
    use_response_format: bool,
    should_stream: bool,
) -> AppResult<Value> {
    let model = required_string(input, "model", "model は必須です。")?;
    let input_messages = input
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::BadRequest("messages は配列である必要があります。".to_owned()))?;
    let mut messages = Vec::with_capacity(input_messages.len() + 1);
    if let Some(system_prompt) = input.get("systemPrompt").and_then(Value::as_str)
        && !system_prompt.is_empty()
    {
        messages.push(json!({ "role": "system", "content": system_prompt }));
    }
    messages.extend(input_messages.iter().cloned());

    let requested_response_format = input
        .get("responseFormat")
        .or_else(|| input.get("response_format"));
    let mut body = Map::new();
    body.insert("model".to_owned(), Value::String(model));
    body.insert("messages".to_owned(), Value::Array(messages));
    body.insert("stream".to_owned(), Value::Bool(should_stream));
    copy_if_present(&mut body, input, "maxTokens", "max_tokens");
    copy_if_present(&mut body, input, "temperature", "temperature");
    copy_if_present(&mut body, input, "topP", "top_p");
    if use_response_format && let Some(response_format) = requested_response_format {
        body.insert("response_format".to_owned(), response_format.clone());
    }

    if provider.is_openrouter() {
        let effort = match input.get("reasoningEffort").and_then(Value::as_str) {
            Some("low") => "low",
            Some("medium") => "medium",
            Some("high") => "high",
            _ => "none",
        };
        body.insert("reasoning".to_owned(), json!({ "effort": effort }));
        copy_if_present(&mut body, input, "topK", "top_k");
        if should_stream {
            body.insert(
                "stream_options".to_owned(),
                json!({ "include_usage": true }),
            );
        }
        if use_response_format && requested_response_format.is_some() && use_required_parameters {
            body.insert("provider".to_owned(), json!({ "require_parameters": true }));
        }
    }
    Ok(Value::Object(body))
}

async fn send_chat_attempt(
    provider: &Provider,
    input: &Value,
    use_required_parameters: bool,
    use_response_format: bool,
    should_stream: bool,
) -> AppResult<reqwest::Response> {
    let body = build_chat_body(
        input,
        provider,
        use_required_parameters,
        use_response_format,
        should_stream,
    )?;
    provider.send_json("chat/completions", &body, 120).await
}

pub async fn chat(State(state): State<AppState>, Json(input): Json<Value>) -> AppResult<Response> {
    let provider = provider_for(&state, &input)?;
    let should_stream = input.get("stream").and_then(Value::as_bool) != Some(false);
    let has_response_format = input
        .get("responseFormat")
        .or_else(|| input.get("response_format"))
        .is_some_and(|value| !value.is_null());
    let require_parameters = has_response_format
        && input.get("requireParameters").and_then(Value::as_bool) == Some(true);

    let mut upstream = send_chat_attempt(
        &provider,
        &input,
        require_parameters,
        has_response_format,
        should_stream,
    )
    .await?;

    if !upstream.status().is_success() {
        let retry_without_required =
            provider.is_openrouter() && has_response_format && require_parameters;
        let retry_without_format = !provider.is_openrouter() && has_response_format;
        if retry_without_required || retry_without_format {
            upstream = send_chat_attempt(
                &provider,
                &input,
                false,
                !retry_without_format,
                should_stream,
            )
            .await?;
        }
        if provider.is_openrouter() && has_response_format && !upstream.status().is_success() {
            upstream = send_chat_attempt(&provider, &input, false, false, should_stream).await?;
        }
    }

    if !upstream.status().is_success() {
        return Err(upstream_error(upstream).await);
    }
    if !should_stream {
        return successful_json_response(upstream).await;
    }

    let stream = upstream.bytes_stream();
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    Ok(response)
}

fn response_format_for_schema(schema: Value) -> Value {
    if schema.get("type").and_then(Value::as_str) == Some("json_schema") {
        schema
    } else {
        json!({
            "type": "json_schema",
            "json_schema": schema,
        })
    }
}

async fn structured_attempt(
    provider: &Provider,
    request: &Value,
    response_format: &Value,
    use_response_format: bool,
    require_parameters: bool,
    timeout_secs: u64,
) -> AppResult<reqwest::Response> {
    let mut body = request.as_object().cloned().ok_or_else(|| {
        AppError::BadRequest(
            "completion request はJSONオブジェクトである必要があります。".to_owned(),
        )
    })?;
    if let Some(system_prompt) = body
        .remove("systemPrompt")
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .filter(|value| !value.is_empty())
    {
        let mut messages = body
            .remove("messages")
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();
        messages.insert(
            0,
            json!({
                "role": "system",
                "content": system_prompt
            }),
        );
        body.insert("messages".to_owned(), Value::Array(messages));
    }
    for (camel_case, snake_case) in [
        ("maxTokens", "max_tokens"),
        ("topP", "top_p"),
        ("topK", "top_k"),
    ] {
        if !body.contains_key(snake_case)
            && let Some(value) = body.remove(camel_case)
        {
            body.insert(snake_case.to_owned(), value);
        } else {
            body.remove(camel_case);
        }
    }
    body.remove("requireParameters");
    body.insert("stream".to_owned(), Value::Bool(false));
    if use_response_format {
        body.insert("response_format".to_owned(), response_format.clone());
    } else {
        body.remove("response_format");
    }
    if provider.is_openrouter() {
        let requested_effort = body
            .remove("reasoningEffort")
            .and_then(|value| value.as_str().map(ToOwned::to_owned));
        if !body.contains_key("reasoning") {
            let is_memory_extraction = response_format
                .pointer("/json_schema/name")
                .and_then(Value::as_str)
                == Some("memory_save_updates");
            let effort = match requested_effort.as_deref() {
                Some("low") => "low",
                Some("medium") => "medium",
                Some("high") => "high",
                _ if is_memory_extraction => "medium",
                _ => "none",
            };
            body.insert("reasoning".to_owned(), json!({ "effort": effort }));
        }
        let mut provider_options = body
            .get("provider")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if use_response_format && require_parameters {
            provider_options.insert("require_parameters".to_owned(), Value::Bool(true));
        } else {
            provider_options.remove("require_parameters");
        }
        if provider_options.is_empty() {
            body.remove("provider");
        } else {
            body.insert("provider".to_owned(), Value::Object(provider_options));
        }
    } else {
        body.remove("reasoningEffort");
        body.remove("top_k");
    }
    provider
        .send_json("chat/completions", &Value::Object(body), timeout_secs)
        .await
}

pub(crate) async fn structured_completion(
    provider: &Provider,
    request: Value,
    schema: Value,
    timeout_secs: u64,
) -> AppResult<Value> {
    let response_format = response_format_for_schema(schema);
    let first = structured_attempt(
        provider,
        &request,
        &response_format,
        true,
        true,
        timeout_secs,
    )
    .await?;
    if first.status().is_success() {
        return read_upstream_json(first).await;
    }
    if !provider.is_openrouter() {
        return Err(upstream_error(first).await);
    }

    let second = structured_attempt(
        provider,
        &request,
        &response_format,
        true,
        false,
        timeout_secs,
    )
    .await?;
    if second.status().is_success() {
        return read_upstream_json(second).await;
    }
    Err(upstream_error(second).await)
}

fn extract_content_text(content: &Value) -> String {
    match content {
        Value::String(value) => value.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(value) => Some(value.as_str()),
                Value::Object(record) => record
                    .get("text")
                    .or_else(|| record.get("content"))
                    .and_then(Value::as_str),
                _ => None,
            })
            .collect(),
        _ => String::new(),
    }
}

pub(crate) fn extract_message_text(data: &Value) -> String {
    data.pointer("/choices/0/message/content")
        .map(extract_content_text)
        .unwrap_or_else(|| extract_content_text(data))
}

async fn plain_completion(provider: &Provider, body: Value, timeout_secs: u64) -> AppResult<Value> {
    let response = provider
        .send_json("chat/completions", &body, timeout_secs)
        .await?;
    read_upstream_json(response).await
}

pub async fn summarize(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let provider = provider_for(&state, &input)?;
    let messages = input
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::BadRequest("messages は配列である必要があります。".to_owned()))?;
    let model = required_string(&input, "model", "model は必須です。")?;
    let is_group_chat = input
        .get("isGroupChat")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let system_prompt = if is_group_chat {
        "You are a summarization assistant for a group roleplay conversation with multiple characters. Your task is to compress conversation history into a concise summary while preserving critical roleplay context. Preserve: each character's name and who said what, character relationships, key plot events, emotional developments, world-building facts, decisions, and current scene context. Write in the same language as the conversation. Be thorough but concise. Output only summary text without commentary."
    } else {
        "You are a summarization assistant for a roleplay conversation. Your task is to compress conversation history into a concise summary while preserving critical roleplay context. Preserve: character names and relationships, key plot events, emotional developments, world-building facts, decisions, and current scene context. Write in the same language as the conversation. Be thorough but concise. Output only summary text without commentary."
    };
    let previous_summary = optional_trimmed_string(&input, "previousSummary")
        .map(|summary| format!("Existing summary to merge and deduplicate:\n{summary}\n\n"))
        .unwrap_or_default();
    let transcript = messages
        .iter()
        .filter_map(|message| {
            let record = message.as_object()?;
            let role = record.get("role")?.as_str()?;
            let content = record.get("content")?.as_str()?;
            if role == "user" {
                return Some(format!("User: {content}"));
            }
            if let Some(name) = record.get("name").and_then(Value::as_str) {
                let to_suffix = record
                    .get("to")
                    .and_then(Value::as_array)
                    .map(|to| {
                        to.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .filter(|to| !to.is_empty())
                    .map(|to| format!(" -> {to}"))
                    .unwrap_or_default();
                Some(format!("{name}{to_suffix}: {content}"))
            } else {
                Some(format!("Assistant: {content}"))
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let user_prompt = format!(
        "{previous_summary}Please summarize the following conversation history:\n\n{transcript}"
    );
    let mut request = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "stream": false,
        "max_tokens": 2048
    });
    if provider.is_openrouter() {
        request["reasoning"] = json!({ "effort": "none" });
    }
    let data = plain_completion(&provider, request, 60).await?;
    Ok(Json(json!({ "summary": extract_message_text(&data) })).into_response())
}

pub async fn embeddings(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let provider = provider_for(&state, &input)?;
    if !provider.embeddings_enabled() {
        return Ok(Json(json!({ "data": [], "disabled": true })).into_response());
    }
    let embedding_input = input.get("input").cloned().ok_or_else(|| {
        AppError::BadRequest("input は文字列、または入力配列である必要があります。".to_owned())
    })?;
    let valid_input = embedding_input.is_string()
        || embedding_input.as_array().is_some_and(|values| {
            values
                .iter()
                .all(|value| value.is_string() || value.is_object())
        });
    if !valid_input {
        return Err(AppError::BadRequest(
            "input は文字列、または入力配列である必要があります。".to_owned(),
        ));
    }
    let model = optional_trimmed_string(&input, "model")
        .unwrap_or_else(|| DEFAULT_MEMORY_EMBEDDING_MODEL.to_owned());
    let input_type = input
        .get("inputType")
        .or_else(|| input.get("input_type"))
        .and_then(Value::as_str);
    let mut body = json!({
        "input": embedding_input,
        "model": model,
        "encoding_format": "float"
    });
    if let Some(dimensions) = input.get("dimensions").and_then(Value::as_u64)
        && dimensions > 0
    {
        body["dimensions"] = json!(dimensions);
    }
    if provider.is_openrouter() {
        if let Some(input_type) = input_type {
            body["input_type"] = json!(input_type);
        }
        body["provider"] = input
            .get("provider")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({ "data_collection": "deny" }));
    }
    let upstream = provider.send_json("embeddings", &body, 60).await?;
    raw_upstream_response(upstream).await
}

fn image_size(aspect_ratio: Option<&str>) -> &'static str {
    match aspect_ratio {
        Some("2:3") => "1024x1536",
        Some("3:2") => "1536x1024",
        _ => "1024x1024",
    }
}

pub async fn generate_image(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let provider = provider_for(&state, &input)?;
    let prompt = required_string(&input, "prompt", "prompt と model は必須です。")?;
    let model = required_string(&input, "model", "prompt と model は必須です。")?;
    let inline_base_image = optional_trimmed_string(&input, "baseImage");
    let base_image_asset_id = optional_trimmed_string(&input, "baseImageAssetId");
    if inline_base_image.is_some() && base_image_asset_id.is_some() {
        return Err(AppError::BadRequest(
            "baseImage と baseImageAssetId は同時に指定できません。".to_owned(),
        ));
    }
    let base_image = if let Some(asset_id) = base_image_asset_id {
        if asset_id.len() != 64 || !asset_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AppError::BadRequest(
                "baseImageAssetId が不正です。".to_owned(),
            ));
        }
        let asset = state
            .database
            .get_image_asset(asset_id)
            .await?
            .ok_or_else(|| AppError::NotFound("元画像が見つかりません。".to_owned()))?;
        Some(format!(
            "data:{};base64,{}",
            asset.mime_type,
            BASE64.encode(asset.data)
        ))
    } else {
        inline_base_image
    };
    let aspect_ratio = input.get("aspectRatio").and_then(Value::as_str);

    if !provider.is_openrouter() {
        if !provider.image_generation_enabled() {
            return Err(AppError::BadRequest(
                "OpenAI互換APIでの画像生成は設定で無効化されています。".to_owned(),
            ));
        }
        if base_image.is_some() {
            return Err(AppError::Upstream(
                "OpenAI互換APIでの画像生成は、元画像を使う差分生成には対応していません。"
                    .to_owned(),
                StatusCode::NOT_IMPLEMENTED,
            ));
        }
        let upstream = provider
            .send_json(
                "images/generations",
                &json!({
                    "model": model,
                    "prompt": prompt,
                    "size": image_size(aspect_ratio),
                    "response_format": "b64_json",
                    "n": 1
                }),
                180,
            )
            .await?;
        let data = read_upstream_json(upstream).await?;
        let item = data.pointer("/data/0");
        let image = item
            .and_then(|value| value.get("b64_json"))
            .and_then(Value::as_str)
            .map(|base64| {
                if base64.starts_with("data:image") {
                    base64.to_owned()
                } else {
                    format!("data:image/png;base64,{base64}")
                }
            })
            .or_else(|| {
                item.and_then(|value| value.get("url"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .ok_or_else(|| {
                AppError::Upstream(
                    "画像が生成されませんでした。".to_owned(),
                    StatusCode::BAD_GATEWAY,
                )
            })?;
        return Ok(Json(json!({
            "image": image,
            "usage": data.get("usage").cloned().unwrap_or(Value::Null)
        }))
        .into_response());
    }

    let mut user_content = vec![json!({ "type": "text", "text": prompt })];
    if let Some(base_image) = base_image {
        user_content.insert(
            0,
            json!({ "type": "image_url", "image_url": { "url": base_image } }),
        );
    }
    let mut body = json!({
        "model": model,
        "modalities": ["image"],
        "messages": [{ "role": "user", "content": user_content }]
    });
    if let Some(aspect_ratio) = aspect_ratio {
        body["image_config"] = json!({ "aspect_ratio": aspect_ratio });
    }
    let data =
        read_upstream_json(provider.send_json("chat/completions", &body, 180).await?).await?;
    let message = data.pointer("/choices/0/message");
    let image = message
        .and_then(|value| value.pointer("/images/0/image_url/url"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            message
                .and_then(|value| value.get("content"))
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("data:image"))
                .map(ToOwned::to_owned)
        });
    let Some(image) = image else {
        return Ok((
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": "画像が生成されませんでした。",
                "raw": data
            })),
        )
            .into_response());
    };
    Ok(Json(json!({
        "image": image,
        "usage": data.get("usage").cloned().unwrap_or(Value::Null)
    }))
    .into_response())
}

fn parse_json_object_text(content: &str) -> Option<Value> {
    let trimmed = content.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed)
        && value.is_object()
    {
        return Some(value);
    }
    if let Some(start_fence) = trimmed.find("```") {
        let after_open = &trimmed[start_fence + 3..];
        let after_language = after_open
            .strip_prefix("json")
            .or_else(|| after_open.strip_prefix("JSON"))
            .unwrap_or(after_open);
        if let Some(end_fence) = after_language.find("```")
            && let Ok(value) = serde_json::from_str::<Value>(after_language[..end_fence].trim())
            && value.is_object()
        {
            return Some(value);
        }
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&trimmed[start..=end])
        .ok()
        .filter(Value::is_object)
}

fn pick_string(source: &Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        match source.get(*key) {
            Some(Value::String(value)) if !value.trim().is_empty() => {
                return value.trim().to_owned();
            }
            Some(Value::Array(values)) => {
                let joined = values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !joined.is_empty() {
                    return joined;
                }
            }
            _ => {}
        }
    }
    String::new()
}

fn normalize_character(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let name = pick_string(source, &["name", "名前"]);
    let gender = pick_string(source, &["gender", "性別"]);
    let first_person = pick_string(source, &["firstPerson", "first_person", "一人称"]);
    let protagonist_address = pick_string(
        source,
        &[
            "protagonistAddress",
            "protagonist_address",
            "主人公への呼び方",
            "主人公の呼び方",
        ],
    );
    let relationship = pick_string(source, &["relationship", "主人公から見た関係性", "関係性"]);
    let details = pick_string(source, &["details", "詳細"]);
    if [
        &name,
        &gender,
        &first_person,
        &protagonist_address,
        &relationship,
        &details,
    ]
    .iter()
    .any(|value| value.is_empty())
    {
        return None;
    }
    Some(json!({
        "name": name,
        "gender": gender,
        "firstPerson": first_person,
        "protagonistAddress": protagonist_address,
        "relationship": relationship,
        "details": details
    }))
}

fn character_schema() -> Value {
    json!({
        "name": "roleplay_character_profile",
        "strict": true,
        "schema": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "name",
                "gender",
                "firstPerson",
                "protagonistAddress",
                "relationship",
                "details"
            ],
            "properties": {
                "name": { "type": "string" },
                "gender": { "type": "string" },
                "firstPerson": { "type": "string" },
                "protagonistAddress": { "type": "string" },
                "relationship": { "type": "string" },
                "details": { "type": "string" }
            }
        }
    })
}

pub async fn generate_character(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let provider = provider_for(&state, &input)?;
    let direction = optional_trimmed_string(&input, "direction").unwrap_or_default();
    let model = optional_trimmed_string(&input, "model")
        .unwrap_or_else(|| DEFAULT_AUTO_GENERATION_MODEL.to_owned());
    let system_prompt = r#"
完全にオリジナルなキャラクター概要を説明文として作成してください。
出力はJSONのみで、Markdownを使用しないでください。値は全て日本語である必要があります。
ユーザーのことは主人公と表記してください。
details には、キャラクター情報の詳細（プロフィール。職業または学生、経歴、性格、振る舞い、周りからの印象等）について記載してください。すでに記述した内容は不要です。
detailsのそれぞれのカテゴリは"職業:"のように区切り、一行分空白にしてください。"#;
    let user_prompt = if direction.is_empty() {
        "完全におまかせで、ロールプレイに使いやすいキャラクターを1人作成してください。".to_owned()
    } else {
        format!("次の方向性でキャラクターを1人作成してください。\n\n方向性:\n{direction}")
    };
    let mut request = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "temperature": if direction.is_empty() { 1.05 } else { 0.9 },
        "max_tokens": 1200
    });
    if provider.is_openrouter() {
        request["reasoning"] = json!({ "effort": "none" });
    }
    let data = structured_completion(&provider, request, character_schema(), 60).await?;
    let content = extract_message_text(&data);
    if content.trim().is_empty() {
        return Err(AppError::Upstream(
            "キャラクター生成結果が空でした。".to_owned(),
            StatusCode::BAD_GATEWAY,
        ));
    }
    let character = parse_json_object_text(&content)
        .as_ref()
        .and_then(normalize_character)
        .ok_or_else(|| {
            AppError::Upstream(
                "キャラクター生成結果の形式が不正でした。".to_owned(),
                StatusCode::BAD_GATEWAY,
            )
        })?;
    Ok(Json(json!({
        "character": character,
        "usage": data.get("usage").cloned().unwrap_or(Value::Null)
    }))
    .into_response())
}

fn situation_description_schema() -> Value {
    json!({
        "name": "roleplay_situation_description",
        "strict": true,
        "schema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["description"],
            "properties": {
                "description": { "type": "string" }
            }
        }
    })
}

pub async fn generate_situation_description(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let provider = provider_for(&state, &input)?;
    let direction = optional_trimmed_string(&input, "direction").unwrap_or_default();
    let current_description =
        optional_trimmed_string(&input, "currentDescription").unwrap_or_default();
    let situation_name = optional_trimmed_string(&input, "situationName").unwrap_or_default();
    let participants = input
        .get("participants")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .take(20)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let model = optional_trimmed_string(&input, "model")
        .unwrap_or_else(|| DEFAULT_AUTO_GENERATION_MODEL.to_owned());
    let system_prompt = [
        "You generate concise but vivid Japanese situation descriptions for a roleplay chat app.",
        "Output JSON only. Do not wrap it in markdown.",
        "The description must be directly usable as a system-level situation prompt.",
        "Do not include UI instructions, meta commentary, or placeholder text.",
    ]
    .join("\n");
    let mut context_lines = Vec::new();
    if !situation_name.is_empty() {
        context_lines.push(format!("シチュエーション名: {situation_name}"));
    }
    if !participants.is_empty() {
        context_lines.push(format!("登場人物: {}", participants.join("、")));
    }
    if !current_description.is_empty() {
        context_lines.push(format!("現在の説明:\n{current_description}"));
    }
    if !direction.is_empty() {
        context_lines.push(format!("補完・生成の方向性:\n{direction}"));
    }
    let user_prompt = if context_lines.is_empty() {
        "完全におまかせで、ロールプレイ会話で使いやすいシチュエーション説明文を1つ作成してください。"
            .to_owned()
    } else {
        format!(
            "次の情報をもとに、ロールプレイ会話で使いやすいシチュエーション説明文を作成してください。\n\
             舞台、関係性、開始時点の状況、会話の緊張感や目的が自然に伝わるようにしてください。\n\
             既存の説明がある場合は、破綻しない範囲で補強・整理してください。\n\n{}",
            context_lines.join("\n\n")
        )
    };
    let mut request = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "temperature": if direction.is_empty() { 1.0 } else { 0.85 },
        "max_tokens": 1000
    });
    if provider.is_openrouter() {
        request["reasoning"] = json!({ "effort": "none" });
    }
    let data =
        structured_completion(&provider, request, situation_description_schema(), 60).await?;
    let content = extract_message_text(&data);
    if content.trim().is_empty() {
        return Err(AppError::Upstream(
            "シチュエーション説明の生成結果が空でした。".to_owned(),
            StatusCode::BAD_GATEWAY,
        ));
    }
    let description = parse_json_object_text(&content)
        .and_then(|value| {
            value
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
        .ok_or_else(|| {
            AppError::Upstream(
                "シチュエーション説明の生成結果の形式が不正でした。".to_owned(),
                StatusCode::BAD_GATEWAY,
            )
        })?;
    Ok(Json(json!({
        "description": description,
        "usage": data.get("usage").cloned().unwrap_or(Value::Null)
    }))
    .into_response())
}

fn take_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn normalize_title_messages(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let record = item.as_object()?;
            let role = match record.get("role").and_then(Value::as_str) {
                Some("assistant") => "assistant",
                Some("user") => "user",
                _ => return None,
            };
            let content = record.get("content")?.as_str()?.trim();
            if content.is_empty() {
                return None;
            }
            let mut message = json!({
                "role": role,
                "content": take_chars(content, 1600)
            });
            if let Some(name) = record
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                message["name"] = json!(name);
            }
            Some(message)
        })
        .take(12)
        .collect()
}

fn normalize_generated_title(content: &str) -> Option<String> {
    let without_fence = content
        .replace("```json", "")
        .replace("```JSON", "")
        .replace("```", "");
    let first_line = without_fence
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let mut title = first_line.to_owned();
    let lower = title.to_ascii_lowercase();
    if lower.starts_with("title:") {
        title = title["title:".len()..].trim().to_owned();
    } else if let Some(value) = title
        .strip_prefix("タイトル:")
        .or_else(|| title.strip_prefix("タイトル："))
    {
        title = value.trim().to_owned();
    }
    title = title
        .trim_start_matches(|character: char| {
            character.is_whitespace()
                || matches!(character, '-' | '*' | '#' | '.' | '．')
                || character.is_ascii_digit()
        })
        .trim()
        .to_owned();
    title = title
        .trim_start_matches(|character| {
            matches!(
                character,
                '`' | '"' | '\'' | '“' | '”' | '‘' | '’' | '「' | '『' | '【' | '（' | '('
            )
        })
        .trim_end_matches(|character: char| {
            matches!(
                character,
                '`' | '"'
                    | '\''
                    | '“'
                    | '”'
                    | '‘'
                    | '’'
                    | '」'
                    | '』'
                    | '】'
                    | '）'
                    | ')'
                    | '。'
                    | '.'
                    | '!'
                    | '！'
                    | '?'
                    | '？'
            )
        })
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        None
    } else {
        Some(take_chars(&title, 40).trim().to_owned())
    }
}

pub async fn generate_title(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let provider = provider_for(&state, &input)?;
    let messages = normalize_title_messages(input.get("messages"));
    if messages.is_empty() {
        return Err(AppError::BadRequest(
            "タイトル生成に必要な会話がありません。".to_owned(),
        ));
    }
    let model = optional_trimmed_string(&input, "model")
        .unwrap_or_else(|| DEFAULT_TITLE_GENERATION_MODEL.to_owned());
    let transcript = messages
        .iter()
        .filter_map(|message| {
            let record = message.as_object()?;
            let role = record.get("role")?.as_str()?;
            let content = record.get("content")?.as_str()?;
            let label = record
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(if role == "user" {
                    "主人公"
                } else {
                    "相手"
                });
            Some(format!("{label}: {content}"))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let system_prompt = r#"あなたはロールプレイチャットアプリのタイトル自動生成器です。
        最初のユーザー発言と最初の返答から、内容が自然に伝わる短いタイトルを1つ作成してください。
        会話が日本語なら日本語で、その他の言語なら会話と同じ言語で書いてください。
        出力はタイトル文字列だけにしてください。説明、引用符、Markdown、句点は出力しないでください。"#;

    let user_prompt = format!(
        "次の最初のやり取りから、チャットルームのタイトルを1つ作成してください。\n\
         目安は日本語なら12〜24文字程度です。\n\n{transcript}"
    );
    let mut request = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "stream": false,
        "temperature": 0.3,
        "max_tokens": 48
    });
    if provider.is_openrouter() {
        request["reasoning"] = json!({ "effort": "none" });
    }
    let data = plain_completion(&provider, request, 60).await?;
    let title = normalize_generated_title(&extract_message_text(&data)).ok_or_else(|| {
        AppError::Upstream(
            "タイトル生成結果が空でした。".to_owned(),
            StatusCode::BAD_GATEWAY,
        )
    })?;
    Ok(Json(json!({
        "title": title,
        "usage": data.get("usage").cloned().unwrap_or(Value::Null)
    }))
    .into_response())
}

pub(crate) fn memory_extraction_prompt() -> &'static str {
    r#"あなたはロールプレイチャットの長期記憶を保存する判定器です。キャラクターとして返答してはいけません。

## 目的

- 直近会話から、次のルールに適合した情報を抽出します。
- 会話履歴がルールに該当しない場合は updates を空配列にします。
- existingMemories と同じ意味の内容は保存しません。
- characterSystemPrompt に含まれるキャラクター設定、人格、口調、世界観、既定の関係性は保存しません。
- 最新のターンのみが対象です。それ以前の履歴はは文脈の確認用です。
- 出力は {"updates": [...]} 形式の JSON のみです。Markdown や説明文を含めてはいけません。

## ルール

### 保存する内容

似た内容は1つのアイテムにまとめて保存します。正確な内容を簡単に、短く記述してください。

- 主人公が明示的に「覚えて」「記憶して」「今後も守って」と依頼した内容
- characterSystemPrompt, existingMemories に含まれない設定
 - 呼び方
 - 好み
 - 苦手
 - NG
 - キャラクター自身の情報
 - 世界観の固有名詞
 など
- 主人公とキャラクターの関係性、約束、距離感の変化

### scope

- character: 対象キャラクターが覚えている主人公情報、好み、指示
- relationship: 主人公と対象キャラクターの関係性、距離感の変化、約束
- world: 継続シナリオ、世界観、事件、固有名詞、場所

### kind

- preference: 好き嫌い、呼ばれ方、話し方の好み、NG
- relationship: 関係性、信頼、約束、距離感
- instruction: 今後の応答で守るべき明示指示
- event: 会話内で起きた出来事、シナリオ進行、過去のエピソード
- fact: 上記以外の安定した事実

### importance
0.85-1.00 呼び方、NG、強い好み、永続設定、大きな関係変化
0.65-0.84 よく参照されそうな好み、約束、継続中のシナリオ事実
0.40-0.64 ときどき役立つ背景情報、軽い好み、最近の出来事
0.00-0.39 保存しない

### confidence
0.90-1.00 主人公が明確に依頼または断定した
0.70-0.89 会話から明確に読み取れる
0.40-0.69 推測を含むため保存しない
0.00-0.39 保存しない"#
}

pub(crate) fn memory_schema() -> Value {
    json!({
        "name": "memory_save_updates",
        "strict": true,
        "schema": {
            "type": "object",
            "properties": {
                "updates": {
                    "type": "array",
                    "maxItems": 5,
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "A concise, stable memory written in Japanese."
                            },
                            "kind": {
                                "type": "string",
                                "enum": [
                                    "fact",
                                    "preference",
                                    "event",
                                    "relationship",
                                    "instruction"
                                ]
                            },
                            "scope": {
                                "type": "string",
                                "enum": ["character", "relationship", "world"]
                            },
                            "importance": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                            },
                            "confidence": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                            }
                        },
                        "required": [
                            "content",
                            "kind",
                            "scope",
                            "importance",
                            "confidence"
                        ],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["updates"],
            "additionalProperties": false
        }
    })
}

fn strip_json_code_fence(content: &str) -> &str {
    let trimmed = content.trim();
    let Some(after_open) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let after_language = after_open
        .strip_prefix("json")
        .or_else(|| after_open.strip_prefix("JSON"))
        .unwrap_or(after_open)
        .trim_start();
    after_language
        .strip_suffix("```")
        .map(str::trim)
        .unwrap_or(trimmed)
}

pub(crate) fn parse_memory_updates(content: &str) -> Vec<Value> {
    let Ok(parsed) = serde_json::from_str::<Value>(strip_json_code_fence(content)) else {
        return Vec::new();
    };
    let Some(updates) = parsed.get("updates").and_then(Value::as_array) else {
        return Vec::new();
    };
    updates
        .iter()
        .filter_map(|update| {
            let record = update.as_object()?;
            let content = record
                .get("content")?
                .as_str()?
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if content.is_empty() {
                return None;
            }
            let kind = record.get("kind")?.as_str()?;
            if !["fact", "preference", "event", "relationship", "instruction"].contains(&kind) {
                return None;
            }
            let scope = record.get("scope")?.as_str()?;
            if !["character", "relationship", "world"].contains(&scope) {
                return None;
            }
            let importance = record.get("importance")?.as_f64()?;
            let confidence = record.get("confidence")?.as_f64()?;
            if !importance.is_finite() || !confidence.is_finite() {
                return None;
            }
            Some(json!({
                "content": content,
                "kind": kind,
                "scope": scope,
                "importance": importance.clamp(0.0, 1.0),
                "confidence": confidence.clamp(0.0, 1.0)
            }))
        })
        .take(5)
        .collect()
}

fn normalize_recent_messages(input: &Value) -> Vec<Value> {
    let mut messages = input
        .get("recentMessages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|message| {
            let record = message.as_object()?;
            let role = record.get("role")?.as_str()?;
            let content = record.get("content")?.as_str()?;
            let mut normalized = json!({
                "role": role,
                "content": content
            });
            if let Some(name) = record.get("name").and_then(Value::as_str) {
                normalized["name"] = json!(name);
            }
            Some(normalized)
        })
        .collect::<Vec<_>>();
    let start = messages.len().saturating_sub(8);
    messages.drain(..start);
    messages
}

fn normalize_existing_memories(input: &Value) -> Vec<Value> {
    input
        .get("existingMemories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|memory| {
            let record = memory.as_object()?;
            let content = record.get("content")?.as_str()?;
            let mut normalized = json!({ "content": content });
            if let Some(kind) = record.get("kind").and_then(Value::as_str) {
                normalized["kind"] = json!(kind);
            }
            if let Some(scope) = record.get("scope").and_then(Value::as_str) {
                normalized["scope"] = json!(scope);
            }
            Some(normalized)
        })
        .take(30)
        .collect()
}

pub async fn extract_memories(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let provider = provider_for(&state, &input)?;
    let model = optional_trimmed_string(&input, "model")
        .unwrap_or_else(|| DEFAULT_MEMORY_EXTRACTION_MODEL.to_owned());
    let recent_messages = normalize_recent_messages(&input);
    if recent_messages.is_empty() {
        return Ok(Json(json!({ "updates": [] })).into_response());
    }
    let character_system_prompt = input
        .get("characterSystemPrompt")
        .and_then(Value::as_str)
        .map(|value| take_chars(value, 8000))
        .unwrap_or_default();
    let user_payload = json!({
        "targetCharacter": input.get("characterName").and_then(Value::as_str),
        "characterSystemPrompt": character_system_prompt,
        "groupName": input.get("groupName").and_then(Value::as_str),
        "recentMessages": recent_messages,
        "existingMemories": normalize_existing_memories(&input)
    });
    let mut request = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": memory_extraction_prompt() },
            { "role": "user", "content": user_payload.to_string() }
        ],
        "temperature": 0.1
    });
    if provider.is_openrouter() {
        request["reasoning"] = json!({ "effort": "medium" });
        request["provider"] = json!({ "data_collection": "deny" });
    }
    let data = structured_completion(&provider, request, memory_schema(), 60).await?;
    let updates = parse_memory_updates(&extract_message_text(&data));
    Ok(Json(json!({
        "updates": updates,
        "usage": data.get("usage").cloned().unwrap_or(Value::Null)
    }))
    .into_response())
}
