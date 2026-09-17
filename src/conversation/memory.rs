use std::{collections::HashSet, time::Duration};

use futures_util::future::join_all;
use serde_json::{Value, json};

use crate::{
    AppState,
    ai::{AiApiClient, ai_api_config_value, routes::optional_role_selection},
    db::get_conversation_memories,
    error::AppResult,
};

use super::prompts::string;

const MEMORY_SAVE_MIN_IMPORTANCE: f64 = 0.4;
const MEMORY_SAVE_MIN_CONFIDENCE: f64 = 0.75;
const MEMORY_SAVE_MAX_UPDATES: usize = 5;
const MEMORY_TURN_DEDUP_SIMILARITY_THRESHOLD: f64 = 0.68;
const MEMORY_EXISTING_DEDUP_SIMILARITY_THRESHOLD: f64 = 0.78;
const MEMORY_DUPLICATE_SIMILARITY_THRESHOLD: f64 = 0.7;

pub(super) struct MemoryEmbedding {
    pub(super) values: Vec<f64>,
    model: String,
}

struct PreparedMemory {
    value: Value,
    needs_embedding: bool,
}

pub(super) async fn prepare_conversation_memories(
    state: &AppState,
    payload: &Value,
    result: &Value,
) -> AppResult<Vec<Value>> {
    let Some(character) = payload.get("character").filter(|value| value.is_object()) else {
        return Ok(Vec::new());
    };
    let character_id = string(character, "id");
    if character_id.is_empty() {
        return Ok(Vec::new());
    }
    let has_source_message = result
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|message| !string(message, "id").is_empty() && !string(message, "content").is_empty());
    if !has_source_message {
        return Ok(Vec::new());
    }
    let candidates = result
        .get("memoryCandidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let existing = get_conversation_memories(&state.database, &character_id).await?;
    let selected = select_memory_candidates(candidates, character, &existing);
    if selected.is_empty() {
        return Ok(Vec::new());
    }

    let embedding_selection =
        optional_role_selection(payload, "memoryEmbeddingModel", "memoryEmbeddingModel");
    let embedding_model = embedding_selection
        .as_ref()
        .map(|selection| selection.model.clone())
        .unwrap_or_default();
    let now = now_millis();
    let mut prepared = merge_memory_candidates(
        selected,
        existing,
        &character_id,
        &string(payload.get("room").unwrap_or(&Value::Null), "id"),
        &embedding_model,
        now,
    );
    if !prepared.iter().any(|memory| memory.needs_embedding) {
        return Ok(prepared.into_iter().map(|memory| memory.value).collect());
    }

    let api_client = match AiApiClient::from_state_for(
        state,
        ai_api_config_value(payload),
        embedding_selection
            .as_ref()
            .and_then(|selection| selection.connection_id.as_deref()),
    ) {
        Ok(api_client) => api_client,
        Err(error) => {
            tracing::warn!(
                classification = error.diagnostic_class(),
                "Memory embedding client could not be initialized; preserving memories without new embeddings"
            );
            return Ok(prepared.into_iter().map(|memory| memory.value).collect());
        }
    };
    let requests = prepared.iter().map(|memory| {
        let content = string(&memory.value, "content");
        let needs_embedding = memory.needs_embedding;
        let api_client = &api_client;
        let embedding_model = &embedding_model;
        async move {
            if !needs_embedding {
                return None;
            }
            match request_embedding(api_client, &content, embedding_model, "search_document").await
            {
                Ok(embedding) => embedding,
                Err(error) => {
                    tracing::warn!(
                        classification = error.diagnostic_class(),
                        "Memory embedding failed; preserving the memory without an embedding"
                    );
                    None
                }
            }
        }
    });
    let embeddings = join_all(requests).await;
    for (memory, embedding) in prepared.iter_mut().zip(embeddings) {
        let Some(embedding) = embedding else {
            continue;
        };
        let Some(object) = memory.value.as_object_mut() else {
            continue;
        };
        object.insert("embedding".to_owned(), json!(embedding.values));
        object.insert("embeddingModel".to_owned(), Value::String(embedding.model));
        object.insert("updatedAt".to_owned(), Value::from(now_millis()));
    }
    Ok(prepared.into_iter().map(|memory| memory.value).collect())
}

