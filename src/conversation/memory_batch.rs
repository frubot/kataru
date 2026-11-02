//! 記憶のバッチ抽出。
//!
//! 毎ターンではなく、未反映の発言がたまったとき（または要約で押し出されたとき、
//! 別のルームへ移ったとき）にまとめて長期記憶を作る。どこまで反映したかは
//! ルームごとのカーソルで持つ。

use serde_json::{Value, json};

use crate::{
    AppState,
    ai::routes::MEMORY_BATCH_MAX_UPDATES,
    db::{get_character_room_ids, get_memory_batch_source, persist_batch_memories},
};

use super::{
    memory::prepare_conversation_memories,
    orchestrator::{BatchExtractionInput, extract_batch_memories},
    prompts::{boolean, message_text_with_attachments, string},
};

/// 未反映の user 発言がこの数に達したらバッチ抽出する。
const MEMORY_BATCH_USER_TURNS: usize = 10;
/// 1回の抽出に渡す発言の上限。超えた分は次のまとまりに回す。
const MEMORY_BATCH_MAX_MESSAGES: usize = 40;
/// 文脈として添える直前の発言数。
const MEMORY_BATCH_CONTEXT_MESSAGES: usize = 3;
/// 1回の実行で処理するまとまりの上限。残りは次のきっかけで処理する。
const MEMORY_BATCH_MAX_CHUNKS_PER_RUN: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MemoryBatchMode {
    /// バッチ抽出しない（従来どおり毎ターン抽出）。
    Off,
    /// 毎ターン抽出はそのまま。バッチ抽出も走らせるが保存せず、件数だけログに出す。
    Shadow,
    /// 毎ターン抽出は明示的な依頼だけにして、それ以外はバッチ抽出で保存する。
    On,
}

