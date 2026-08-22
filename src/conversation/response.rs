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
    pub expression: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DirectorDecision {
    pub actor_id: Option<String>,
    pub reason: String,
    pub candidates: Vec<(String, String)>,
}

pub fn parse_assistant_response(
    content: &str,
    expression_names: &[String],
    message_mode: bool,
) -> AppResult<AssistantEnvelope> {
    let parsed = parse_json_from_text(content);
    if parsed.is_none() {
        return Err(AppError::Upstream(
            "AI応答が要求されたJSON形式ではありません。".into(),
            axum::http::StatusCode::BAD_GATEWAY,
        ));
    }
    let record = parsed.as_ref().and_then(unwrap_record);
    let mut messages = if let Some(record) = record {
        let singular = unique_nonempty(parse_strings(get(
            record,
            &["message", "dialogue", "content", "text", "reply", "answer"],
        )));
        let plural = unique_nonempty(parse_strings(get(record, &["messages"])));
        if message_mode {
            if plural.is_empty() { singular } else { plural }
        } else if singular.is_empty() {
            plural
        } else {
            singular
        }
    } else if let Some(Value::Array(values)) = parsed.as_ref() {
        parse_strings(Some(&Value::Array(values.clone())))
    } else {
        vec![content.trim().to_owned()]
    };
    messages = unique_nonempty(
        messages
            .into_iter()
            .map(|message| sanitize_assistant_reply_content(&message))
            .collect(),
    );
    if messages.is_empty() {
        messages.push("...".into());
    }

    let to = record
        .map(|value| parse_strings(get(value, &["to", "recipients", "recipient"])))
        .map(unique_nonempty)
        .unwrap_or_default();
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
        expression,
    })
}

fn truncate_to_character_limit(content: &str, max_characters: usize) -> String {
    content.chars().take(max_characters).collect()
}

/// Limits only the user-visible reply fields, leaving metadata such as recipients and
/// expressions untouched. In message mode the limit is shared by all reply bubbles.
pub(crate) fn limit_assistant_reply_characters(
    mut envelope: AssistantEnvelope,
    max_characters: usize,
) -> AssistantEnvelope {
    let max_characters = max_characters.max(1);
    let source_messages = if envelope.messages.is_empty() {
        vec![envelope.message]
    } else {
        envelope.messages
    };
    let mut remaining = max_characters;
    let mut messages = Vec::new();
    for message in source_messages {
        if remaining == 0 {
            break;
        }
        let truncated = truncate_to_character_limit(&message, remaining);
        let sanitized = sanitize_assistant_reply_content(&truncated);
        if sanitized.is_empty() {
            continue;
        }
        remaining = remaining.saturating_sub(sanitized.chars().count());
        messages.push(sanitized);
    }
    if messages.is_empty() {
        messages.push(truncate_to_character_limit("...", max_characters));
    }
    envelope.message = messages.join("\n\n");
    envelope.messages = messages;
    envelope
}

fn json_string_at(content: &str, start: usize) -> (String, usize, bool) {
    let bytes = content.as_bytes();
    let mut index = start + 1;
    let mut escaped = false;
    while index < bytes.len() {
        match bytes[index] {
            b'"' if !escaped => {
                let parsed =
                    serde_json::from_str::<String>(&content[start..=index]).unwrap_or_default();
                return (parsed, index + 1, true);
            }
            b'\\' if !escaped => escaped = true,
            _ => escaped = false,
        }
        index += 1;
    }

    let mut candidate_end = content.len();
    while candidate_end > start {
        let candidate = format!("{}\"", &content[start..candidate_end]);
        if let Ok(parsed) = serde_json::from_str::<String>(&candidate) {
            return (parsed, content.len(), false);
        }
        candidate_end -= 1;
        while candidate_end > start && !content.is_char_boundary(candidate_end) {
            candidate_end -= 1;
        }
    }
    (String::new(), content.len(), false)
}

fn json_property_value_start(content: &str, keys: &[&str]) -> Option<usize> {
    let bytes = content.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'"' {
            index += 1;
            continue;
        }
        let (token, end, complete) = json_string_at(content, index);
        if !complete {
            return None;
        }
        let mut cursor = end;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if keys.contains(&token.as_str()) && bytes.get(cursor) == Some(&b':') {
            cursor += 1;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            return Some(cursor);
        }
        index = end;
    }
    None
}

