use std::collections::HashSet;

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantEnvelope {
    pub message: String,
    pub messages: Vec<String>,
    pub to: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DirectorDecision {
    pub actor_id: Option<String>,
    pub reason: String,
    pub candidates: Vec<(String, String)>,
    pub thinking: Option<String>,
}

pub fn parse_assistant_response(
    content: &str,
    expression_names: &[String],
    message_mode: bool,
    require_structured: bool,
) -> AppResult<AssistantEnvelope> {
    let parsed = parse_json_from_text(content);
    if require_structured && parsed.is_none() {
        return Err(AppError::Upstream(
            "AI応答が要求されたJSON形式ではありません。".into(),
            axum::http::StatusCode::BAD_GATEWAY,
        ));
    }
    let record = parsed.as_ref().and_then(unwrap_record);
    let mut messages = if let Some(record) = record {
        if message_mode {
            parse_strings(get(record, &["messages"]))
                .into_iter()
                .chain(parse_strings(get(
                    record,
                    &["message", "dialogue", "content", "text", "reply", "answer"],
                )))
                .collect()
        } else {
            let singular = parse_strings(get(
                record,
                &["message", "dialogue", "content", "text", "reply", "answer"],
            ));
            if singular.is_empty() {
                parse_strings(get(record, &["messages"]))
            } else {
                singular
            }
        }
    } else if let Some(Value::Array(values)) = parsed.as_ref() {
        parse_strings(Some(&Value::Array(values.clone())))
    } else {
        vec![content.trim().to_owned()]
    };
    messages = unique_nonempty(messages);
    if messages.is_empty() {
        messages.push("...".into());
    }

    let to = record
        .map(|value| parse_strings(get(value, &["to", "recipients", "recipient"])))
        .map(unique_nonempty)
        .unwrap_or_default();
    let thinking = record
        .and_then(|value| get(value, &["thinking", "reasoning", "thought"]))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let requested_expression = record
        .and_then(|value| get(value, &["expression", "emotion"]))
        .and_then(Value::as_str)
        .map(str::trim);
    let expression = if expression_names.is_empty() {
        None
    } else {
        requested_expression
            .and_then(|requested| {
                expression_names
                    .iter()
                    .find(|name| name.eq_ignore_ascii_case(requested))
                    .cloned()
            })
            .or_else(|| {
                expression_names
                    .iter()
                    .find(|name| name.eq_ignore_ascii_case("neutral"))
                    .cloned()
            })
            .or_else(|| expression_names.first().cloned())
    };
    Ok(AssistantEnvelope {
        message: messages.join("\n\n"),
        messages,
        to,
        thinking,
        expression,
    })
}

pub fn parse_director_decision(
    content: &str,
    valid_actor_ids: &[String],
) -> AppResult<DirectorDecision> {
    let value = parse_json_from_text(content).ok_or_else(|| {
        AppError::Upstream(
            "指揮役の応答がJSONではありません。".into(),
            axum::http::StatusCode::BAD_GATEWAY,
        )
    })?;
    let record = value.as_object().ok_or_else(|| {
        AppError::Upstream(
            "指揮役の応答がJSONオブジェクトではありません。".into(),
            axum::http::StatusCode::BAD_GATEWAY,
        )
    })?;
    let valid = valid_actor_ids.iter().collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let candidates = record
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|candidate| {
            let actor_id = candidate.get("actorId")?.as_str()?.trim().to_owned();
            if !valid.contains(&actor_id) || !seen.insert(actor_id.clone()) {
                return None;
            }
            let reason = candidate
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned();
            Some((actor_id, reason))
        })
        .collect::<Vec<_>>();
    let thinking = record
        .get("thinking")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let (actor_id, reason) = candidates
        .first()
        .map(|(id, reason)| (Some(id.clone()), reason.clone()))
        .unwrap_or((None, "Director selected no candidate.".into()));
    Ok(DirectorDecision {
        actor_id,
        reason,
        candidates,
        thinking,
    })
}

pub fn strip_json_code_fence(content: &str) -> &str {
    let trimmed = content.trim();
    if !trimmed.starts_with("```") || !trimmed.ends_with("```") {
        return trimmed;
    }
    let after_open = trimmed.find('\n').map(|index| index + 1).unwrap_or(3);
    let before_close = trimmed.rfind("```").unwrap_or(trimmed.len());
    trimmed[after_open..before_close].trim()
}

pub fn parse_summary_response(content: &str) -> String {
    parse_json_from_text(content)
        .and_then(|value| {
            value
                .get("summary")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| content.trim().to_owned())
}

fn parse_json_from_text(content: &str) -> Option<Value> {
    let source = strip_json_code_fence(content);
    if let Ok(value) = serde_json::from_str::<Value>(source) {
        if let Value::String(nested) = value {
            return serde_json::from_str(strip_json_code_fence(&nested)).ok();
        }
        return Some(value);
    }
    for (start, ch) in source.char_indices() {
        if ch != '{' && ch != '[' {
            continue;
        }
        if let Some(end) = balanced_json_end(source, start)
            && let Ok(value) = serde_json::from_str(&source[start..end])
        {
            return Some(value);
        }
    }
    None
}

fn balanced_json_end(source: &str, start: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut stack = vec![bytes[start]];
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in bytes[start + 1..].iter().copied().enumerate() {
        let index = start + 1 + offset;
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => stack.push(byte),
            b'}' | b']' => {
                let expected = if byte == b'}' { b'{' } else { b'[' };
                if stack.pop() != Some(expected) {
                    return None;
                }
                if stack.is_empty() {
                    return Some(index + 1);
                }
            }
            _ => {}
        }
    }
    None
}

fn unwrap_record(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    let record = value.as_object()?;
    if get(
        record,
        &[
            "message", "messages", "dialogue", "content", "text", "reply", "answer",
        ],
    )
    .is_some()
    {
        return Some(record);
    }
    ["response", "result", "data", "output"]
        .iter()
        .find_map(|key| record.get(*key).and_then(Value::as_object))
        .or(Some(record))
}

fn get<'a>(record: &'a serde_json::Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| record.get(*name)).or_else(|| {
        record.iter().find_map(|(key, value)| {
            names
                .iter()
                .any(|name| key.eq_ignore_ascii_case(name))
                .then_some(value)
        })
    })
}

fn parse_strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|value| match value {
                Value::String(value) => Some(value.clone()),
                Value::Object(record) => get(record, &["message", "content", "text", "dialogue"])
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn unique_nonempty(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wrapped_and_fenced_response() {
        let response = parse_assistant_response(
            "```json\n{\"response\":{\"messages\":[\"a\",\"b\"],\"emotion\":\"happy\"}}\n```",
            &["neutral".into(), "happy".into()],
            true,
            true,
        )
        .unwrap();
        assert_eq!(response.messages, ["a", "b"]);
        assert_eq!(response.expression.as_deref(), Some("happy"));
    }

    #[test]
    fn finds_json_after_short_explanation() {
        let response =
            parse_assistant_response("Here: {\"message\":\"hello\"} done", &[], false, true)
                .unwrap();
        assert_eq!(response.message, "hello");
    }
}