impl MemoryBatchMode {
    pub(crate) fn from_payload(payload: &Value) -> Self {
        match payload.get("memoryBatchMode").and_then(Value::as_str) {
            Some("shadow") => Self::Shadow,
            Some("on") => Self::On,
            _ => Self::Off,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MemoryBatchTrigger {
    /// 未反映の user 発言が閾値に達したときだけ抽出する。
    Threshold,
    /// 未反映の発言が1件でもあれば抽出する（要約で押し出されたとき、別ルームの反映）。
    Flush,
}

#[derive(Debug, PartialEq)]
enum BatchPlan {
    /// 抽出するものがない。
    Nothing,
    /// `context` を文脈に、`pending` を抽出する。
    Extract {
        context: Vec<Value>,
        pending: Vec<Value>,
    },
}

/// このターンの後、記憶のバッチ抽出が必要なら実行する。
/// 現在のルームに加え、同じキャラクターの別のルームに残っている未反映分も反映する。
pub(crate) async fn run_memory_batches_after_turn(
    state: &AppState,
    payload: &Value,
    room_id: &str,
    summarized: bool,
) {
    let mode = MemoryBatchMode::from_payload(payload);
    if mode == MemoryBatchMode::Off || !batch_memory_allowed(payload) {
        return;
    }
    let trigger = if summarized {
        MemoryBatchTrigger::Flush
    } else {
        MemoryBatchTrigger::Threshold
    };
    run_room_memory_batch(state, payload, mode, room_id, trigger).await;

    let character_id = payload
        .get("character")
        .map(|character| string(character, "id"))
        .unwrap_or_default();
    let other_rooms = match get_character_room_ids(&state.database, &character_id).await {
        Ok(ids) => ids,
        Err(error) => {
            tracing::warn!(
                stage = "memory_batch_rooms_failed",
                classification = error.diagnostic_class(),
                "Rooms for memory batch flushing could not be listed"
            );
            return;
        }
    };
    for other_room_id in other_rooms.iter().filter(|id| id.as_str() != room_id) {
        run_room_memory_batch(
            state,
            payload,
            mode,
            other_room_id,
            MemoryBatchTrigger::Flush,
        )
        .await;
    }
}

/// ルームを離れるときなどに、そのルームの未反映分を全部反映する。
pub(crate) async fn run_memory_flush(state: &AppState, payload: &Value, room_id: &str) {
    let mode = MemoryBatchMode::from_payload(payload);
    if mode == MemoryBatchMode::Off || !batch_memory_allowed(payload) {
        return;
    }
    run_room_memory_batch(state, payload, mode, room_id, MemoryBatchTrigger::Flush).await;
}

/// 単体会話で、キャラクターの記憶が有効なときだけバッチ抽出する。
fn batch_memory_allowed(payload: &Value) -> bool {
    if payload
        .get("situation")
        .is_some_and(|situation| situation.is_object())
    {
        return false;
    }
    let Some(character) = payload.get("character").filter(|value| value.is_object()) else {
        return false;
    };
    !string(character, "id").is_empty()
        && !matches!(character.get("enableMemory"), Some(Value::Bool(false)))
}

async fn run_room_memory_batch(
    state: &AppState,
    payload: &Value,
    mode: MemoryBatchMode,
    room_id: &str,
    trigger: MemoryBatchTrigger,
) {
    let Some(_running) = state.conversation_jobs.begin_memory_batch(room_id) else {
        return;
    };
    let source = match get_memory_batch_source(&state.database, room_id).await {
        Ok(Some(source)) => source,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(
                stage = "memory_batch_source_failed",
                classification = error.diagnostic_class(),
                "Memory batch source could not be read"
            );
            return;
        }
    };
    let (context, pending) = match plan_batch(&source.messages, source.cursor.as_ref(), trigger) {
        BatchPlan::Nothing => return,
        BatchPlan::Extract { context, pending } => (context, pending),
    };

    let Some(character) = payload.get("character").filter(|value| value.is_object()) else {
        return;
    };
    // 別のルームを処理するときも、記憶の sourceRoomId がそのルームになるようにする。
    let mut batch_payload = payload.clone();
    batch_payload["room"] = json!({"id": room_id});

    let mut context = context;
    for chunk in pending
        .chunks(MEMORY_BATCH_MAX_MESSAGES)
        .take(MEMORY_BATCH_MAX_CHUNKS_PER_RUN)
    {
        let Some(cursor) = chunk.last().map(cursor_of) else {
            break;
        };
        let extraction = extract_batch_memories(
            state,
            &batch_payload,
            BatchExtractionInput {
                character,
                room_id,
                summary: &source.summary,
                context_messages: &context,
                messages: chunk,
            },
        )
        .await;
        let (candidates, mut usages) = match extraction {
            Ok(extraction) => extraction,
            Err(error) => {
                // カーソルは進めず、次のきっかけでやり直す。
                tracing::warn!(
                    stage = "memory_batch_extraction_failed",
                    classification = error.diagnostic_class(),
                    "Memory batch extraction failed"
                );
                return;
            }
        };
        normalize_usage_ids(&mut usages, room_id);
        let candidate_count = candidates.len();
        let memories = if mode == MemoryBatchMode::On {
            let _persistence = state.conversation_jobs.lock_memory_persistence().await;
            match prepare_conversation_memories(
                state,
                &batch_payload,
                chunk,
                candidates,
                MEMORY_BATCH_MAX_UPDATES,
            )
            .await
            {
                Ok(memories) => memories,
                Err(error) => {
                    tracing::warn!(
                        stage = "memory_batch_preparation_failed",
                        classification = error.diagnostic_class(),
                        "Memory batch could not be prepared"
                    );
                    return;
                }
            }
        } else {
            Vec::new()
        };
        let saved = match persist_batch_memories(&state.database, room_id, cursor, memories, usages)
            .await
        {
            Ok(saved) => saved,
            Err(error) => {
                tracing::warn!(
                    stage = "memory_batch_persistence_failed",
                    classification = error.diagnostic_class(),
                    "Memory batch could not be persisted"
                );
                return;
            }
        };
        if mode == MemoryBatchMode::Shadow {
            tracing::info!(
                stage = "memory_batch_shadow",
                message_count = chunk.len(),
                candidate_count,
                "Memory batch shadow extraction"
            );
        } else {
            tracing::info!(
                stage = "memory_batch_persisted",
                message_count = chunk.len(),
                candidate_count,
                saved_count = saved,
                "Memory batch persisted"
            );
        }
        context = context_before(chunk, chunk.len());
    }
}

fn plan_batch(
    messages: &[Value],
    cursor: Option<&Value>,
    trigger: MemoryBatchTrigger,
) -> BatchPlan {
    let sources = messages
        .iter()
        .filter(|message| is_memory_source(message))
        .cloned()
        .collect::<Vec<_>>();
    // カーソルが無いルーム（新しいルーム、またはバッチ抽出を有効にする前からのルーム）は、
    // 直近の1まとまり分から始める。古い履歴まで一気に抽出しないため。
    let start = cursor.map_or_else(
        || sources.len().saturating_sub(MEMORY_BATCH_MAX_MESSAGES),
        |cursor| position_after_cursor(&sources, cursor),
    );
    let pending = sources[start..].to_vec();
    if pending.is_empty() {
        return BatchPlan::Nothing;
    }
    let user_turns = pending
        .iter()
        .filter(|message| string(message, "role") == "user")
        .count();
    if trigger == MemoryBatchTrigger::Threshold && user_turns < MEMORY_BATCH_USER_TURNS {
        return BatchPlan::Nothing;
    }
    BatchPlan::Extract {
        context: context_before(&sources, start),
        pending,
    }
}

fn is_memory_source(message: &Value) -> bool {
    let role = string(message, "role");
    (role == "user" || role == "assistant")
        && !boolean(message, "internal")
        && !string(message, "id").is_empty()
        && !message_text_with_attachments(message, true)
            .trim()
            .is_empty()
}

/// カーソルの直後の位置。カーソルの発言が消えていたら、タイムスタンプで位置を決める。
fn position_after_cursor(sources: &[Value], cursor: &Value) -> usize {
    let message_id = string(cursor, "messageId");
    if let Some(index) = sources
        .iter()
        .position(|message| !message_id.is_empty() && string(message, "id") == message_id)
    {
        return index + 1;
    }
    let timestamp = cursor.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
    sources
        .iter()
        .position(|message| message_timestamp(message) > timestamp)
        .unwrap_or(sources.len())
}

fn context_before(sources: &[Value], start: usize) -> Vec<Value> {
    sources[start.saturating_sub(MEMORY_BATCH_CONTEXT_MESSAGES)..start].to_vec()
}

fn cursor_of(message: &Value) -> Value {
    json!({
        "messageId": string(message, "id"),
        "timestamp": message_timestamp(message),
    })
}

fn message_timestamp(message: &Value) -> i64 {
    message
        .get("timestamp")
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn normalize_usage_ids(usages: &mut [Value], room_id: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    for (index, usage) in usages.iter_mut().enumerate() {
        if let Some(object) = usage.as_object_mut() {
            object.insert(
                "id".to_owned(),
                Value::String(format!("memory-batch-usage-{room_id}-{now}-{index}")),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn message(id: &str, role: &str, timestamp: i64) -> Value {
        json!({"id": id, "role": role, "content": format!("{id} content"), "timestamp": timestamp})
    }

    fn conversation(user_turns: usize) -> Vec<Value> {
        (0..user_turns)
            .flat_map(|turn| {
                let base = (turn as i64) * 10;
                [
                    message(&format!("u{turn}"), "user", base),
                    message(&format!("a{turn}"), "assistant", base + 1),
                ]
            })
            .collect()
    }

    #[test]
    fn mode_defaults_to_off() {
        assert_eq!(
            MemoryBatchMode::from_payload(&json!({})),
            MemoryBatchMode::Off
        );
        assert_eq!(
            MemoryBatchMode::from_payload(&json!({"memoryBatchMode": "shadow"})),
            MemoryBatchMode::Shadow
        );
        assert_eq!(
            MemoryBatchMode::from_payload(&json!({"memoryBatchMode": "on"})),
            MemoryBatchMode::On
        );
        assert_eq!(
            MemoryBatchMode::from_payload(&json!({"memoryBatchMode": "unknown"})),
            MemoryBatchMode::Off
        );
    }

    #[test]
    fn missing_cursor_starts_from_the_first_message_of_a_short_room() {
        let messages = conversation(3);
        let BatchPlan::Extract { context, pending } =
            plan_batch(&messages, None, MemoryBatchTrigger::Flush)
        else {
            panic!("expected extraction");
        };
        assert!(context.is_empty());
        assert_eq!(pending.len(), 6);
        assert_eq!(pending[0]["id"], "u0");
        assert_eq!(
            plan_batch(&messages, None, MemoryBatchTrigger::Threshold),
            BatchPlan::Nothing
        );
        assert_eq!(
            plan_batch(&[], None, MemoryBatchTrigger::Flush),
            BatchPlan::Nothing
        );
    }

    #[test]
    fn missing_cursor_in_a_long_room_starts_from_the_latest_chunk() {
        let messages = conversation(30);
        let BatchPlan::Extract { pending, .. } =
            plan_batch(&messages, None, MemoryBatchTrigger::Threshold)
        else {
            panic!("expected extraction");
        };
        assert_eq!(pending.len(), MEMORY_BATCH_MAX_MESSAGES);
        assert_eq!(pending[0]["id"], "u10");
    }

    #[test]
    fn threshold_waits_for_enough_user_turns() {
        let messages = conversation(12);
        let cursor = json!({"messageId": "a2", "timestamp": 21});
        // a2 より後は u3..u11 の 9 ターン。
        assert_eq!(
            plan_batch(&messages, Some(&cursor), MemoryBatchTrigger::Threshold),
            BatchPlan::Nothing
        );
        let cursor = json!({"messageId": "a1", "timestamp": 11});
        let BatchPlan::Extract { context, pending } =
            plan_batch(&messages, Some(&cursor), MemoryBatchTrigger::Threshold)
        else {
            panic!("expected extraction");
        };
        assert_eq!(pending.len(), 20);
        assert_eq!(pending[0]["id"], "u2");
        let context_ids = context
            .iter()
            .map(|message| string(message, "id"))
            .collect::<Vec<_>>();
        assert_eq!(context_ids, ["a0", "u1", "a1"]);
    }

    #[test]
    fn flush_extracts_any_pending_message() {
        let messages = conversation(3);
        let cursor = json!({"messageId": "u2", "timestamp": 20});
        let BatchPlan::Extract { pending, .. } =
            plan_batch(&messages, Some(&cursor), MemoryBatchTrigger::Flush)
        else {
            panic!("expected extraction");
        };
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["id"], "a2");
        let cursor = json!({"messageId": "a2", "timestamp": 21});
        assert_eq!(
            plan_batch(&messages, Some(&cursor), MemoryBatchTrigger::Flush),
            BatchPlan::Nothing
        );
    }

    #[test]
    fn deleted_cursor_message_falls_back_to_timestamp() {
        let messages = conversation(3);
        let cursor = json!({"messageId": "deleted", "timestamp": 15});
        let BatchPlan::Extract { pending, .. } =
            plan_batch(&messages, Some(&cursor), MemoryBatchTrigger::Flush)
        else {
            panic!("expected extraction");
        };
        assert_eq!(pending[0]["id"], "u2");
    }

    #[test]
    fn internal_and_empty_messages_are_not_memory_sources() {
        let mut messages = conversation(1);
        messages.push(
            json!({"id": "i", "role": "user", "content": "x", "internal": true, "timestamp": 5}),
        );
        messages.push(json!({"id": "e", "role": "assistant", "content": " ", "timestamp": 6}));
        messages.push(json!({"id": "s", "role": "system", "content": "x", "timestamp": 7}));
        let cursor = json!({"messageId": "u0", "timestamp": 0});
        let BatchPlan::Extract { pending, .. } =
            plan_batch(&messages, Some(&cursor), MemoryBatchTrigger::Flush)
        else {
            panic!("expected extraction");
        };
        let ids = pending
            .iter()
            .map(|message| string(message, "id"))
            .collect::<Vec<_>>();
        assert_eq!(ids, ["a0"]);
    }

    #[test]
    fn situation_rooms_and_disabled_memory_skip_batches() {
        assert!(batch_memory_allowed(&json!({"character": {"id": "c"}})));
        assert!(!batch_memory_allowed(
            &json!({"character": {"id": "c"}, "situation": {"id": "s"}})
        ));
        assert!(!batch_memory_allowed(
            &json!({"character": {"id": "c", "enableMemory": false}})
        ));
        assert!(!batch_memory_allowed(&json!({})));
    }
}