pub(super) async fn request_embedding(
    api_client: &AiApiClient,
    input: &str,
    model: &str,
    input_type: &str,
) -> AppResult<Option<MemoryEmbedding>> {
    if input.trim().is_empty() || !api_client.embeddings_enabled() {
        return Ok(None);
    }
    let mut body = json!({
        "input": input,
        "model": model,
        "encoding_format": "float",
    });
    if api_client.is_openrouter() {
        body["input_type"] = Value::String(input_type.to_owned());
        body["provider"] = json!({"data_collection": "deny"});
    }
    let response = api_client
        .post("embeddings", Duration::from_secs(12))
        .json(&body)
        .send()
        .await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let data: Value = response.json().await?;
    let Some(values) = data
        .pointer("/data/0/embedding")
        .and_then(Value::as_array)
        .and_then(|values| values.iter().map(Value::as_f64).collect::<Option<Vec<_>>>())
        .filter(|values| !values.is_empty())
    else {
        return Ok(None);
    };
    let response_model = data
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(model)
        .to_owned();
    Ok(Some(MemoryEmbedding {
        values,
        model: response_model,
    }))
}

fn select_memory_candidates(
    candidates: Vec<Value>,
    character: &Value,
    existing_memories: &[Value],
) -> Vec<Value> {
    let setting_prompt = candidate_character_setting(character);
    let mut candidates = candidates
        .into_iter()
        .filter(valid_candidate)
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| candidate_weight(right).total_cmp(&candidate_weight(left)));

    let mut selected = Vec::new();
    for candidate in candidates {
        let content = string(&candidate, "content");
        if is_covered_by_character_setting(&content, &setting_prompt)
            || existing_memories.iter().any(|memory| {
                candidate_similarity(&content, &string(memory, "content"))
                    >= MEMORY_EXISTING_DEDUP_SIMILARITY_THRESHOLD
            })
            || selected.iter().any(|accepted| {
                candidate_similarity(&content, &string(accepted, "content"))
                    >= MEMORY_TURN_DEDUP_SIMILARITY_THRESHOLD
            })
        {
            continue;
        }
        selected.push(candidate);
        if selected.len() == MEMORY_SAVE_MAX_UPDATES {
            break;
        }
    }
    selected
}

fn valid_candidate(candidate: &Value) -> bool {
    let content = string(candidate, "content");
    let kind = string(candidate, "kind");
    let scope = string(candidate, "scope");
    let importance = candidate.get("importance").and_then(Value::as_f64);
    let confidence = candidate.get("confidence").and_then(Value::as_f64);
    !content.is_empty()
        && ["fact", "preference", "event", "relationship", "instruction"].contains(&kind.as_str())
        && ["character", "relationship", "world"].contains(&scope.as_str())
        && importance.is_some_and(|value| value.is_finite() && value >= MEMORY_SAVE_MIN_IMPORTANCE)
        && confidence.is_some_and(|value| value.is_finite() && value >= MEMORY_SAVE_MIN_CONFIDENCE)
}

fn candidate_weight(candidate: &Value) -> f64 {
    candidate
        .get("importance")
        .and_then(Value::as_f64)
        .unwrap_or_default()
        * candidate
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or_default()
}

fn merge_memory_candidates(
    candidates: Vec<Value>,
    mut existing: Vec<Value>,
    character_id: &str,
    room_id: &str,
    embedding_model: &str,
    now: i64,
) -> Vec<PreparedMemory> {
    let mut prepared: Vec<PreparedMemory> = Vec::new();
    for mut candidate in candidates {
        normalize_new_memory(&mut candidate, character_id, room_id, now);
        let content = string(&candidate, "content");
        let matched_index = existing.iter().position(|memory| {
            memory_text_similarity(&string(memory, "content"), &content)
                >= MEMORY_DUPLICATE_SIMILARITY_THRESHOLD
        });
        let (value, needs_embedding) = if let Some(index) = matched_index {
            let merged = merge_memory(&existing[index], &candidate, now);
            let needs_embedding = !embedding_model.is_empty()
                && (!has_embedding(&merged)
                    || string(&merged, "embeddingModel") != embedding_model);
            existing[index] = merged.clone();
            (merged, needs_embedding)
        } else {
            existing.push(candidate.clone());
            (candidate, !embedding_model.is_empty())
        };

        let memory_id = string(&value, "id");
        if let Some(previous) = prepared
            .iter_mut()
            .find(|memory| string(&memory.value, "id") == memory_id)
        {
            previous.value = value;
            previous.needs_embedding |= needs_embedding;
        } else {
            prepared.push(PreparedMemory {
                value,
                needs_embedding,
            });
        }
    }
    prepared
}

