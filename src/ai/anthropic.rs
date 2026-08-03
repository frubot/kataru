use std::{
    collections::VecDeque,
    io,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::body::{Body, Bytes};
use futures_util::{StreamExt, stream};
use serde_json::{Map, Value, json};

use crate::error::{AppError, AppResult};

const DEFAULT_MAX_TOKENS: u64 = 4096;

fn content_text(content: &Value) -> String {
    match content {
        Value::String(value) => value.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                part.as_object()
                    .and_then(|record| record.get("text"))
                    .and_then(Value::as_str)
            })
            .collect(),
        _ => String::new(),
    }
}

fn anthropic_content(content: &Value) -> Value {
    let Some(parts) = content.as_array() else {
        return content.clone();
    };
    let converted = parts
        .iter()
        .filter_map(|part| {
            let record = part.as_object()?;
            match record.get("type").and_then(Value::as_str) {
                Some("text") => Some(json!({
                    "type": "text",
                    "text": record.get("text").and_then(Value::as_str).unwrap_or_default(),
                })),
                Some("image_url") => {
                    let url = record
                        .get("image_url")
                        .and_then(|image| image.get("url"))
                        .and_then(Value::as_str)?;
                    if let Some(data) = url.strip_prefix("data:") {
                        let (media_type, encoded) = data.split_once(";base64,")?;
                        Some(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": encoded,
                            }
                        }))
                    } else {
                        Some(json!({
                            "type": "image",
                            "source": { "type": "url", "url": url }
                        }))
                    }
                }
                _ => None,
            }
        })
        .collect::<Vec<_>>();
    Value::Array(converted)
}

fn json_schema(response_format: &Value) -> Option<Value> {
    if response_format.get("type").and_then(Value::as_str) != Some("json_schema") {
        return None;
    }
    response_format
        .pointer("/json_schema/schema")
        .or_else(|| response_format.get("schema"))
        .filter(|schema| schema.is_object())
        .cloned()
}

pub fn request_from_openai(input: &Value) -> AppResult<Value> {
    let source = input.as_object().ok_or_else(|| {
        AppError::BadRequest(
            "AnthropicへのリクエストはJSONオブジェクトである必要があります。".to_owned(),
        )
    })?;
    let model = source
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest("model は必須です。".to_owned()))?;
    let input_messages = source
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::BadRequest("messages は配列である必要があります。".to_owned()))?;

    let mut system_parts = source
        .get("system")
        .map(content_text)
        .filter(|value| !value.is_empty())
        .into_iter()
        .collect::<Vec<_>>();
    let mut messages = Vec::with_capacity(input_messages.len());
    for message in input_messages {
        let Some(record) = message.as_object() else {
            continue;
        };
        let role = record
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let content = record.get("content").cloned().unwrap_or(Value::Null);
        if matches!(role, "system" | "developer") {
            let text = content_text(&content);
            if !text.is_empty() {
                system_parts.push(text);
            }
            continue;
        }
        if matches!(role, "user" | "assistant") {
            messages.push(json!({
                "role": role,
                "content": anthropic_content(&content),
            }));
        }
    }
    if messages.is_empty() {
        return Err(AppError::BadRequest(
            "Anthropicに送信できるuser/assistantメッセージがありません。".to_owned(),
        ));
    }

    let mut body = Map::new();
    body.insert("model".to_owned(), Value::String(model.to_owned()));
    body.insert("messages".to_owned(), Value::Array(messages));
    body.insert(
        "max_tokens".to_owned(),
        source
            .get("max_tokens")
            .cloned()
            .unwrap_or_else(|| json!(DEFAULT_MAX_TOKENS)),
    );
    if !system_parts.is_empty() {
        body.insert(
            "system".to_owned(),
            Value::String(system_parts.join("\n\n")),
        );
    }
    for key in ["stream", "top_p", "top_k"] {
        if let Some(value) = source.get(key).filter(|value| !value.is_null()) {
            body.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(temperature) = source.get("temperature").and_then(Value::as_f64) {
        body.insert("temperature".to_owned(), json!(temperature.clamp(0.0, 1.0)));
    }
    if let Some(stop) = source.get("stop").filter(|value| !value.is_null()) {
        let stop_sequences = if stop.is_string() {
            Value::Array(vec![stop.clone()])
        } else {
            stop.clone()
        };
        body.insert("stop_sequences".to_owned(), stop_sequences);
    }
    if let Some(schema) = source.get("response_format").and_then(json_schema) {
        body.insert(
            "output_config".to_owned(),
            json!({ "format": { "type": "json_schema", "schema": schema } }),
        );
    }
    Ok(Value::Object(body))
}

fn prompt_tokens(usage: &Value) -> u64 {
    usage
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
            .unwrap_or(0)
}

fn finish_reason(reason: Option<&str>) -> Value {
    match reason {
        Some("max_tokens" | "model_context_window_exceeded") => Value::String("length".to_owned()),
        Some("tool_use") => Value::String("tool_calls".to_owned()),
        Some(_) => Value::String("stop".to_owned()),
        None => Value::Null,
    }
}

pub fn response_to_openai(input: Value) -> Value {
    let text = input
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default();
    let usage = input.get("usage").cloned().unwrap_or_else(|| json!({}));
    let prompt_tokens = prompt_tokens(&usage);
    let completion_tokens = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    json!({
        "id": input.get("id").and_then(Value::as_str).unwrap_or_default(),
        "object": "chat.completion",
        "created": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        "model": input.get("model").and_then(Value::as_str).unwrap_or_default(),
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": text },
            "finish_reason": finish_reason(input.get("stop_reason").and_then(Value::as_str)),
        }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }
    })
}