/// Extracts only user-visible reply text from an in-progress structured JSON response.
/// Incomplete JSON string escape sequences are held back until they can be decoded safely.
pub(crate) fn assistant_response_preview(
    content: &str,
    message_mode: bool,
    max_characters: usize,
) -> String {
    let preview = if message_mode {
        let Some(mut cursor) = json_property_value_start(content, &["messages"]) else {
            return String::new();
        };
        let bytes = content.as_bytes();
        if bytes.get(cursor) != Some(&b'[') {
            return String::new();
        }
        cursor += 1;
        let mut messages = Vec::new();
        while cursor < bytes.len() {
            while cursor < bytes.len()
                && (bytes[cursor].is_ascii_whitespace() || bytes[cursor] == b',')
            {
                cursor += 1;
            }
            if bytes.get(cursor) == Some(&b']') {
                break;
            }
            if bytes.get(cursor) != Some(&b'"') {
                break;
            }
            let (message, end, complete) = json_string_at(content, cursor);
            if !message.is_empty() {
                messages.push(message);
            }
            if !complete {
                break;
            }
            cursor = end;
        }
        messages.join("\n\n")
    } else {
        let Some(cursor) = json_property_value_start(
            content,
            &["message", "dialogue", "content", "text", "reply", "answer"],
        ) else {
            return String::new();
        };
        if content.as_bytes().get(cursor) != Some(&b'"') {
            return String::new();
        }
        json_string_at(content, cursor).0
    };
    truncate_to_character_limit(&preview, max_characters.max(1))
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
    let (actor_id, reason) = candidates
        .first()
        .map(|(id, reason)| (Some(id.clone()), reason.clone()))
        .unwrap_or((None, "Director selected no candidate.".into()));
    Ok(DirectorDecision {
        actor_id,
        reason,
        candidates,
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
    let summary = parse_json_from_text(content)
        .and_then(|value| {
            value
                .get("summary")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| content.trim().to_owned());
    sanitize_message_content(&summary)
}

/// Removes formatting fragments that should never become part of conversation history.
///
/// Some upstream APIs occasionally double-escape line breaks inside an otherwise valid JSON
/// response (leaving a literal `\n` in the parsed message), or return a truncated Markdown
/// emphasis marker. Normalize both before the message can be persisted or reused as context.
pub(crate) fn sanitize_message_content(content: &str) -> String {
    remove_unmatched_asterisk_runs(&remove_escaped_line_breaks(content))
        .trim()
        .to_owned()
}

/// Removes Japanese corner brackets only when they wrap a dialogue segment.
///
/// Text between `*...*` action blocks is treated as dialogue. This keeps quoted text inside
/// narration intact while normalizing model output such as
/// `*narration*「response」*narration*`.
pub(crate) fn sanitize_assistant_reply_content(content: &str) -> String {
    strip_dialogue_wrapping_brackets(&sanitize_message_content(content))
        .trim()
        .to_owned()
}

fn strip_dialogue_wrapping_brackets(content: &str) -> String {
    let bytes = content.as_bytes();
    let mut result = String::with_capacity(content.len());
    let mut segment_start = 0;
    let mut index = 0;

    while index < bytes.len() {
        if !is_single_asterisk_marker(bytes, index) {
            index += 1;
            continue;
        }

        let opening = index;
        let mut closing = opening + 1;
        while closing < bytes.len() && !is_single_asterisk_marker(bytes, closing) {
            closing += 1;
        }
        if closing >= bytes.len() || closing == opening + 1 {
            index = opening + 1;
            continue;
        }

        result.push_str(&strip_dialogue_segment_brackets(
            &content[segment_start..opening],
        ));
        result.push_str(&content[opening..=closing]);
        segment_start = closing + 1;
        index = segment_start;
    }

    result.push_str(&strip_dialogue_segment_brackets(&content[segment_start..]));
    result
}

fn strip_dialogue_segment_brackets(segment: &str) -> String {
    let Some((opening_index, '「')) = segment
        .char_indices()
        .find(|(_, character)| !character.is_whitespace())
    else {
        return segment.to_owned();
    };
    let Some((closing_index, '」')) = segment
        .char_indices()
        .rev()
        .find(|(_, character)| !character.is_whitespace())
    else {
        return segment.to_owned();
    };
    if opening_index >= closing_index {
        return segment.to_owned();
    }

    let mut depth = 0;
    for (index, character) in segment[opening_index..closing_index + '」'.len_utf8()].char_indices()
    {
        match character {
            '「' => depth += 1,
            '」' => {
                depth -= 1;
                if depth < 0 || (depth == 0 && opening_index + index != closing_index) {
                    return segment.to_owned();
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        return segment.to_owned();
    }

    let mut result = String::with_capacity(segment.len() - '「'.len_utf8() - '」'.len_utf8());
    result.push_str(&segment[..opening_index]);
    result.push_str(&segment[opening_index + '「'.len_utf8()..closing_index]);
    result.push_str(&segment[closing_index + '」'.len_utf8()..]);
    result
}

fn is_single_asterisk_marker(bytes: &[u8], index: usize) -> bool {
    if bytes.get(index) != Some(&b'*')
        || bytes.get(index.wrapping_sub(1)) == Some(&b'*')
        || bytes.get(index + 1) == Some(&b'*')
    {
        return false;
    }

    let preceding_backslashes = bytes[..index]
        .iter()
        .rev()
        .take_while(|byte| **byte == b'\\')
        .count();
    preceding_backslashes % 2 == 0
}

fn remove_escaped_line_breaks(content: &str) -> String {
    let bytes = content.as_bytes();
    let mut result = String::with_capacity(content.len());
    let mut copied_until = 0;
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] != b'\\' {
            index += 1;
            continue;
        }

        let escape_start = index;
        while index < bytes.len() && bytes[index] == b'\\' {
            index += 1;
        }
        let Some(code) = bytes.get(index).copied() else {
            break;
        };

        let escaped_end = match code {
            b'n' => Some(index + 1),
            b'r' => {
                let mut end = index + 1;
                if bytes.get(end) == Some(&b'\\') {
                    let mut newline_index = end;
                    while bytes.get(newline_index) == Some(&b'\\') {
                        newline_index += 1;
                    }
                    if bytes.get(newline_index) == Some(&b'n') {
                        end = newline_index + 1;
                    }
                }
                Some(end)
            }
            _ => None,
        };

        if let Some(escaped_end) = escaped_end {
            result.push_str(&content[copied_until..escape_start]);
            copied_until = escaped_end;
            index = escaped_end;
        }
    }

    result.push_str(&content[copied_until..]);
    result
}

#[derive(Clone, Copy)]
struct AsteriskRun {
    start: usize,
    end: usize,
}

fn remove_unmatched_asterisk_runs(content: &str) -> String {
    let bytes = content.as_bytes();
    let mut runs = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] != b'*' {
            index += 1;
            continue;
        }

        let run_start = index;
        while index < bytes.len() && bytes[index] == b'*' {
            index += 1;
        }

        let preceding_backslashes = bytes[..run_start]
            .iter()
            .rev()
            .take_while(|byte| **byte == b'\\')
            .count();
        let marker_start = run_start + usize::from(preceding_backslashes % 2 == 1);
        if marker_start < index {
            runs.push(AsteriskRun {
                start: marker_start,
                end: index,
            });
        }
    }

    let mut pending_by_length = std::collections::HashMap::<usize, usize>::new();
    let mut keep = vec![false; runs.len()];
    for (run_index, run) in runs.iter().enumerate() {
        let length = run.end - run.start;
        if let Some(open_index) = pending_by_length.remove(&length) {
            keep[open_index] = true;
            keep[run_index] = true;
        } else {
            pending_by_length.insert(length, run_index);
        }
    }

    if keep.iter().all(|value| *value) {
        return content.to_owned();
    }

    let mut result = String::with_capacity(content.len());
    let mut copied_until = 0;
    for (run_index, run) in runs.iter().enumerate() {
        result.push_str(&content[copied_until..run.start]);
        if keep[run_index] {
            result.push_str(&content[run.start..run.end]);
        }
        copied_until = run.end;
    }
    result.push_str(&content[copied_until..]);
    result
}

fn parse_json_from_text(content: &str) -> Option<Value> {
    let source = strip_json_code_fence(content);
    if let Some(value) = parse_json_value(source) {
        if let Value::String(nested) = value {
            return parse_json_value(strip_json_code_fence(&nested));
        }
        return Some(value);
    }
    for (start, ch) in source.char_indices() {
        if ch != '{' && ch != '[' {
            continue;
        }
        if let Some(end) = balanced_json_end(source, start)
            && let Some(value) = parse_json_value(&source[start..end])
        {
            return Some(value);
        }
    }
    None
}

fn parse_json_value(source: &str) -> Option<Value> {
    serde_json::from_str(source).ok().or_else(|| {
        let normalized = remove_trailing_json_commas(source);
        serde_json::from_str(&normalized).ok()
    })
}

fn remove_trailing_json_commas(source: &str) -> String {
    let mut result = String::with_capacity(source.len());
    let mut characters = source.char_indices().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some((_, character)) = characters.next() {
        if in_string {
            result.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }

        if character == '"' {
            in_string = true;
            result.push(character);
            continue;
        }

        if character == ',' {
            let mut lookahead = characters.clone();
            let next_non_whitespace =
                lookahead.find_map(|(_, next)| (!next.is_whitespace()).then_some(next));
            if matches!(next_non_whitespace, Some('}' | ']')) {
                continue;
            }
        }

        result.push(character);
    }

    result
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
        )
        .unwrap();
        assert_eq!(response.messages, ["a", "b"]);
        assert_eq!(response.expression.as_deref(), Some("happy"));
    }

    #[test]
    fn finds_json_after_short_explanation() {
        let response =
            parse_assistant_response("Here: {\"message\":\"hello\"} done", &[], false).unwrap();
        assert_eq!(response.message, "hello");
    }

    #[test]
    fn normalizes_trailing_commas_and_message_metadata() {
        let response = parse_assistant_response(
            r#"{"message":"  hello  ","expression":" HAPPY ","to":[" Bob ","Bob",42,""],}"#,
            &["neutral".into(), "Happy".into()],
            false,
        )
        .unwrap();

        assert_eq!(response.messages, ["hello"]);
        assert_eq!(response.expression.as_deref(), Some("Happy"));
        assert_eq!(response.to, ["Bob"]);
    }

    #[test]
    fn preserves_commas_and_escapes_inside_json_strings_when_normalizing() {
        let response = parse_assistant_response(
            r#"{"message":"literal ,} and ,] plus \"quoted\" and \\path",}"#,
            &[],
            false,
        )
        .unwrap();

        assert_eq!(
            response.message,
            r#"literal ,} and ,] plus "quoted" and \path"#
        );
    }

    #[test]
    fn selects_message_or_messages_for_response_mode() {
        let both = r#"{"message":"single","messages":["first","second"]}"#;
        let single = parse_assistant_response(both, &[], false).unwrap();
        assert_eq!(single.messages, ["single"]);

        let multiple = parse_assistant_response(both, &[], true).unwrap();
        assert_eq!(multiple.messages, ["first", "second"]);

        let fallback = parse_assistant_response(r#"{"message":"fallback"}"#, &[], true).unwrap();
        assert_eq!(fallback.messages, ["fallback"]);
    }

    #[test]
    fn falls_back_to_neutral_or_the_first_expression_for_unknown_names() {
        let with_neutral = parse_assistant_response(
            r#"{"message":"hello","expression":"unknown"}"#,
            &["neutral".into(), "happy".into()],
            false,
        )
        .unwrap();
        assert_eq!(with_neutral.expression.as_deref(), Some("neutral"));

        let without_neutral = parse_assistant_response(
            r#"{"message":"hello","expression":"unknown"}"#,
            &["happy".into(), "sad".into()],
            false,
        )
        .unwrap();
        assert_eq!(without_neutral.expression.as_deref(), Some("happy"));
    }

    #[test]
    fn treats_an_object_without_reply_fields_as_structured_with_ellipsis_fallback() {
        let response = parse_assistant_response(r#"{"unexpected":true}"#, &[], false).unwrap();

        assert_eq!(response.messages, ["..."]);
        assert_eq!(response.message, "...");
    }

    #[test]
    fn previews_incomplete_structured_reply_without_exposing_thought() {
        assert_eq!(
            assistant_response_preview(
                r#"{"thought":"hidden","expression":"happy","message":"こんにちは\n世"#,
                false,
                512,
            ),
            "こんにちは\n世"
        );
        assert_eq!(
            assistant_response_preview(r#"{"thought":"still hidden"#, false, 512),
            ""
        );
    }

    #[test]
    fn previews_message_array_as_one_temporary_block() {
        assert_eq!(
            assistant_response_preview(r#"{"messages":["一つ目","二つ"#, true, 512),
            "一つ目\n\n二つ"
        );
    }

    #[test]
    fn limits_only_reply_text_across_message_bubbles() {
        let response = limit_assistant_reply_characters(
            AssistantEnvelope {
                message: "あいう\n\nえおか".into(),
                messages: vec!["あいう".into(), "えおか".into()],
                to: vec!["character-2".into()],
                expression: Some("happy".into()),
            },
            5,
        );

        assert_eq!(response.messages, ["あいう", "えお"]);
        assert_eq!(response.message, "あいう\n\nえお");
        assert_eq!(response.to, ["character-2"]);
        assert_eq!(response.expression.as_deref(), Some("happy"));
    }

    #[test]
    fn limits_streaming_preview_by_characters() {
        assert_eq!(
            assistant_response_preview(r#"{"message":"あいうえお"#, false, 3),
            "あいう"
        );
    }

    #[test]
    fn rejects_unstructured_response() {
        let result = parse_assistant_response("hello", &[], false);
        assert!(matches!(
            result,
            Err(AppError::Upstream(_, axum::http::StatusCode::BAD_GATEWAY))
        ));
    }

    #[test]
    fn sanitizes_escaped_line_breaks_and_unclosed_markdown() {
        let response =
            parse_assistant_response(r#"{"message":"hello\\\\nworld *unfinished"}"#, &[], false)
                .unwrap();

        assert_eq!(response.message, "helloworld unfinished");
        assert_eq!(response.messages, ["helloworld unfinished"]);
    }

    #[test]
    fn keeps_closed_and_escaped_asterisks() {
        assert_eq!(
            sanitize_message_content(r"*action* and **strong** and \*literal\*"),
            r"*action* and **strong** and \*literal\*"
        );
        assert_eq!(
            sanitize_message_content("*unfinished but **strong**"),
            "unfinished but **strong**"
        );
    }

    #[test]
    fn removes_brackets_wrapping_assistant_dialogue_segments() {
        assert_eq!(sanitize_assistant_reply_content("「返答」"), "返答");
        assert_eq!(
            sanitize_assistant_reply_content("*ナレーション*「返答」*ナレーション*"),
            "*ナレーション*返答*ナレーション*"
        );
        assert_eq!(
            sanitize_assistant_reply_content("*前*「一つ目」*中*「二つ目」*後*"),
            "*前*一つ目*中*二つ目*後*"
        );
    }

    #[test]
    fn keeps_brackets_inside_narration_or_dialogue() {
        assert_eq!(
            sanitize_assistant_reply_content(
                "*葵は「おはよ」とメッセージを打った*返答*ナレーション*"
            ),
            "*葵は「おはよ」とメッセージを打った*返答*ナレーション*"
        );
        assert_eq!(
            sanitize_assistant_reply_content(
                "*ナレーション*だよね！私の友達も「おいしかった」って。"
            ),
            "*ナレーション*だよね！私の友達も「おいしかった」って。"
        );
        assert_eq!(
            sanitize_assistant_reply_content("「一つ目」と「二つ目」"),
            "「一つ目」と「二つ目」"
        );
    }

    #[test]
    fn removes_single_and_double_escaped_line_breaks() {
        assert_eq!(
            sanitize_message_content(r"first\nsecond\\nthird\r\nfourth"),
            "firstsecondthirdfourth"
        );
        assert_eq!(
            sanitize_message_content(r"first\r\quality"),
            r"first\quality"
        );
    }

    #[test]
    fn sanitizes_summary_before_it_is_saved() {
        assert_eq!(
            parse_summary_response(r#"{"summary":"first\\\\nsecond *unfinished"}"#),
            "firstsecond unfinished"
        );
    }
}
