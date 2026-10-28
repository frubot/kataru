use std::collections::HashSet;

use serde::Serialize;
use serde_json::Value;

use crate::conversation::prompts::NARRATOR_ID;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantEnvelope {
    pub message: String,
    pub messages: Vec<String>,
    pub to: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motion: Option<String>,
}

pub fn parse_assistant_response(
    content: &str,
    expression_names: &[String],
    motion_names: &[String],
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
    let requested_motion = record
        .and_then(|value| get(value, &["motion"]))
        .and_then(Value::as_str)
        .map(str::trim);
    // Motions are one-shot fire events: only a fully registered name produces a
    // value. Missing, unknown, and explicit "none" all stay None (no fallback).
    let motion = if motion_names.is_empty() {
        None
    } else {
        requested_motion
            .filter(|requested| !requested.eq_ignore_ascii_case("none"))
            .and_then(|requested| {
                motion_names
                    .iter()
                    .find(|name| name.eq_ignore_ascii_case(requested))
                    .cloned()
            })
    };
    Ok(AssistantEnvelope {
        message: messages.join("\n\n"),
        messages,
        to,
        expression,
        motion,
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

/// Wraps a plain-text reply. Basic mode does not use structured output, so the whole
/// response body is the reply; a fenced block around the whole body is unwrapped.
pub(crate) fn plain_assistant_response(content: &str, max_characters: usize) -> AssistantEnvelope {
    let message = strip_json_code_fence(content).trim().to_owned();
    limit_assistant_reply_characters(
        AssistantEnvelope {
            message: message.clone(),
            messages: vec![message],
            to: Vec::new(),
            expression: None,
            motion: None,
        },
        max_characters,
    )
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

/// Only publish a fully received, registered expression; never default partial metadata.
pub(crate) fn assistant_expression_preview(
    content: &str,
    expression_names: &[String],
) -> Option<String> {
    let cursor = json_property_value_start(content, &["expression", "emotion"])?;
    if content.as_bytes().get(cursor) != Some(&b'"') {
        return None;
    }
    let (expression, _, complete) = json_string_at(content, cursor);
    if !complete {
        return None;
    }
    expression_names
        .iter()
        .find(|name| name.eq_ignore_ascii_case(expression.trim()))
        .cloned()
}

/// Only publish a fully received, registered motion; "none" and unknown names stay None.
pub(crate) fn assistant_motion_preview(content: &str, motion_names: &[String]) -> Option<String> {
    let cursor = json_property_value_start(content, &["motion"])?;
    if content.as_bytes().get(cursor) != Some(&b'"') {
        return None;
    }
    let (motion, _, complete) = json_string_at(content, cursor);
    if !complete {
        return None;
    }
    motion_names
        .iter()
        .find(|name| name.eq_ignore_ascii_case(motion.trim()))
        .cloned()
}

/// Preview of an in-progress assistant reply.
#[derive(Debug, Clone, Default)]
pub(crate) struct AssistantResponsePreview {
    /// User-visible text received so far. Message mode joins the bubbles with
    /// `\n\n`, including the still-streaming tail.
    pub content: String,
    /// Message mode only: bubbles whose JSON string already closed, so their
    /// text is final. Built with the same sanitize/dedupe/limit pipeline as the
    /// finalized reply so a confirmed bubble matches the persisted message.
    pub confirmed_messages: Vec<String>,
}

/// Extracts only user-visible reply text from an in-progress structured JSON response.
/// Incomplete JSON string escape sequences are held back until they can be decoded safely.
pub(crate) fn assistant_response_preview(
    content: &str,
    message_mode: bool,
    max_characters: usize,
) -> AssistantResponsePreview {
    let max_characters = max_characters.max(1);
    if message_mode {
        let Some(mut cursor) = json_property_value_start(content, &["messages"]) else {
            return AssistantResponsePreview::default();
        };
        let bytes = content.as_bytes();
        if bytes.get(cursor) != Some(&b'[') {
            return AssistantResponsePreview::default();
        }
        cursor += 1;
        let mut messages = Vec::new();
        let mut closed_messages = Vec::new();
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
                if complete {
                    closed_messages.push(message.clone());
                }
                messages.push(message);
            }
            if !complete {
                break;
            }
            cursor = end;
        }
        return AssistantResponsePreview {
            content: truncate_to_character_limit(&messages.join("\n\n"), max_characters),
            confirmed_messages: limited_confirmed_messages(closed_messages, max_characters),
        };
    }
    let Some(cursor) = json_property_value_start(
        content,
        &["message", "dialogue", "content", "text", "reply", "answer"],
    ) else {
        return AssistantResponsePreview::default();
    };
    if content.as_bytes().get(cursor) != Some(&b'"') {
        return AssistantResponsePreview::default();
    }
    AssistantResponsePreview {
        content: truncate_to_character_limit(&json_string_at(content, cursor).0, max_characters),
        confirmed_messages: Vec::new(),
    }
}

/// Applies the finalized reply pipeline (sanitize, dedupe, per-bubble character
/// limit) to the closed prefix of a streaming message array, so confirmed
/// preview bubbles match `parse_assistant_response` output exactly.
fn limited_confirmed_messages(messages: Vec<String>, max_characters: usize) -> Vec<String> {
    let sanitized = unique_nonempty(
        messages
            .into_iter()
            .map(|message| sanitize_assistant_reply_content(&message))
            .collect(),
    );
    if sanitized.is_empty() {
        return sanitized;
    }
    limit_assistant_reply_characters(
        AssistantEnvelope {
            message: String::new(),
            messages: sanitized,
            to: Vec::new(),
            expression: None,
            motion: None,
        },
        max_characters,
    )
    .messages
}

/// Preview of an in-progress plain-text reply. Nothing has to be decoded, so the
/// received text is shown as-is within the character limit.
pub(crate) fn plain_response_preview(content: &str, max_characters: usize) -> String {
    truncate_to_character_limit(content, max_characters.max(1))
}

/// シチュエーションの一括生成で、話者1人ぶんの検証条件。
#[derive(Debug, Clone)]
pub(crate) struct EnsembleSpeaker {
    pub id: String,
    pub expression_names: Vec<String>,
    pub motion_names: Vec<String>,
    pub max_characters: usize,
}

/// 一括生成の出力から取り出した1発言。
#[derive(Debug, Clone)]
pub(crate) struct EnsembleTurn {
    pub speaker: String,
    pub envelope: AssistantEnvelope,
}

/// `{"turns": [...]}` を発言の列に変換する。参加者でない話者の発言は捨て、
/// 表情・モーション・文字数は発言者自身の条件で検証する。
pub(crate) fn parse_ensemble_response(
    content: &str,
    speakers: &[EnsembleSpeaker],
    message_mode: bool,
    max_turns: usize,
) -> AppResult<Vec<EnsembleTurn>> {
    let invalid = || {
        AppError::Upstream(
            "AI応答が要求されたJSON形式ではありません。".into(),
            axum::http::StatusCode::BAD_GATEWAY,
        )
    };
    let parsed = parse_json_from_text(content).ok_or_else(invalid)?;
    let items = match &parsed {
        Value::Array(items) => items.as_slice(),
        Value::Object(record) => get(record, &["turns"])
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .ok_or_else(invalid)?,
        _ => return Err(invalid()),
    };
    let max_turns = max_turns.max(1);
    let mut turns: Vec<EnsembleTurn> = Vec::new();
    let mut character_turns = 0;
    for turn in items
        .iter()
        .filter_map(|item| parse_ensemble_turn(item, speakers, message_mode))
    {
        if turn.speaker == NARRATOR_ID {
            // ナレーションはキャラクターの発言数に数えない。続けて並んだら1つにまとめ、
            // 上限に達した後の締めのナレーションは1つまで残す。
            match turns.last_mut() {
                Some(last) if last.speaker == NARRATOR_ID => {
                    last.envelope.message.push_str("\n\n");
                    last.envelope.message.push_str(&turn.envelope.message);
                }
                _ => turns.push(turn),
            }
            if character_turns >= max_turns {
                break;
            }
            continue;
        }
        if character_turns >= max_turns {
            break;
        }
        character_turns += 1;
        turns.push(turn);
    }
    if turns.is_empty() {
        return Err(AppError::Upstream(
            "AI応答に有効な発言がありません。".into(),
            axum::http::StatusCode::BAD_GATEWAY,
        ));
    }
    Ok(turns)
}

fn find_speaker<'a>(speakers: &'a [EnsembleSpeaker], id: &str) -> Option<&'a EnsembleSpeaker> {
    let id = id.trim();
    speakers.iter().find(|speaker| speaker.id == id)
}

