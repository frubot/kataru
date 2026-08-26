use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use crate::error::{AppError, AppResult};

use super::{
    Database,
    json::{now_millis, optional_string, required_i64, required_string},
    messages::{get_by_room, sanitize_assistant, upsert as upsert_message},
    rooms::upsert as upsert_room,
    usage::upsert as upsert_usage_record,
};

pub async fn persist_conversation_submission(
    database: &Database,
    payload: &Value,
    secret_mode: bool,
    continuation_generation: bool,
) -> AppResult<()> {
    if secret_mode || continuation_generation {
        return Ok(());
    }
    let room = payload
        .get("room")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| AppError::BadRequest("room が必要です。".to_owned()))?;
    let room_id = required_string(&room, "id")?;
    let user_message = payload
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|messages| {
            messages
                .iter()
                .rev()
                .find(|message| optional_string(message, &["role"]).as_deref() == Some("user"))
        })
        .cloned()
        .ok_or_else(|| AppError::BadRequest("ユーザーメッセージが必要です。".to_owned()))?;

    database
        .call(move |connection| {
            let transaction = connection.transaction()?;
            if !upsert_room(&transaction, room)? {
                return Err(AppError::BadRequest(
                    "永続化できないルームではバックグラウンド保存を利用できません。".to_owned(),
                ));
            }
            upsert_message(&transaction, &room_id, user_message)?;
            transaction.commit()?;
            Ok(())
        })
        .await
}

