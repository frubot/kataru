use axum::http::StatusCode;
use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::error::{AppError, AppResult};

use super::{
    super::api_client::{AiApiClient, map_request_error},
    common::{read_upstream_json, upstream_error},
};

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
    api_client: &AiApiClient,
    request: &Value,
    response_format: &Value,
    use_response_format: bool,
    require_parameters: bool,
    should_stream: bool,
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
        ("frequencyPenalty", "frequency_penalty"),
        ("presencePenalty", "presence_penalty"),
        ("repetitionPenalty", "repetition_penalty"),
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
    body.insert("stream".to_owned(), Value::Bool(should_stream));
    if use_response_format {
        body.insert("response_format".to_owned(), response_format.clone());
    } else {
        body.remove("response_format");
    }
    if api_client.is_openrouter() {
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
                _ if is_memory_extraction => "low",
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
        if should_stream {
            body.insert(
                "stream_options".to_owned(),
                json!({ "include_usage": true }),
            );
        } else {
            body.remove("stream_options");
        }
    } else if api_client.is_openai_compatible() {
        body.remove("reasoningEffort");
        body.remove("top_k");
        body.remove("repetition_penalty");
    } else {
        body.remove("reasoningEffort");
    }
    api_client
        .send_json("chat/completions", &Value::Object(body), timeout_secs)
        .await
}

pub(crate) async fn structured_completion(
    api_client: &AiApiClient,
    request: Value,
    schema: Value,
    timeout_secs: u64,
) -> AppResult<Value> {
    let response_format = response_format_for_schema(schema);
    let first = structured_attempt(
        api_client,
        &request,
        &response_format,
        true,
        true,
        false,
        timeout_secs,
    )
    .await?;
    if first.status().is_success() {
        return read_upstream_json(api_client, first).await;
    }
    if api_client.is_anthropic() && first.status() == StatusCode::BAD_REQUEST {
        drop(first);
        let fallback = structured_attempt(
            api_client,
            &request,
            &response_format,
            false,
            false,
            false,
            timeout_secs,
        )
        .await?;
        if fallback.status().is_success() {
            return read_upstream_json(api_client, fallback).await;
        }
        return Err(upstream_error(fallback).await);
    }
    if !api_client.is_openrouter() {
        return Err(upstream_error(first).await);
    }

    let second = structured_attempt(
        api_client,
        &request,
        &response_format,
        true,
        false,
        false,
        timeout_secs,
    )
    .await?;
    if second.status().is_success() {
        return read_upstream_json(api_client, second).await;
    }
    Err(upstream_error(second).await)
}

fn stream_event_end(buffer: &[u8]) -> Option<(usize, usize)> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4))
        .or_else(|| {
            buffer
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| (index, 2))
        })
}

fn stream_event_data(event: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(event);
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    (!data.is_empty()).then_some(data)
}

#[derive(Default)]
struct StructuredStreamResult {
    id: String,
    model: String,
    content: String,
    usage: Option<Value>,
    finish_reason: Value,
    anthropic_input_tokens: u64,
}

impl StructuredStreamResult {
    fn apply_event<F>(
        &mut self,
        event: &str,
        is_anthropic: bool,
        on_content: &mut F,
    ) -> AppResult<()>
    where
        F: FnMut(&str),
    {
        if event == "[DONE]" {
            return Ok(());
        }
        let value = serde_json::from_str::<Value>(event).map_err(|error| {
            AppError::Upstream(
                format!("ストリーミング応答のJSONを解析できませんでした: {error}"),
                StatusCode::BAD_GATEWAY,
            )
        })?;
        if let Some(error) = value.get("error") {
            return Err(AppError::Upstream(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| error.to_string()),
                StatusCode::BAD_GATEWAY,
            ));
        }

        if is_anthropic {
            match value.get("type").and_then(Value::as_str) {
                Some("message_start") => {
                    let message = value.get("message").unwrap_or(&Value::Null);
                    self.id = message
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    self.model = message
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let usage = message.get("usage").unwrap_or(&Value::Null);
                    self.anthropic_input_tokens = usage
                        .get("input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        + usage
                            .get("cache_creation_input_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                        + usage
                            .get("cache_read_input_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                }
                Some("content_block_delta")
                    if value.pointer("/delta/type").and_then(Value::as_str)
                        == Some("text_delta") =>
                {
                    let delta = value
                        .pointer("/delta/text")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    self.content.push_str(delta);
                    on_content(&self.content);
                }
                Some("message_delta") => {
                    let completion_tokens = value
                        .pointer("/usage/output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    self.usage = Some(json!({
                        "prompt_tokens": self.anthropic_input_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": self.anthropic_input_tokens + completion_tokens,
                    }));
                    self.finish_reason =
                        match value.pointer("/delta/stop_reason").and_then(Value::as_str) {
                            Some("max_tokens" | "model_context_window_exceeded") => {
                                Value::String("length".to_owned())
                            }
                            Some("tool_use") => Value::String("tool_calls".to_owned()),
                            Some(_) => Value::String("stop".to_owned()),
                            None => Value::Null,
                        };
                }
                _ => {}
            }
            return Ok(());
        }

        if let Some(id) = value.get("id").and_then(Value::as_str) {
            self.id = id.to_owned();
        }
        if let Some(model) = value.get("model").and_then(Value::as_str) {
            self.model = model.to_owned();
        }
        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            self.usage = Some(usage.clone());
        }
        if let Some(reason) = value
            .pointer("/choices/0/finish_reason")
            .filter(|reason| !reason.is_null())
        {
            self.finish_reason = reason.clone();
        }
        let delta = value
            .pointer("/choices/0/delta/content")
            .map(extract_content_text)
            .filter(|content| !content.is_empty())
            .or_else(|| {
                value
                    .pointer("/choices/0/message/content")
                    .map(extract_content_text)
                    .filter(|content| !content.is_empty())
            });
        if let Some(delta) = delta {
            self.content.push_str(&delta);
            on_content(&self.content);
        }
        Ok(())
    }