fn normalize_new_memory(memory: &mut Value, character_id: &str, room_id: &str, now: i64) {
    let Some(object) = memory.as_object_mut() else {
        return;
    };
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .map(normalize_content)
        .unwrap_or_default();
    object.insert("content".to_owned(), Value::String(content));
    object.insert(
        "characterId".to_owned(),
        Value::String(character_id.to_owned()),
    );
    if !room_id.is_empty() {
        object.insert("sourceRoomId".to_owned(), Value::String(room_id.to_owned()));
    }
    object.insert("createdAt".to_owned(), Value::from(now));
    object.insert("updatedAt".to_owned(), Value::from(now));
    object.insert("usageCount".to_owned(), Value::from(0));
    object.remove("embedding");
    object.remove("embeddingModel");
}

fn merge_memory(existing: &Value, candidate: &Value, now: i64) -> Value {
    let mut merged = existing.clone();
    let Some(object) = merged.as_object_mut() else {
        return candidate.clone();
    };
    for key in ["scope", "kind"] {
        if let Some(value) = candidate.get(key) {
            object.insert(key.to_owned(), value.clone());
        }
    }
    for key in ["importance", "confidence"] {
        let current = existing
            .get(key)
            .and_then(Value::as_f64)
            .unwrap_or_default();
        let incoming = candidate
            .get(key)
            .and_then(Value::as_f64)
            .unwrap_or_default();
        object.insert(key.to_owned(), json!(current.max(incoming)));
    }
    let source_message_ids = unique_strings(
        existing
            .get("sourceMessageIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .chain(
                candidate
                    .get("sourceMessageIds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten(),
            )
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    object.insert("sourceMessageIds".to_owned(), json!(source_message_ids));
    if let Some(source_room_id) = candidate.get("sourceRoomId") {
        object.insert("sourceRoomId".to_owned(), source_room_id.clone());
    }
    object.insert("updatedAt".to_owned(), Value::from(now));
    object.insert("archived".to_owned(), Value::Bool(false));
    merged
}

fn candidate_character_setting(character: &Value) -> String {
    let speech_style = string(character, "speechStyle");
    let protagonist_prompt = string(character, "protagonistPrompt");
    let user_constraints = string(character, "userConstraints");
    [
        string(character, "systemPrompt"),
        if speech_style.is_empty() {
            String::new()
        } else {
            format!("# 口調\n{speech_style}")
        },
        if protagonist_prompt.is_empty() {
            String::new()
        } else {
            format!("# 主人公について\n{protagonist_prompt}")
        },
        if user_constraints.is_empty() {
            String::new()
        } else {
            format!("# 追加の制約\n{user_constraints}")
        },
    ]
    .into_iter()
    .filter(|part| !part.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n\n")
}

fn is_covered_by_character_setting(content: &str, setting_prompt: &str) -> bool {
    let content_key = normalized_memory_key(content);
    let setting_key = normalized_memory_key(setting_prompt);
    !content_key.is_empty()
        && !setting_key.is_empty()
        && (setting_key.contains(&content_key)
            || candidate_similarity(content, setting_prompt) >= 0.28)
}

fn candidate_similarity(left: &str, right: &str) -> f64 {
    let left_key = normalized_memory_key(left);
    let right_key = normalized_memory_key(right);
    if left_key.is_empty() || right_key.is_empty() {
        return 0.0;
    }
    if left_key == right_key {
        return 1.0;
    }
    if left_key.contains(&right_key) || right_key.contains(&left_key) {
        let shorter = left_key.chars().count().min(right_key.chars().count());
        let longer = left_key.chars().count().max(right_key.chars().count());
        if shorter >= 8 && shorter as f64 / longer as f64 >= 0.72 {
            return 0.9;
        }
    }
    signal_similarity(left, right)
}

fn memory_text_similarity(left: &str, right: &str) -> f64 {
    let left_key = normalized_memory_key(left);
    let right_key = normalized_memory_key(right);
    if left_key.is_empty() || right_key.is_empty() {
        return 0.0;
    }
    if left_key == right_key {
        return 1.0;
    }
    if left_key.contains(&right_key) || right_key.contains(&left_key) {
        return left_key.chars().count().min(right_key.chars().count()) as f64
            / left_key.chars().count().max(right_key.chars().count()) as f64;
    }
    signal_similarity(left, right)
}

fn signal_similarity(left: &str, right: &str) -> f64 {
    let left_signals = memory_signals(left);
    let right_signals = memory_signals(right);
    if left_signals.is_empty() || right_signals.is_empty() {
        return 0.0;
    }
    left_signals.intersection(&right_signals).count() as f64
        / left_signals.len().min(right_signals.len()) as f64
}

fn memory_signals(value: &str) -> HashSet<String> {
    let mut signals = value
        .to_lowercase()
        .split(is_memory_separator)
        .filter(|token| token.chars().count() >= 2)
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    let compact = normalized_memory_key(value).chars().collect::<Vec<_>>();
    signals.extend(
        compact
            .windows(2)
            .map(|window| window.iter().collect::<String>()),
    );
    signals
}

fn is_memory_separator(character: char) -> bool {
    character.is_whitespace() || "、。,.!?！？「」『』（）()[]{}:：;；・/\\|".contains(character)
}

fn normalized_memory_key(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| {
            !character.is_whitespace()
                && !"「」『』（）()[]{}.,，。!！?？:：;；、・".contains(*character)
        })
        .collect()
}

fn normalize_content(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn has_embedding(memory: &Value) -> bool {
    memory
        .get("embedding")
        .and_then(Value::as_array)
        .is_some_and(|embedding| !embedding.is_empty())
}

fn unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_selection_uses_the_ui_thresholds_and_all_existing_memories() {
        let character = json!({
            "systemPrompt": "猫が好きな人物",
            "speechStyle": "静かに話す"
        });
        let existing = vec![json!({"content": "主人公は紅茶を毎朝飲む"})];
        let candidates = vec![
            json!({
                "id": "low-confidence",
                "content": "主人公は朝が弱い",
                "kind": "fact",
                "scope": "character",
                "importance": 0.9,
                "confidence": 0.74
            }),
            json!({
                "id": "setting",
                "content": "猫が好きな人物",
                "kind": "preference",
                "scope": "character",
                "importance": 1.0,
                "confidence": 1.0
            }),
            json!({
                "id": "existing",
                "content": "主人公は紅茶を毎朝飲む",
                "kind": "fact",
                "scope": "character",
                "importance": 0.9,
                "confidence": 0.9
            }),
            json!({
                "id": "accepted",
                "content": "主人公の誕生日は五月三日",
                "kind": "fact",
                "scope": "character",
                "importance": 0.8,
                "confidence": 0.95
            }),
        ];

        let selected = select_memory_candidates(candidates, &character, &existing);

        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0]["id"], "accepted");
    }

    #[test]
    fn duplicate_merge_preserves_content_and_combines_sources() {
        let existing = json!({
            "id": "memory-existing",
            "characterId": "character-1",
            "content": "abcdefghij",
            "scope": "character",
            "kind": "fact",
            "importance": 0.5,
            "confidence": 0.8,
            "sourceRoomId": "room-old",
            "sourceMessageIds": ["message-old"],
            "embedding": [0.1, 0.2],
            "embeddingModel": "old-model",
            "archived": true,
            "updatedAt": 1
        });
        let candidate = json!({
            "id": "memory-new",
            "content": "abcdefg",
            "scope": "relationship",
            "kind": "relationship",
            "importance": 0.9,
            "confidence": 0.9,
            "sourceMessageIds": ["message-new"]
        });

        let prepared = merge_memory_candidates(
            vec![candidate],
            vec![existing],
            "character-1",
            "room-new",
            "new-model",
            100,
        );

        assert_eq!(prepared.len(), 1);
        assert_eq!(prepared[0].value["id"], "memory-existing");
        assert_eq!(prepared[0].value["content"], "abcdefghij");
        assert_eq!(prepared[0].value["scope"], "relationship");
        assert_eq!(prepared[0].value["importance"], 0.9);
        assert_eq!(
            prepared[0].value["sourceMessageIds"],
            json!(["message-old", "message-new"])
        );
        assert_eq!(prepared[0].value["sourceRoomId"], "room-new");
        assert_eq!(prepared[0].value["archived"], false);
        assert!(prepared[0].needs_embedding);
    }
}