fn parse_ensemble_turn(
    item: &Value,
    speakers: &[EnsembleSpeaker],
    message_mode: bool,
) -> Option<EnsembleTurn> {
    let record = item.as_object()?;
    let speaker = find_speaker(
        speakers,
        get(record, &["speaker", "actorId", "characterId"])?.as_str()?,
    )?;
    let envelope = parse_assistant_response(
        &item.to_string(),
        &speaker.expression_names,
        &speaker.motion_names,
        message_mode,
    )
    .ok()?;
    Some(EnsembleTurn {
        speaker: speaker.id.clone(),
        envelope: limit_assistant_reply_characters(envelope, speaker.max_characters),
    })
}

/// 生成途中の一括生成出力から見える1発言。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EnsembleTurnPreview {
    pub speaker: String,
    /// この発言のJSONオブジェクトが閉じ、内容が確定しているか。
    pub complete: bool,
    pub content: String,
    /// 完了した発言では最終的な吹き出し全部。途中の発言ではメッセージモードの確定済みの吹き出し。
    pub messages: Vec<String>,
    pub expression: Option<String>,
    pub motion: Option<String>,
}

/// 受信途中の `{"turns": [...]}` から、話者が分かった発言だけを順に取り出す。
/// 閉じた発言は確定版と同じ処理を通すので、プレビューと保存内容が一致する。
pub(crate) fn ensemble_response_preview(
    content: &str,
    speakers: &[EnsembleSpeaker],
    message_mode: bool,
) -> Vec<EnsembleTurnPreview> {
    let mut previews = Vec::new();
    let Some(mut cursor) = json_property_value_start(content, &["turns"]) else {
        return previews;
    };
    let bytes = content.as_bytes();
    if bytes.get(cursor) != Some(&b'[') {
        return previews;
    }
    cursor += 1;
    while cursor < bytes.len() {
        while cursor < bytes.len() && (bytes[cursor].is_ascii_whitespace() || bytes[cursor] == b',')
        {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'{') {
            break;
        }
        if let Some(end) = balanced_json_end(content, cursor) {
            if let Some(turn) = parse_json_value(&content[cursor..end])
                .and_then(|value| parse_ensemble_turn(&value, speakers, message_mode))
            {
                previews.push(EnsembleTurnPreview {
                    speaker: turn.speaker,
                    complete: true,
                    content: turn.envelope.message,
                    messages: turn.envelope.messages,
                    expression: turn.envelope.expression,
                    motion: turn.envelope.motion,
                });
            }
            cursor = end;
            continue;
        }
        let partial = &content[cursor..];
        let Some(speaker) = json_property_value_start(partial, &["speaker"])
            .filter(|start| partial.as_bytes().get(*start) == Some(&b'"'))
            .map(|start| json_string_at(partial, start))
            .filter(|(_, _, complete)| *complete)
            .and_then(|(id, _, _)| find_speaker(speakers, &id))
        else {
            break;
        };
        let preview = assistant_response_preview(partial, message_mode, speaker.max_characters);
        previews.push(EnsembleTurnPreview {
            speaker: speaker.id.clone(),
            complete: false,
            content: preview.content,
            messages: preview.confirmed_messages,
            expression: assistant_expression_preview(partial, &speaker.expression_names),
            motion: assistant_motion_preview(partial, &speaker.motion_names),
        });
        break;
    }
    previews
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
            &[],
            true,
        )
        .unwrap();
        assert_eq!(response.messages, ["a", "b"]);
        assert_eq!(response.expression.as_deref(), Some("happy"));
    }

    #[test]
    fn finds_json_after_short_explanation() {
        let response =
            parse_assistant_response("Here: {\"message\":\"hello\"} done", &[], &[], false)
                .unwrap();
        assert_eq!(response.message, "hello");
    }

    #[test]
    fn normalizes_trailing_commas_and_message_metadata() {
        let response = parse_assistant_response(
            r#"{"message":"  hello  ","expression":" HAPPY ","to":[" Bob ","Bob",42,""],}"#,
            &["neutral".into(), "Happy".into()],
            &[],
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
        let single = parse_assistant_response(both, &[], &[], false).unwrap();
        assert_eq!(single.messages, ["single"]);

        let multiple = parse_assistant_response(both, &[], &[], true).unwrap();
        assert_eq!(multiple.messages, ["first", "second"]);

        let fallback =
            parse_assistant_response(r#"{"message":"fallback"}"#, &[], &[], true).unwrap();
        assert_eq!(fallback.messages, ["fallback"]);
    }

    #[test]
    fn falls_back_to_neutral_or_the_first_expression_for_unknown_names() {
        let with_neutral = parse_assistant_response(
            r#"{"message":"hello","expression":"unknown"}"#,
            &["neutral".into(), "happy".into()],
            &[],
            false,
        )
        .unwrap();
        assert_eq!(with_neutral.expression.as_deref(), Some("neutral"));

        let without_neutral = parse_assistant_response(
            r#"{"message":"hello","expression":"unknown"}"#,
            &["happy".into(), "sad".into()],
            &[],
            false,
        )
        .unwrap();
        assert_eq!(without_neutral.expression.as_deref(), Some("happy"));
    }

    #[test]
    fn normalizes_only_registered_motions_and_never_falls_back() {
        let names = vec!["wave".into(), "jump".into()];

        let registered = parse_assistant_response(
            r#"{"message":"hello","motion":" WAVE "}"#,
            &[],
            &names,
            false,
        )
        .unwrap();
        assert_eq!(registered.motion.as_deref(), Some("wave"));

        for (label, json) in [
            ("none", r#"{"message":"hello","motion":"none"}"#),
            ("none uppercased", r#"{"message":"hello","motion":"NONE"}"#),
            ("unknown", r#"{"message":"hello","motion":"spin"}"#),
            ("missing", r#"{"message":"hello"}"#),
        ] {
            let response = parse_assistant_response(json, &[], &names, false).unwrap();
            assert_eq!(response.motion, None, "{label} must not fire a motion");
        }

        let without_names =
            parse_assistant_response(r#"{"message":"hello","motion":"wave"}"#, &[], &[], false)
                .unwrap();
        assert_eq!(without_names.motion, None);
    }

    #[test]
    fn treats_an_object_without_reply_fields_as_structured_with_ellipsis_fallback() {
        let response = parse_assistant_response(r#"{"unexpected":true}"#, &[], &[], false).unwrap();

        assert_eq!(response.messages, ["..."]);
        assert_eq!(response.message, "...");
    }

    #[test]
    fn previews_only_complete_registered_expressions() {
        let names = vec!["neutral".into(), "happy".into()];
        for partial in [
            r#"{"note":"hidden"#,
            r#"{"expression":"hap"#,
            r#"{"expression":"unknown","message":"hi"#,
        ] {
            assert_eq!(assistant_expression_preview(partial, &names), None);
        }
        assert_eq!(
            assistant_expression_preview(r#"{"expression":"HAPPY","message":"hi"#, &names),
            Some("happy".into())
        );
        assert_eq!(
            assistant_expression_preview(r#"{"expression":"neutral""#, &names),
            Some("neutral".into())
        );
    }

    #[test]
    fn previews_only_complete_registered_motions() {
        let names = vec!["wave".into(), "jump".into()];
        for partial in [
            r#"{"note":"hidden"#,
            r#"{"motion":"wa"#,
            r#"{"motion":"spin","message":"hi"#,
            r#"{"motion":"none","message":"hi"#,
        ] {
            assert_eq!(assistant_motion_preview(partial, &names), None);
        }
        assert_eq!(
            assistant_motion_preview(r#"{"motion":"WAVE","message":"hi"#, &names),
            Some("wave".into())
        );
        assert_eq!(
            assistant_motion_preview(r#"{"motion":"jump""#, &names),
            Some("jump".into())
        );
    }

    #[test]
    fn previews_incomplete_structured_reply_without_exposing_other_fields() {
        assert_eq!(
            assistant_response_preview(
                r#"{"note":"hidden","expression":"happy","message":"こんにちは\n世"#,
                false,
                512,
            )
            .content,
            "こんにちは\n世"
        );
        assert_eq!(
            assistant_response_preview(r#"{"note":"still hidden"#, false, 512).content,
            ""
        );
    }

    #[test]
    fn previews_message_array_as_one_temporary_block() {
        let preview = assistant_response_preview(r#"{"messages":["一つ目","二つ"#, true, 512);
        assert_eq!(preview.content, "一つ目\n\n二つ");
        assert_eq!(preview.confirmed_messages, ["一つ目"]);
    }

    #[test]
    fn confirms_only_closed_message_bubbles_while_streaming() {
        // まだ閉じていない先頭バブルは確定扱いにしない。
        let partial = assistant_response_preview(r#"{"messages":["こ"#, true, 512);
        assert_eq!(partial.content, "こ");
        assert_eq!(partial.confirmed_messages, Vec::<String>::new());
        // 閉じたバブルは確定済みリストに乗り、末尾の未完成分は含めない。
        let mid = assistant_response_preview(r#"{"messages":["一つ目","二つ"#, true, 512);
        assert_eq!(mid.content, "一つ目\n\n二つ");
        assert_eq!(mid.confirmed_messages, ["一つ目"]);
        // サニタイズ・結束した配列の上限も確定済みリストへ反映する。
        let sanitized =
            assistant_response_preview(r#"{"messages":["「一つ目」","二つ目","三"#, true, 5);
        assert_eq!(sanitized.confirmed_messages, ["一つ目", "二つ"]);
        // 完成後 (`limit_assistant_reply_characters`) と同じ結果になること。
        let finalized = limit_assistant_reply_characters(
            AssistantEnvelope {
                message: "一つ目\n\n二つ目".into(),
                messages: vec!["一つ目".into(), "二つ目".into()],
                to: Vec::new(),
                expression: None,
                motion: None,
            },
            5,
        );
        assert_eq!(sanitized.confirmed_messages, finalized.messages);
    }

    #[test]
    fn limits_only_reply_text_across_message_bubbles() {
        let response = limit_assistant_reply_characters(
            AssistantEnvelope {
                message: "あいう\n\nえおか".into(),
                messages: vec!["あいう".into(), "えおか".into()],
                to: vec!["character-2".into()],
                expression: Some("happy".into()),
                motion: Some("wave".into()),
            },
            5,
        );

        assert_eq!(response.messages, ["あいう", "えお"]);
        assert_eq!(response.message, "あいう\n\nえお");
        assert_eq!(response.to, ["character-2"]);
        assert_eq!(response.expression.as_deref(), Some("happy"));
        assert_eq!(response.motion.as_deref(), Some("wave"));
    }

    #[test]
    fn limits_streaming_preview_by_characters() {
        assert_eq!(
            assistant_response_preview(r#"{"message":"あいうえお"#, false, 3).content,
            "あいう"
        );
    }

    #[test]
    fn plain_reply_keeps_the_body_without_metadata() {
        let response = plain_assistant_response("  こんにちは。*微笑む*  ", 512);

        assert_eq!(response.messages, ["こんにちは。*微笑む*"]);
        assert_eq!(response.message, "こんにちは。*微笑む*");
        assert!(response.expression.is_none());
        assert!(response.motion.is_none());
        assert!(response.to.is_empty());
    }

    #[test]
    fn plain_reply_reuses_the_structured_reply_normalization() {
        assert_eq!(plain_assistant_response("「返答」", 512).message, "返答");
    }

    #[test]
    fn plain_reply_is_limited_by_characters() {
        assert_eq!(
            plain_assistant_response("あいうえお", 3).messages,
            ["あいう"]
        );
    }

    #[test]
    fn plain_reply_unwraps_a_fenced_block_but_never_parses_json_bodies() {
        assert_eq!(
            plain_assistant_response("```json\n{\"a\": 1}\n```", 512).message,
            "{\"a\": 1}"
        );
        assert_eq!(
            plain_assistant_response(r#"{"message":"hi"}"#, 512).message,
            r#"{"message":"hi"}"#
        );
    }

    #[test]
    fn plain_reply_falls_back_to_ellipsis_when_empty() {
        assert_eq!(plain_assistant_response("   ", 512).message, "...");
    }

    #[test]
    fn previews_plain_reply_by_characters() {
        assert_eq!(plain_response_preview("あいうえお", 3), "あいう");
    }

    #[test]
    fn rejects_unstructured_response() {
        let result = parse_assistant_response("hello", &[], &[], false);
        assert!(matches!(
            result,
            Err(AppError::Upstream(_, axum::http::StatusCode::BAD_GATEWAY))
        ));
    }

    #[test]
    fn sanitizes_escaped_line_breaks_and_unclosed_markdown() {
        let response = parse_assistant_response(
            r#"{"message":"hello\\\\nworld *unfinished"}"#,
            &[],
            &[],
            false,
        )
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

    fn ensemble_speakers() -> Vec<EnsembleSpeaker> {
        vec![
            EnsembleSpeaker {
                id: "aoi".into(),
                expression_names: vec!["neutral".into(), "smile".into()],
                motion_names: vec!["wave".into()],
                max_characters: 512,
            },
            EnsembleSpeaker {
                id: "rin".into(),
                expression_names: vec!["neutral".into(), "angry".into()],
                motion_names: Vec::new(),
                max_characters: 5,
            },
        ]
    }

    #[test]
    fn ensemble_response_validates_each_turn_against_its_speaker() {
        let content = r#"{"turns": [
            {"speaker": "aoi", "expression": "smile", "motion": "wave", "message": "おはよう！"},
            {"speaker": "ghost", "expression": "smile", "motion": "none", "message": "誰？"},
            {"speaker": "rin", "expression": "smile", "motion": "wave", "message": "おはよう、葵。"}
        ]}"#;
        let turns = parse_ensemble_response(content, &ensemble_speakers(), false, 3)
            .expect("ensemble turns");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].speaker, "aoi");
        assert_eq!(turns[0].envelope.expression.as_deref(), Some("smile"));
        assert_eq!(turns[0].envelope.motion.as_deref(), Some("wave"));
        assert_eq!(turns[1].speaker, "rin");
        // 凛は smile を持たないので既定の表情へ戻り、モーションは登録がないので付かない。
        assert_eq!(turns[1].envelope.expression.as_deref(), Some("neutral"));
        assert_eq!(turns[1].envelope.motion, None);
        // 文字数上限は発言者ごとに適用する。
        assert_eq!(turns[1].envelope.message, "おはよう、");
    }

    #[test]
    fn ensemble_response_respects_turn_limit_and_message_mode() {
        let content = r#"{"turns": [
            {"speaker": "aoi", "messages": ["おはよう", "今日も早いね"]},
            {"speaker": "rin", "messages": ["おはよ"]}
        ]}"#;
        let turns = parse_ensemble_response(content, &ensemble_speakers(), true, 1)
            .expect("ensemble turns");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].envelope.messages, vec!["おはよう", "今日も早いね"]);
    }

    fn narrated_speakers() -> Vec<EnsembleSpeaker> {
        let mut speakers = ensemble_speakers();
        speakers.push(EnsembleSpeaker {
            id: NARRATOR_ID.into(),
            expression_names: Vec::new(),
            motion_names: Vec::new(),
            max_characters: 512,
        });
        speakers
    }

    #[test]
    fn ensemble_narration_does_not_count_toward_the_turn_limit() {
        let content = r#"{"turns": [
            {"speaker": "narrator", "expression": "smile", "motion": "wave", "message": "雨が降り始めた。"},
            {"speaker": "narrator", "message": "窓が曇る。"},
            {"speaker": "aoi", "expression": "smile", "motion": "none", "message": "降ってきたね"},
            {"speaker": "narrator", "message": "遠くで雷が鳴った。"},
            {"speaker": "rin", "message": "傘ない"},
            {"speaker": "narrator", "message": "これは残らない。"}
        ]}"#;
        let turns = parse_ensemble_response(content, &narrated_speakers(), false, 1)
            .expect("ensemble turns");
        let speakers = turns.iter().map(|turn| turn.speaker.as_str()).collect::<Vec<_>>();
        assert_eq!(speakers, vec!["narrator", "aoi", "narrator"]);
        // 続けて並んだナレーションは1つにまとめ、表情・モーションは付かない。
        assert_eq!(turns[0].envelope.message, "雨が降り始めた。

窓が曇る。");
        assert_eq!(turns[0].envelope.expression, None);
        assert_eq!(turns[0].envelope.motion, None);
        assert_eq!(turns[2].envelope.message, "遠くで雷が鳴った。");
    }

    #[test]
    fn ensemble_response_without_valid_turns_is_an_error() {
        assert!(parse_ensemble_response("not json", &ensemble_speakers(), false, 3).is_err());
        assert!(
            parse_ensemble_response(
                r#"{"turns": [{"speaker": "ghost", "message": "誰？"}]}"#,
                &ensemble_speakers(),
                false,
                3,
            )
            .is_err()
        );
    }

    #[test]
    fn ensemble_preview_streams_closed_turns_and_the_current_speaker() {
        let speakers = ensemble_speakers();
        assert!(ensemble_response_preview(r#"{"turns": [{"spea"#, &speakers, false).is_empty());

        let partial = r#"{"turns": [{"speaker": "aoi", "expression": "smile", "motion": "none", "message": "おはよう！"}, {"speaker": "rin", "expression": "angry", "message": "お"#;
        let previews = ensemble_response_preview(partial, &speakers, false);
        assert_eq!(previews.len(), 2);
        assert!(previews[0].complete);
        assert_eq!(previews[0].speaker, "aoi");
        assert_eq!(previews[0].content, "おはよう！");
        assert_eq!(previews[0].messages, vec!["おはよう！"]);
        assert_eq!(previews[0].expression.as_deref(), Some("smile"));
        assert!(!previews[1].complete);
        assert_eq!(previews[1].speaker, "rin");
        assert_eq!(previews[1].content, "お");
        assert_eq!(previews[1].expression.as_deref(), Some("angry"));
    }

    #[test]
    fn ensemble_preview_tracks_confirmed_bubbles_in_message_mode() {
        let partial = r#"{"turns": [{"speaker": "aoi", "messages": ["おはよう", "今日"#;
        let previews = ensemble_response_preview(partial, &ensemble_speakers(), true);
        assert_eq!(previews.len(), 1);
        assert!(!previews[0].complete);
        assert_eq!(previews[0].messages, vec!["おはよう"]);
        assert_eq!(previews[0].content, "おはよう\n\n今日");
    }
}
