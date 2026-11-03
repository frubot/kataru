use std::{collections::HashSet, time::Duration};

use futures_util::future::join_all;
use serde_json::{Value, json};

use crate::{
    AppState,
    ai::{AiApiClient, ai_api_config_value, routes::optional_role_selection},
    db::get_conversation_memories,
    error::AppResult,
    user_placeholder::{resolve_json_user_placeholders, resolve_user_placeholders},
};

use super::prompts::string;

const MEMORY_SAVE_MIN_IMPORTANCE: f64 = 0.4;
const MEMORY_SAVE_MIN_CONFIDENCE: f64 = 0.75;
const MEMORY_TURN_DEDUP_SIMILARITY_THRESHOLD: f64 = 0.68;
const MEMORY_EXISTING_DEDUP_SIMILARITY_THRESHOLD: f64 = 0.78;
const MEMORY_DUPLICATE_SIMILARITY_THRESHOLD: f64 = 0.7;
/// 候補の2文字の組のうち、設定の1文に含まれる割合がこれ以上なら設定に書かれているとみなす。
const MEMORY_SETTING_COVERAGE_THRESHOLD: f64 = 0.6;

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
    messages: &[Value],
    candidates: Vec<Value>,
    max_updates: usize,
) -> AppResult<Vec<Value>> {
    let Some(character) = payload.get("character").filter(|value| value.is_object()) else {
        return Ok(Vec::new());
    };
    let character_id = string(character, "id");
    if character_id.is_empty() {
        return Ok(Vec::new());
    }
    let has_source_message = messages
        .iter()
        .any(|message| !string(message, "id").is_empty() && !string(message, "content").is_empty());
    if !has_source_message || candidates.is_empty() {
        return Ok(Vec::new());
    }

    let existing = get_conversation_memories(&state.database, &character_id).await?;
    let config = ai_api_config_value(payload);
    let config_string = |key: &str| {
        config
            .and_then(|config| config.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    let selected = select_memory_candidates(
        candidates,
        character,
        &existing,
        config_string("userName"),
        config_string("userProfile"),
        max_updates,
    );
    if selected.is_empty() {
        return Ok(Vec::new());
    }

    let embedding_selection =
        optional_role_selection(payload, "memoryEmbeddingModel", "memoryEmbeddingModel");
    let embedding_model = embedding_selection
        .as_ref()
        .map(|selection| selection.model.clone())
        .unwrap_or_default();
    // The effective connection id is only known once the client is resolved,
    // so the client must be built before needs_embedding is decided.
    let api_client = if embedding_model.is_empty() {
        None
    } else {
        match AiApiClient::from_state_for(
            state,
            ai_api_config_value(payload),
            embedding_selection
                .as_ref()
                .and_then(|selection| selection.connection_id.as_deref()),
        ) {
            Ok(api_client) => Some(api_client),
            Err(error) => {
                tracing::warn!(
                    classification = error.diagnostic_class(),
                    "Memory embedding client could not be initialized; preserving memories without new embeddings"
                );
                None
            }
        }
    };
    let embedding_connection_id = api_client
        .as_ref()
        .map(|client| client.connection_id().to_owned())
        .unwrap_or_default();
    let now = now_millis();
    let mut prepared = merge_memory_candidates(
        selected,
        existing,
        &character_id,
        &string(payload.get("room").unwrap_or(&Value::Null), "id"),
        &embedding_model,
        &embedding_connection_id,
        now,
    );
    if !prepared.iter().any(|memory| memory.needs_embedding) {
        return Ok(prepared.into_iter().map(|memory| memory.value).collect());
    }

    let Some(api_client) = api_client else {
        return Ok(prepared.into_iter().map(|memory| memory.value).collect());
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
        object.insert(
            "embeddingConnectionId".to_owned(),
            Value::String(api_client.connection_id().to_owned()),
        );
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
    resolve_json_user_placeholders(&mut body, api_client.user_name());
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
    user_name: &str,
    user_profile: &str,
    max_updates: usize,
) -> Vec<Value> {
    let mut setting = candidate_character_setting(character);
    let user_profile = user_profile.trim();
    if !user_profile.is_empty() {
        setting.push_str(&format!("\n\n# {{{{user}}}}自身の設定\n{user_profile}"));
    }
    let setting_prompt = resolve_user_placeholders(&setting, user_name);
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
        if selected.len() >= max_updates {
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
    embedding_connection_id: &str,
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
                    || string(&merged, "embeddingModel") != embedding_model
                    || string(&merged, "embeddingConnectionId") != embedding_connection_id);
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
    object.remove("embeddingConnectionId");
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
            format!("# {{{{user}}}}について\n{protagonist_prompt}")
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

/// 候補がキャラ設定にすでに書かれているか。
/// 設定全体と比べると、長い設定ほどどんな候補も「よくある2文字の組」で重なって見えてしまうので、
/// 設定を1文ずつに分け、候補の大半がどれか1文に含まれているときだけ「書かれている」とみなす。
pub(super) fn is_covered_by_character_setting(content: &str, setting_prompt: &str) -> bool {
    let content_key = normalized_memory_key(content);
    if content_key.is_empty() {
        return false;
    }
    if normalized_memory_key(setting_prompt).contains(&content_key) {
        return true;
    }
    let content_signals = memory_signals(content);
    if content_signals.is_empty() {
        return false;
    }
    setting_prompt
        .split(is_setting_sentence_separator)
        .filter(|sentence| !sentence.trim().is_empty())
        .any(|sentence| {
            let sentence_signals = memory_signals(sentence);
            content_signals.intersection(&sentence_signals).count() as f64
                / content_signals.len() as f64
                >= MEMORY_SETTING_COVERAGE_THRESHOLD
        })
}

/// 検索で出てきた記憶が、常駐記憶のどれかの行とほぼ同じか。
pub(super) fn is_duplicate_of_core_memory(content: &str, core_texts: &[String]) -> bool {
    core_texts.iter().any(|core| {
        candidate_similarity(content, core) >= MEMORY_EXISTING_DEDUP_SIMILARITY_THRESHOLD
    })
}

fn is_setting_sentence_separator(character: char) -> bool {
    "
。！？!?"
        .contains(character)
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
    // {{user}} はどの記憶にも出てくるので、似ているかどうかの判定には使わない。
    value
        .to_lowercase()
        .replace("{{user}}", "")
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
        let existing = vec![json!({"content": "{{user}}は紅茶を毎朝飲む"})];
        let candidates = vec![
            json!({
                "id": "low-confidence",
                "content": "{{user}}は朝が弱い",
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
                "content": "{{user}}は紅茶を毎朝飲む",
                "kind": "fact",
                "scope": "character",
                "importance": 0.9,
                "confidence": 0.9
            }),
            json!({
                "id": "accepted",
                "content": "{{user}}の誕生日は五月三日",
                "kind": "fact",
                "scope": "character",
                "importance": 0.8,
                "confidence": 0.95
            }),
        ];

        let selected = select_memory_candidates(candidates, &character, &existing, "", "", 5);

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
            "conn-new",
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

    #[test]
    fn merge_reembeds_when_embedding_connection_differs() {
        let candidate = || {
            json!({
                "id": "memory-new",
                "content": "abcdefghij",
                "scope": "character",
                "kind": "fact",
                "importance": 0.9,
                "confidence": 0.9,
            })
        };
        let existing = |connection_id: Option<&str>| {
            let mut memory = json!({
                "id": "memory-existing",
                "characterId": "character-1",
                "content": "abcdefghij",
                "scope": "character",
                "kind": "fact",
                "embedding": [0.1, 0.2],
                "embeddingModel": "new-model",
            });
            if let Some(connection_id) = connection_id {
                memory["embeddingConnectionId"] = Value::String(connection_id.to_owned());
            }
            memory
        };

        let same_connection = merge_memory_candidates(
            vec![candidate()],
            vec![existing(Some("conn-a"))],
            "character-1",
            "",
            "new-model",
            "conn-a",
            100,
        );
        assert!(!same_connection[0].needs_embedding);

        let other_connection = merge_memory_candidates(
            vec![candidate()],
            vec![existing(Some("conn-b"))],
            "character-1",
            "",
            "new-model",
            "conn-a",
            100,
        );
        assert!(other_connection[0].needs_embedding);

        let legacy_connection = merge_memory_candidates(
            vec![candidate()],
            vec![existing(None)],
            "character-1",
            "",
            "new-model",
            "conn-a",
            100,
        );
        assert!(legacy_connection[0].needs_embedding);
    }
}

#[cfg(test)]
mod setting_coverage_tests {
    use super::{
        MEMORY_TURN_DEDUP_SIMILARITY_THRESHOLD, candidate_similarity,
        is_covered_by_character_setting, is_duplicate_of_core_memory,
    };

    #[test]
    fn user_placeholder_does_not_make_different_memories_duplicates() {
        assert!(
            candidate_similarity("{{user}}は猫が好き", "{{user}}は犬が苦手")
                < MEMORY_TURN_DEDUP_SIMILARITY_THRESHOLD
        );
        assert!(
            candidate_similarity("{{user}}は猫が好き", "{{user}}は猫が好き。")
                >= MEMORY_TURN_DEDUP_SIMILARITY_THRESHOLD
        );
    }

    const LONG_SETTING: &str = "葵は高校二年生の女の子で、弓道部に所属している。
        ユーザーとは幼なじみで、家が隣同士。好きなものは甘いものと猫。
        口調はやわらかく、語尾をのばすことが多い。ユーザーのことが少し気になっているが、
        自分の気持ちにはまだ気づいていない。休日は図書館で本を読んで過ごすことが多い。";

    #[test]
    fn new_information_is_not_hidden_by_a_long_setting() {
        assert!(!is_covered_by_character_setting(
            "ユーザーは来週の日曜に葵と水族館へ行く約束をした",
            LONG_SETTING
        ));
        assert!(!is_covered_by_character_setting(
            "ユーザーは辛いものが苦手",
            LONG_SETTING
        ));
    }

    #[test]
    fn memories_repeating_a_core_memory_line_are_duplicates() {
        let core = vec![
            "{{user}}とは恋人同士".to_owned(),
            "週末に水族館へ行く約束".to_owned(),
        ];
        assert!(is_duplicate_of_core_memory("{{user}}とは恋人同士。", &core));
        assert!(!is_duplicate_of_core_memory("{{user}}は猫が好き", &core));
        assert!(!is_duplicate_of_core_memory("{{user}}とは恋人同士", &[]));
    }

    #[test]
    fn information_already_in_one_setting_sentence_is_covered() {
        assert!(is_covered_by_character_setting(
            "葵は弓道部に所属",
            LONG_SETTING
        ));
        assert!(is_covered_by_character_setting(
            "葵の好きなものは甘いものと猫",
            LONG_SETTING
        ));
    }
}
