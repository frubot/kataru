//! 記憶のバッチ抽出。
//!
//! 毎ターンではなく、未反映の発言がたまったとき（または要約で押し出されたとき、
//! 別のルームへ移ったとき）にまとめて長期記憶を作る。どこまで反映したかは
//! ルームごとのカーソルで持つ。

use serde_json::{Value, json};

use crate::{
    AppState,
    ai::routes::MEMORY_BATCH_MAX_UPDATES,
    core_memory::CoreMemory,
    db::{
        get_character_room_ids, get_core_memory, get_core_memory_max_chars,
        get_memory_batch_source, persist_batch_memories, persist_conversation_memories,
        save_core_memory_if_version,
    },
};

use super::{
    background::{BackgroundTaskHandle, BackgroundTaskKind, BackgroundTaskStart},
    memory::prepare_conversation_memories,
    orchestrator::{
        BatchExtractionInput, CoreMemoryUpdateInput, extract_batch_memories, update_core_memory,
    },
    prompts::{boolean, message_text_with_attachments, string},
};

/// 未反映の user 発言がこの数に達したらバッチ抽出する。設定で変えられる。
const MEMORY_BATCH_DEFAULT_USER_TURNS: usize = 10;
/// 設定できるターン数の範囲。フロントの `MEMORY_BATCH_USER_TURNS_MIN/MAX` と同じ値。
const MEMORY_BATCH_MIN_USER_TURNS: usize = 3;
const MEMORY_BATCH_MAX_USER_TURNS: usize = 30;
/// 1回の抽出に渡す発言の上限。超えた分は次のまとまりに回す。
const MEMORY_BATCH_MAX_MESSAGES: usize = 40;
/// 文脈として添える直前の発言数。
const MEMORY_BATCH_CONTEXT_MESSAGES: usize = 3;
/// 1回の実行で処理するまとまりの上限。残りは次のきっかけで処理する。
const MEMORY_BATCH_MAX_CHUNKS_PER_RUN: usize = 3;

/// 何ターンたまったらバッチ抽出するか。設定が無いか範囲外なら既定値か範囲内に寄せる。
fn batch_user_turns(payload: &Value) -> usize {
    payload
        .get("memoryBatchUserTurns")
        .and_then(Value::as_u64)
        .map_or(MEMORY_BATCH_DEFAULT_USER_TURNS, |turns| {
            usize::try_from(turns)
                .unwrap_or(MEMORY_BATCH_MAX_USER_TURNS)
                .clamp(MEMORY_BATCH_MIN_USER_TURNS, MEMORY_BATCH_MAX_USER_TURNS)
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MemoryBatchTrigger {
    /// 未反映の user 発言が指定のターン数に達したときだけ抽出する。
    Threshold(usize),
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
    if !batch_memory_allowed(payload) {
        return;
    }
    let (trigger, reason) = if summarized {
        (MemoryBatchTrigger::Flush, "要約後")
    } else {
        (
            MemoryBatchTrigger::Threshold(batch_user_turns(payload)),
            "ターン後",
        )
    };
    run_room_memory_batch(state, payload, room_id, trigger, reason).await;

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
            other_room_id,
            MemoryBatchTrigger::Flush,
            "別ルームの未反映分",
        )
        .await;
    }
}

/// ルームを離れるときなどに、そのルームの未反映分を全部反映する。
pub(crate) async fn run_memory_flush(state: &AppState, payload: &Value, room_id: &str) {
    if !batch_memory_allowed(payload) {
        return;
    }
    run_room_memory_batch(
        state,
        payload,
        room_id,
        MemoryBatchTrigger::Flush,
        "ルーム離脱",
    )
    .await;
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
    room_id: &str,
    trigger: MemoryBatchTrigger,
    reason: &str,
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
    let task = state
        .conversation_jobs
        .background_tasks()
        .start(BackgroundTaskStart {
            kind: BackgroundTaskKind::MemoryBatch,
            reason,
            room_id,
            character: Some(character),
        });
    let chunk_total = pending
        .len()
        .div_ceil(MEMORY_BATCH_MAX_MESSAGES)
        .min(MEMORY_BATCH_MAX_CHUNKS_PER_RUN);
    let mut totals = BatchTotals::default();
    // 別のルームを処理するときも、記憶の sourceRoomId がそのルームになるようにする。
    let mut batch_payload = payload.clone();
    batch_payload["room"] = json!({"id": room_id});

    let mut context = context;
    // 常駐記憶の更新に渡す、最後に読んだまとまりと今回抽出した記憶。
    let mut last_chunk: &[Value] = &[];
    let mut new_memories = Vec::new();
    for (chunk_index, chunk) in pending
        .chunks(MEMORY_BATCH_MAX_MESSAGES)
        .take(MEMORY_BATCH_MAX_CHUNKS_PER_RUN)
        .enumerate()
    {
        let Some(cursor) = chunk.last().map(cursor_of) else {
            break;
        };
        task.set_detail(format!(
            "{}/{chunk_total} 回目を抽出中（発言 {} 件）",
            chunk_index + 1,
            chunk.len()
        ));
        let mut full_json_logs = Vec::new();
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
            &mut full_json_logs,
        )
        .await;
        task.push_logs(full_json_logs);
        let (candidates, mut usages) = match extraction {
            Ok(extraction) => extraction,
            Err(error) => {
                // カーソルは進めず、次のきっかけでやり直す。
                tracing::warn!(
                    stage = "memory_batch_extraction_failed",
                    classification = error.diagnostic_class(),
                    "Memory batch extraction failed"
                );
                task.fail(totals.failure("記憶のバッチ抽出に失敗しました", &error));
                return;
            }
        };
        normalize_usage_ids(&mut usages, room_id);
        let candidate_count = candidates.len();
        new_memories.extend(
            candidates
                .iter()
                .map(|candidate| string(candidate, "content"))
                .filter(|content| !content.is_empty()),
        );
        let memories = {
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
                    task.fail(totals.failure("記憶の保存の準備に失敗しました", &error));
                    return;
                }
            }
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
                task.fail(totals.failure("記憶の保存に失敗しました", &error));
                return;
            }
        };
        tracing::info!(
            stage = "memory_batch_persisted",
            message_count = chunk.len(),
            candidate_count,
            saved_count = saved,
            "Memory batch persisted"
        );
        totals.messages += chunk.len();
        totals.candidates += candidate_count;
        totals.saved += saved;
        context = context_before(chunk, chunk.len());
        last_chunk = chunk;
    }
    let mut summary = totals.summary();
    if !last_chunk.is_empty() && !source.core_memory_disabled {
        let core = run_core_memory_update(
            state,
            &batch_payload,
            CoreMemoryUpdateInputParts {
                character,
                room_id,
                summary: &source.summary,
                messages: last_chunk,
                new_memories: &new_memories,
            },
            &task,
        )
        .await;
        summary.push_str(&format!(" / {core}"));
    }
    task.complete(summary);
}