struct StreamState {
    upstream: futures_util::stream::BoxStream<'static, Result<Bytes, reqwest::Error>>,
    buffer: Vec<u8>,
    pending: VecDeque<Result<Bytes, io::Error>>,
    finished: bool,
    id: String,
    model: String,
    input_tokens: u64,
}

fn event_end(buffer: &[u8]) -> Option<(usize, usize)> {
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

fn sse_data(event: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(event);
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    (!data.is_empty())
        .then(|| serde_json::from_str::<Value>(&data).ok())
        .flatten()
}

fn chunk(state: &StreamState, choices: Value, usage: Option<Value>) -> Bytes {
    let mut value = json!({
        "id": state.id,
        "object": "chat.completion.chunk",
        "created": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        "model": state.model,
        "choices": choices,
    });
    if let Some(usage) = usage {
        value["usage"] = usage;
    }
    Bytes::from(format!("data: {value}\n\n"))
}

fn translate_event(state: &mut StreamState, event: Value) -> Option<Bytes> {
    match event.get("type").and_then(Value::as_str) {
        Some("message_start") => {
            let message = event.get("message")?;
            state.id = message
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            state.model = message
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            state.input_tokens = message.get("usage").map(prompt_tokens).unwrap_or(0);
            Some(chunk(
                state,
                json!([{ "index": 0, "delta": { "role": "assistant" }, "finish_reason": null }]),
                None,
            ))
        }
        Some("content_block_delta")
            if event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") =>
        {
            let text = event
                .pointer("/delta/text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some(chunk(
                state,
                json!([{ "index": 0, "delta": { "content": text }, "finish_reason": null }]),
                None,
            ))
        }
        Some("message_delta") => {
            let output_tokens = event
                .pointer("/usage/output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let prompt_tokens = event
                .get("usage")
                .map(prompt_tokens)
                .filter(|tokens| *tokens > 0)
                .unwrap_or(state.input_tokens);
            Some(chunk(
                state,
                json!([{
                    "index": 0,
                    "delta": {},
                    "finish_reason": finish_reason(event.pointer("/delta/stop_reason").and_then(Value::as_str)),
                }]),
                Some(json!({
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": output_tokens,
                    "total_tokens": prompt_tokens + output_tokens,
                })),
            ))
        }
        Some("message_stop") => Some(Bytes::from_static(b"data: [DONE]\n\n")),
        Some("error") => Some(Bytes::from(format!(
            "data: {}\n\n",
            json!({ "error": event.get("error").cloned().unwrap_or(Value::Null) })
        ))),
        _ => None,
    }
}

fn queue_complete_events(state: &mut StreamState) {
    while let Some((index, delimiter_len)) = event_end(&state.buffer) {
        let event = state.buffer[..index].to_vec();
        state.buffer.drain(..index + delimiter_len);
        if let Some(data) = sse_data(&event)
            && let Some(output) = translate_event(state, data)
        {
            state.pending.push_back(Ok(output));
        }
    }
}

pub fn stream_body(response: reqwest::Response) -> Body {
    let state = StreamState {
        upstream: response.bytes_stream().boxed(),
        buffer: Vec::new(),
        pending: VecDeque::new(),
        finished: false,
        id: String::new(),
        model: String::new(),
        input_tokens: 0,
    };
    let output = stream::unfold(state, |mut state| async move {
        loop {
            if let Some(item) = state.pending.pop_front() {
                return Some((item, state));
            }
            if state.finished {
                return None;
            }
            match state.upstream.next().await {
                Some(Ok(bytes)) => {
                    state.buffer.extend_from_slice(&bytes);
                    queue_complete_events(&mut state);
                }
                Some(Err(error)) => {
                    state.finished = true;
                    return Some((Err(io::Error::other(error)), state));
                }
                None => {
                    state.finished = true;
                    if !state.buffer.is_empty() {
                        let event = std::mem::take(&mut state.buffer);
                        if let Some(data) = sse_data(&event)
                            && let Some(output) = translate_event(&mut state, data)
                        {
                            return Some((Ok(output), state));
                        }
                    }
                }
            }
        }
    });
    Body::from_stream(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_stream_state() -> StreamState {
        StreamState {
            upstream: stream::empty::<Result<Bytes, reqwest::Error>>().boxed(),
            buffer: Vec::new(),
            pending: VecDeque::new(),
            finished: false,
            id: String::new(),
            model: String::new(),
            input_tokens: 0,
        }
    }

    #[test]
    fn converts_system_messages_and_structured_output() {
        let converted = request_from_openai(&json!({
            "model": "claude-sonnet-4-6",
            "messages": [
                {"role": "system", "content": "Be helpful"},
                {"role": "user", "content": "Return JSON"}
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "answer",
                    "strict": true,
                    "schema": {"type": "object", "properties": {"answer": {"type": "string"}}}
                }
            }
        }))
        .unwrap();

        assert_eq!(converted["system"], "Be helpful");
        assert_eq!(converted["messages"][0]["role"], "user");
        assert_eq!(
            converted.pointer("/output_config/format/schema/type"),
            Some(&json!("object"))
        );
        assert_eq!(converted["max_tokens"], DEFAULT_MAX_TOKENS);
    }

    #[test]
    fn clamps_openai_temperature_to_anthropic_range() {
        let converted = request_from_openai(&json!({
            "model": "claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "hello"}],
            "temperature": 1.05
        }))
        .unwrap();

        assert_eq!(converted["temperature"], 1.0);
    }

    #[test]
    fn converts_response_and_usage_to_openai_shape() {
        let converted = response_to_openai(json!({
            "id": "msg_123",
            "model": "claude-sonnet-4-6",
            "content": [{"type": "text", "text": "hello"}],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 10,
                "cache_read_input_tokens": 4,
                "output_tokens": 3
            }
        }));

        assert_eq!(
            converted.pointer("/choices/0/message/content"),
            Some(&json!("hello"))
        );
        assert_eq!(converted.pointer("/usage/prompt_tokens"), Some(&json!(14)));
        assert_eq!(converted.pointer("/usage/total_tokens"), Some(&json!(17)));
    }

    #[test]
    fn converts_stream_events_to_openai_chunks() {
        let mut state = empty_stream_state();
        let start = translate_event(
            &mut state,
            json!({
                "type": "message_start",
                "message": {
                    "id": "msg_123",
                    "model": "claude-sonnet-4-6",
                    "usage": {"input_tokens": 8}
                }
            }),
        )
        .unwrap();
        let delta = translate_event(
            &mut state,
            json!({
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "hello"}
            }),
        )
        .unwrap();
        let stop = translate_event(
            &mut state,
            json!({
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"output_tokens": 3}
            }),
        )
        .unwrap();

        assert!(String::from_utf8_lossy(&start).contains("\"role\":\"assistant\""));
        assert!(String::from_utf8_lossy(&delta).contains("\"content\":\"hello\""));
        assert!(String::from_utf8_lossy(&stop).contains("\"total_tokens\":11"));
    }
}