pub async fn persist_conversation_result(
    database: &Database,
    room_id: &str,
    result: &Value,
    secret_mode: bool,
) -> AppResult<()> {
    if secret_mode {
        return Ok(());
    }
    let room_id = room_id.to_owned();
    let mut messages = result
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for message in &mut messages {
        sanitize_assistant(message);
    }
    let usages = result
        .get("usages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let summary = result
        .get("summary")
        .filter(|value| value.is_object())
        .cloned();

    database
        .call(move |connection| {
            let transaction = connection.transaction()?;
            let room_json = transaction
                .query_row(
                    "SELECT data_json FROM rooms WHERE id = ?1",
                    params![room_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| {
                    AppError::NotFound("生成結果の保存先ルームが見つかりません。".to_owned())
                })?;
            let mut room: Value = serde_json::from_str(&room_json)?;
            let now = now_millis();

            if let Some(summary) = &summary {
                let text = optional_string(summary, &["text"]);
                let checkpoint = optional_string(summary, &["checkpointUserMessageId"]);
                if let Some(object) = room.as_object_mut() {
                    if let Some(text) = text {
                        append_summary_revision(object, &text, checkpoint.as_deref(), now);
                        object.insert("summary".to_owned(), Value::String(text));
                    }
                    if let Some(checkpoint) = checkpoint {
                        object.insert(
                            "summaryCheckpointUserMessageId".to_owned(),
                            Value::String(checkpoint),
                        );
                    }
                }

                let keep_count = summary
                    .get("keepCount")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                    .unwrap_or(0);
                if keep_count > 0 {
                    let existing = get_by_room(&transaction, &room_id)?;
                    let cut_index = existing.len().saturating_sub(keep_count);
                    for mut message in existing.into_iter().take(cut_index) {
                        if let Some(object) = message.as_object_mut() {
                            object.insert("archived".to_owned(), Value::Bool(true));
                        }
                        upsert_message(&transaction, &room_id, message)?;
                    }
                }
            }

            if let Some(last_message) = messages.last() {
                let content = optional_string(last_message, &["content"]).unwrap_or_default();
                let timestamp = required_i64(last_message, "timestamp")?;
                if let Some(object) = room.as_object_mut() {
                    object.insert(
                        "lastMessagePreview".to_owned(),
                        Value::String(preview(&content)),
                    );
                    object.insert("lastMessageAt".to_owned(), Value::from(timestamp));
                    object.insert("updatedAt".to_owned(), Value::from(now));
                }
            }
            upsert_room(&transaction, room)?;

            for message in messages {
                upsert_message(&transaction, &room_id, message)?;
            }
            for usage in usages {
                upsert_usage_record(&transaction, usage)?;
            }
            transaction.commit()?;
            Ok(())
        })
        .await
}

fn append_summary_revision(
    room: &mut serde_json::Map<String, Value>,
    text: &str,
    checkpoint: Option<&str>,
    created_at: i64,
) {
    const HISTORY_LIMIT: usize = 20;
    let history = room
        .entry("summaryHistory".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !history.is_array() {
        *history = Value::Array(Vec::new());
    }
    let entries = history
        .as_array_mut()
        .expect("summary history was normalized to an array");
    let duplicate = entries.last().is_some_and(|previous| {
        optional_string(previous, &["text"]).as_deref() == Some(text)
            && optional_string(previous, &["checkpointUserMessageId"]).as_deref() == checkpoint
            && optional_string(previous, &["source"]).as_deref() == Some("automatic")
    });
    if duplicate {
        return;
    }
    let mut revision = serde_json::Map::new();
    revision.insert("text".to_owned(), Value::String(text.to_owned()));
    if let Some(checkpoint) = checkpoint {
        revision.insert(
            "checkpointUserMessageId".to_owned(),
            Value::String(checkpoint.to_owned()),
        );
    }
    revision.insert("createdAt".to_owned(), Value::from(created_at));
    revision.insert("source".to_owned(), Value::String("automatic".to_owned()));
    entries.push(Value::Object(revision));
    if entries.len() > HISTORY_LIMIT {
        entries.drain(..entries.len() - HISTORY_LIMIT);
    }
}

fn preview(content: &str) -> String {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.chars().take(50).collect()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rusqlite::params;
    use serde_json::json;

    use super::{persist_conversation_result, persist_conversation_submission};
    use crate::db::storage::{messages::get_by_room, test_support::test_room};
    use crate::db::{Database, storage::json::query_optional_json};

    #[tokio::test]
    async fn background_conversation_persists_submission_and_result() {
        let database =
            Database::open(Path::new(":memory:")).expect("open background conversation database");
        let payload = json!({
            "room": test_room("room-background"),
            "messages": [{
                "id": "message-user",
                "role": "user",
                "content": "hello",
                "timestamp": 10
            }]
        });
        persist_conversation_submission(&database, &payload, false, false)
            .await
            .expect("persist submitted message");

        let result = json!({
            "messages": [{
                "id": "message-assistant",
                "role": "assistant",
                "content": "saved \\nin the background *unfinished",
                "characterId": "character-1",
                "usedMemoryIds": ["memory-referenced"],
                "timestamp": 20
            }],
            "usages": [{
                "id": "usage-background",
                "characterId": "character-1",
                "timestamp": 20,
                "promptTokens": 2,
                "completionTokens": 3,
                "totalTokens": 5,
                "cost": 0.01
            }],
            "summary": {
                "text": "summary",
                "checkpointUserMessageId": "message-user",
                "keepCount": 1
            }
        });
        persist_conversation_result(&database, "room-background", &result, false)
            .await
            .expect("persist generated result");

        database
            .call(|connection| {
                let messages = get_by_room(connection, "room-background")?;
                assert_eq!(messages.len(), 2);
                assert_eq!(messages[1]["id"], "message-assistant");
                assert_eq!(messages[1]["content"], "saved in the background unfinished");
                assert_eq!(messages[1]["usedMemoryIds"], json!(["memory-referenced"]));
                let room = query_optional_json(
                    connection,
                    "SELECT data_json FROM rooms WHERE id = ?1",
                    params!["room-background"],
                )?
                .expect("stored room");
                assert_eq!(room["summary"], "summary");
                assert_eq!(room["summaryHistory"][0]["text"], "summary");
                assert_eq!(room["summaryHistory"][0]["source"], "automatic");
                assert_eq!(
                    room["lastMessagePreview"],
                    "saved in the background unfinished"
                );
                let usage_count = connection.query_row(
                    "SELECT COUNT(*) FROM usage_records WHERE id = 'usage-background'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                assert_eq!(usage_count, 1);
                Ok(())
            })
            .await
            .expect("verify background result");
    }

    #[tokio::test]
    async fn continuation_generation_does_not_persist_an_internal_submission() {
        let database = Database::open(Path::new(":memory:")).expect("open continuation database");
        let payload = json!({
            "generationMode": "continue",
            "room": test_room("room-continuation"),
            "messages": [{
                "id": "message-assistant",
                "role": "assistant",
                "content": "continue from here",
                "timestamp": 10
            }]
        });

        persist_conversation_submission(&database, &payload, false, true)
            .await
            .expect("skip internal continuation submission");

        database
            .call(|connection| {
                let room_count = connection.query_row(
                    "SELECT COUNT(*) FROM rooms WHERE id = 'room-continuation'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                let message_count = connection.query_row(
                    "SELECT COUNT(*) FROM messages WHERE room_id = 'room-continuation'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                assert_eq!(room_count, 0);
                assert_eq!(message_count, 0);
                Ok(())
            })
            .await
            .expect("verify continuation submission was transient");
    }
}