/// 常駐記憶の更新に渡す、バッチ抽出側で集めた材料。
struct CoreMemoryUpdateInputParts<'a> {
    character: &'a Value,
    room_id: &'a str,
    summary: &'a str,
    messages: &'a [Value],
    new_memories: &'a [String],
}

/// バッチ抽出の後に常駐記憶を更新する。戻り値はデバッグログ画面に出す結果の説明。
/// 失敗しても記憶の抽出は済んでいるので、タスクは失敗にしない。
async fn run_core_memory_update(
    state: &AppState,
    payload: &Value,
    parts: CoreMemoryUpdateInputParts<'_>,
    task: &BackgroundTaskHandle,
) -> String {
    let character_id = string(parts.character, "id");
    let current = match get_core_memory(&state.database, &character_id).await {
        Ok(memory) => memory.unwrap_or_else(|| CoreMemory::empty(&character_id)),
        Err(error) => {
            tracing::warn!(
                stage = "core_memory_read_failed",
                classification = error.diagnostic_class(),
                "Core memory could not be read"
            );
            return format!("常駐記憶を読めませんでした: {error}");
        }
    };
    let max_chars = match get_core_memory_max_chars(&state.database).await {
        Ok(max_chars) => max_chars,
        Err(error) => {
            tracing::warn!(
                stage = "core_memory_read_failed",
                classification = error.diagnostic_class(),
                "Core memory limit could not be read"
            );
            return format!("常駐記憶の上限を読めませんでした: {error}");
        }
    };
    task.set_detail("常駐記憶を更新中");
    let mut full_json_logs = Vec::new();
    let result = update_core_memory(
        state,
        payload,
        CoreMemoryUpdateInput {
            character: parts.character,
            room_id: parts.room_id,
            summary: parts.summary,
            messages: parts.messages,
            new_memories: parts.new_memories,
            memory: &current,
            max_chars,
        },
        &mut full_json_logs,
    )
    .await;
    task.push_logs(full_json_logs);
    let mut result = match result {
        Ok(result) => result,
        Err(error) => {
            tracing::warn!(
                stage = "core_memory_update_failed",
                classification = error.diagnostic_class(),
                "Core memory update failed"
            );
            return format!("常駐記憶の更新に失敗しました: {error}");
        }
    };
    normalize_usage_ids(&mut result.usages, &format!("core-{}", parts.room_id));
    let report = core_memory_report(&result.rejected, result.applied, result.attempts);
    tracing::info!(
        stage = "core_memory_updated",
        applied = result.applied,
        rejected = result.rejected.len(),
        demoted = result.demoted_candidates.len(),
        attempts = result.attempts,
        "Core memory update"
    );

    let _persistence = state.conversation_jobs.lock_memory_persistence().await;
    let source_ids = parts
        .messages
        .last()
        .map(|message| vec![string(message, "id")])
        .unwrap_or_default();
    if result.applied == 0 {
        // 費用の記録だけ残す。
        if let Err(error) =
            persist_conversation_memories(&state.database, Vec::new(), Vec::new(), result.usages)
                .await
        {
            tracing::warn!(
                stage = "core_memory_usage_persistence_failed",
                classification = error.diagnostic_class(),
                "Core memory usage could not be persisted"
            );
        }
        return report;
    }

    let saved =
        match save_core_memory_if_version(&state.database, result.memory, current.version).await {
            Ok(saved) => saved,
            Err(error) => {
                tracing::warn!(
                    stage = "core_memory_persistence_failed",
                    classification = error.diagnostic_class(),
                    "Core memory could not be persisted"
                );
                return format!("常駐記憶を保存できませんでした: {error}");
            }
        };
    let demoted = if saved {
        match prepare_conversation_memories(
            state,
            payload,
            parts.messages,
            result.demoted_candidates,
            MEMORY_BATCH_MAX_UPDATES,
        )
        .await
        {
            Ok(memories) => memories,
            Err(error) => {
                tracing::warn!(
                    stage = "core_memory_demotion_failed",
                    classification = error.diagnostic_class(),
                    "Demoted core memory lines could not be prepared"
                );
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let demoted_count = demoted.len();
    if let Err(error) =
        persist_conversation_memories(&state.database, source_ids, demoted, result.usages).await
    {
        tracing::warn!(
            stage = "core_memory_demotion_persistence_failed",
            classification = error.diagnostic_class(),
            "Demoted core memory lines could not be persisted"
        );
    }
    if !saved {
        return format!("{report}（画面で編集されていたため保存せず）");
    }
    if demoted_count > 0 {
        format!("{report} / 検索される記憶へ移動 {demoted_count} 件")
    } else {
        report
    }
}

/// 常駐記憶の更新結果の説明。見送った指示は理由も3件まで添える。
fn core_memory_report(
    rejected: &[crate::core_memory::RejectedOp],
    applied: usize,
    attempts: usize,
) -> String {
    let mut report = format!("常駐記憶: 適用 {applied} 件 / 見送り {} 件", rejected.len());
    if attempts > 1 {
        report.push_str(&format!("（やり直し {} 回）", attempts - 1));
    }
    let reasons = rejected
        .iter()
        .take(3)
        .map(|rejected| rejected.reason.as_str())
        .collect::<Vec<_>>();
    if !reasons.is_empty() {
        report.push_str(&format!("。見送りの理由: {}", reasons.join(" / ")));
    }
    report
}

/// デバッグログ画面に出す、1回の実行で処理した件数。
#[derive(Default)]
struct BatchTotals {
    messages: usize,
    candidates: usize,
    saved: usize,
}

impl BatchTotals {
    fn summary(&self) -> String {
        format!(
            "発言 {} 件 / 候補 {} 件 / 保存 {} 件",
            self.messages, self.candidates, self.saved
        )
    }

    fn failure(&self, message: &str, error: &crate::error::AppError) -> String {
        if self.messages == 0 {
            format!("{message}: {error}")
        } else {
            format!(
                "{message}: {error}（それまでに発言 {} 件を処理）",
                self.messages
            )
        }
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
    if let MemoryBatchTrigger::Threshold(required) = trigger
        && user_turns < required
    {
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
    fn user_turns_default_and_clamp_to_the_allowed_range() {
        assert_eq!(
            batch_user_turns(&json!({})),
            MEMORY_BATCH_DEFAULT_USER_TURNS
        );
        assert_eq!(
            batch_user_turns(&json!({"memoryBatchUserTurns": "x"})),
            MEMORY_BATCH_DEFAULT_USER_TURNS
        );
        assert_eq!(batch_user_turns(&json!({"memoryBatchUserTurns": 15})), 15);
        assert_eq!(
            batch_user_turns(&json!({"memoryBatchUserTurns": 1})),
            MEMORY_BATCH_MIN_USER_TURNS
        );
        assert_eq!(
            batch_user_turns(&json!({"memoryBatchUserTurns": 999})),
            MEMORY_BATCH_MAX_USER_TURNS
        );
    }

    #[test]
    fn threshold_follows_the_configured_user_turns() {
        let messages = conversation(5);
        assert_eq!(
            plan_batch(&messages, None, MemoryBatchTrigger::Threshold(6)),
            BatchPlan::Nothing
        );
        assert!(matches!(
            plan_batch(&messages, None, MemoryBatchTrigger::Threshold(5)),
            BatchPlan::Extract { .. }
        ));
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
            plan_batch(&messages, None, MemoryBatchTrigger::Threshold(10)),
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
            plan_batch(&messages, None, MemoryBatchTrigger::Threshold(10))
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
            plan_batch(&messages, Some(&cursor), MemoryBatchTrigger::Threshold(10)),
            BatchPlan::Nothing
        );
        let cursor = json!({"messageId": "a1", "timestamp": 11});
        let BatchPlan::Extract { context, pending } =
            plan_batch(&messages, Some(&cursor), MemoryBatchTrigger::Threshold(10))
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