    fn into_response(self) -> Value {
        let mut response = json!({
            "id": self.id,
            "object": "chat.completion",
            "model": self.model,
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": self.content },
                "finish_reason": self.finish_reason,
            }],
        });
        if let Some(usage) = self.usage {
            response["usage"] = usage;
        }
        response
    }
}

async fn read_structured_stream<F>(
    api_client: &AiApiClient,
    response: reqwest::Response,
    on_content: &mut F,
) -> AppResult<Value>
where
    F: FnMut(&str),
{
    if !response.status().is_success() {
        return Err(upstream_error(response).await);
    }
    let mut result = StructuredStreamResult::default();
    let mut buffer = Vec::new();
    let mut upstream = response.bytes_stream();
    while let Some(chunk) = upstream.next().await {
        buffer.extend_from_slice(&chunk.map_err(map_request_error)?);
        while let Some((index, delimiter_len)) = stream_event_end(&buffer) {
            let event = buffer[..index].to_vec();
            buffer.drain(..index + delimiter_len);
            if let Some(data) = stream_event_data(&event) {
                result.apply_event(&data, api_client.is_anthropic(), on_content)?;
            }
        }
    }
    if !buffer.is_empty()
        && let Some(data) = stream_event_data(&buffer)
    {
        result.apply_event(&data, api_client.is_anthropic(), on_content)?;
    }
    Ok(result.into_response())
}

pub(crate) async fn structured_completion_streaming<F>(
    api_client: &AiApiClient,
    request: Value,
    schema: Value,
    timeout_secs: u64,
    mut on_content: F,
) -> AppResult<Value>
where
    F: FnMut(&str),
{
    let response_format = response_format_for_schema(schema);
    let first = structured_attempt(
        api_client,
        &request,
        &response_format,
        true,
        true,
        true,
        timeout_secs,
    )
    .await?;
    if first.status().is_success() {
        return read_structured_stream(api_client, first, &mut on_content).await;
    }
    if api_client.is_anthropic() && first.status() == StatusCode::BAD_REQUEST {
        drop(first);
        let fallback = structured_attempt(
            api_client,
            &request,
            &response_format,
            false,
            false,
            true,
            timeout_secs,
        )
        .await?;
        if fallback.status().is_success() {
            return read_structured_stream(api_client, fallback, &mut on_content).await;
        }
        return Err(upstream_error(fallback).await);
    }
    if !api_client.is_openrouter() {
        return Err(upstream_error(first).await);
    }

    let second = structured_attempt(
        api_client,
        &request,
        &response_format,
        true,
        false,
        true,
        timeout_secs,
    )
    .await?;
    if second.status().is_success() {
        return read_structured_stream(api_client, second, &mut on_content).await;
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

pub(super) async fn plain_completion(
    api_client: &AiApiClient,
    body: Value,
    timeout_secs: u64,
) -> AppResult<Value> {
    let response = api_client
        .send_json("chat/completions", &body, timeout_secs)
        .await?;
    read_upstream_json(api_client, response).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_openai_structured_stream_content_and_usage() {
        let mut result = StructuredStreamResult::default();
        let mut snapshots = Vec::new();
        let mut capture = |content: &str| snapshots.push(content.to_owned());

        result
            .apply_event(
                r#"{"id":"chat-1","model":"model-1","choices":[{"delta":{"content":"{\"message\":\"こん"},"finish_reason":null}]}"#,
                false,
                &mut capture,
            )
            .unwrap();
        result
            .apply_event(
                r#"{"choices":[{"delta":{"content":"にちは\"}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}"#,
                false,
                &mut capture,
            )
            .unwrap();

        assert_eq!(
            snapshots,
            [r#"{"message":"こん"#, r#"{"message":"こんにちは"}"#]
        );
        let response = result.into_response();
        assert_eq!(
            extract_message_text(&response),
            r#"{"message":"こんにちは"}"#
        );
        assert_eq!(response["usage"]["total_tokens"], 14);
    }

    #[test]
    fn accumulates_anthropic_structured_stream_content_and_usage() {
        let mut result = StructuredStreamResult::default();
        let mut snapshots = Vec::new();
        let mut capture = |content: &str| snapshots.push(content.to_owned());

        result
            .apply_event(
                r#"{"type":"message_start","message":{"id":"msg-1","model":"claude","usage":{"input_tokens":8}}}"#,
                true,
                &mut capture,
            )
            .unwrap();
        result
            .apply_event(
                r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"{\"message\":\"やあ\"}"}}"#,
                true,
                &mut capture,
            )
            .unwrap();
        result
            .apply_event(
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}"#,
                true,
                &mut capture,
            )
            .unwrap();

        assert_eq!(snapshots, [r#"{"message":"やあ"}"#]);
        let response = result.into_response();
        assert_eq!(response["usage"]["prompt_tokens"], 8);
        assert_eq!(response["usage"]["completion_tokens"], 3);
        assert_eq!(response["choices"][0]["finish_reason"], "stop");
    }
}
