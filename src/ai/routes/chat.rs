use axum::{
    Json,
    body::Body,
    extract::State,
    http::{HeaderValue, header},
    response::Response,
};
use serde_json::{Map, Value, json};

use crate::{
    AppState,
    error::{AppError, AppResult},
};

use super::{
    super::{anthropic, api_client::AiApiClient},
    common::{
        ai_api_client_for, copy_if_present, resolve_model, successful_json_response, upstream_error,
    },
};

fn build_chat_body(
    input: &Value,
    api_client: &AiApiClient,
    use_required_parameters: bool,
    use_response_format: bool,
    should_stream: bool,
) -> AppResult<Value> {
    let model = resolve_model(input, "model", "defaultChatModel")?;
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

    if api_client.is_openrouter() {
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
    if api_client.is_anthropic() {
        copy_if_present(&mut body, input, "topK", "top_k");
    }
    Ok(Value::Object(body))
}

async fn send_chat_attempt(
    api_client: &AiApiClient,
    input: &Value,
    use_required_parameters: bool,
    use_response_format: bool,
    should_stream: bool,
) -> AppResult<reqwest::Response> {
    let body = build_chat_body(
        input,
        api_client,
        use_required_parameters,
        use_response_format,
        should_stream,
    )?;
    api_client.send_json("chat/completions", &body, 120).await
}

pub async fn chat(State(state): State<AppState>, Json(input): Json<Value>) -> AppResult<Response> {
    let api_client = ai_api_client_for(&state, &input)?;
    let should_stream = input.get("stream").and_then(Value::as_bool) != Some(false);
    let has_response_format = input
        .get("responseFormat")
        .or_else(|| input.get("response_format"))
        .is_some_and(|value| !value.is_null());
    let require_parameters = has_response_format
        && input.get("requireParameters").and_then(Value::as_bool) == Some(true);

    let mut upstream = send_chat_attempt(
        &api_client,
        &input,
        require_parameters,
        has_response_format,
        should_stream,
    )
    .await?;

    if !upstream.status().is_success() {
        let retry_without_required =
            api_client.is_openrouter() && has_response_format && require_parameters;
        let retry_without_format = !api_client.is_openrouter() && has_response_format;
        if retry_without_required || retry_without_format {
            upstream = send_chat_attempt(
                &api_client,
                &input,
                false,
                !retry_without_format,
                should_stream,
            )
            .await?;
        }
        if api_client.is_openrouter() && has_response_format && !upstream.status().is_success() {
            upstream = send_chat_attempt(&api_client, &input, false, false, should_stream).await?;
        }
    }

    if !upstream.status().is_success() {
        return Err(upstream_error(upstream).await);
    }
    if !should_stream {
        return successful_json_response(&api_client, upstream).await;
    }

    let body = if api_client.is_anthropic() {
        anthropic::stream_body(upstream)
    } else {
        Body::from_stream(upstream.bytes_stream())
    };
    let mut response = Response::new(body);
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
