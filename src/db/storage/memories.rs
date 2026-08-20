use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::Value;

use crate::error::{AppError, AppResult};

use super::json::{
    is_true, now_millis, optional_string, query_json_values, query_optional_json, required_i64,
    required_object, required_string, serialize, string_array, unique_string_refs, unique_strings,
};

pub(super) fn get_all(connection: &Connection) -> AppResult<Vec<Value>> {
    query_json_values(connection, "SELECT data_json FROM memories ORDER BY id", [])
}

pub(super) fn get(connection: &Connection, memory_id: &str) -> AppResult<Option<Value>> {
    query_optional_json(
        connection,
        "SELECT data_json FROM memories WHERE id = ?1",
        params![memory_id],
    )
}

pub(super) fn get_by_source_message_ids(
    connection: &Connection,
    message_ids: &[String],
) -> AppResult<Vec<Value>> {
    let targets: HashSet<&str> = message_ids
        .iter()
        .filter(|message_id| !message_id.is_empty())
        .map(String::as_str)
        .collect();
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let memories = get_all(connection)?;
    Ok(memories
        .into_iter()
        .filter(|memory| {
            string_array(memory, "sourceMessageIds")
                .iter()
                .any(|message_id| targets.contains(message_id.as_str()))
        })
        .collect())
}

pub(super) fn get_by_character(
    connection: &Connection,
    character_id: &str,
) -> AppResult<Vec<Value>> {
    query_json_values(
        connection,
        "SELECT data_json FROM memories
         WHERE character_id = ?1 ORDER BY updated_at DESC, id",
        params![character_id],
    )
}

pub(super) fn get_searchable(
    connection: &Connection,
    character_id: &str,
    room_id: Option<&str>,
    recent_message_ids: &[String],
) -> AppResult<Vec<Value>> {
    let memories = get_by_character(connection, character_id)?;
    let recent_message_ids: HashSet<&str> = recent_message_ids
        .iter()
        .filter(|message_id| !message_id.is_empty())
        .map(String::as_str)
        .collect();
    Ok(memories
        .into_iter()
        .filter(|memory| {
            if is_true(memory, "archived") {
                return false;
            }
            let Some(room_id) = room_id else {
                return true;
            };
            if recent_message_ids.is_empty() {
                return true;
            }
            let is_already_in_recent_history = string_array(memory, "sourceMessageIds")
                .iter()
                .any(|message_id| recent_message_ids.contains(message_id.as_str()));
            let is_same_room_memory = optional_string(memory, &["sourceRoomId"]).as_deref()
                == Some(room_id)
                || optional_string(memory, &["roomId"]).as_deref() == Some(room_id)
                || is_already_in_recent_history;
            !is_same_room_memory || !is_already_in_recent_history
        })
        .collect())
}

pub(super) fn put(connection: &Connection, memory: Value) -> AppResult<()> {
    upsert(connection, memory)
}

pub(super) fn put_many(connection: &mut Connection, memories: Vec<Value>) -> AppResult<()> {
    let transaction = connection.transaction()?;
    for memory in memories {
        upsert(&transaction, memory)?;
    }
    transaction.commit()?;
    Ok(())
}

pub(super) fn delete(connection: &Connection, memory_id: &str) -> AppResult<()> {
    connection.execute("DELETE FROM memories WHERE id = ?1", params![memory_id])?;
    Ok(())
}

pub(super) fn delete_many(connection: &mut Connection, memory_ids: Vec<String>) -> AppResult<()> {
    let transaction = connection.transaction()?;
    for memory_id in unique_strings(memory_ids) {
        transaction.execute("DELETE FROM memories WHERE id = ?1", params![memory_id])?;
    }
    transaction.commit()?;
    Ok(())
}

pub(super) fn delete_by_character(connection: &Connection, character_id: &str) -> AppResult<()> {
    connection.execute(
        "DELETE FROM memories WHERE character_id = ?1",
        params![character_id],
    )?;
    Ok(())
}

pub(super) fn upsert(connection: &Connection, memory: Value) -> AppResult<()> {
    let id = required_string(&memory, "id")?;
    let character_id = optional_string(&memory, &["characterId"]).unwrap_or_default();
    let room_id = optional_string(&memory, &["roomId"]);
    let source_room_id = optional_string(&memory, &["sourceRoomId"]);
    let scope = required_string(&memory, "scope")?;
    let kind = required_string(&memory, "kind")?;
    let updated_at = required_i64(&memory, "updatedAt")?;
    connection.execute(
        "INSERT INTO memories(
            id, character_id, room_id, source_room_id, scope, kind, updated_at, data_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
             character_id = excluded.character_id,
             room_id = excluded.room_id,
             source_room_id = excluded.source_room_id,
             scope = excluded.scope,
             kind = excluded.kind,
             updated_at = excluded.updated_at,
             data_json = excluded.data_json",
        params![
            id,
            character_id,
            room_id,
            source_room_id,
            scope,
            kind,
            updated_at,
            serialize(&memory)?
        ],
    )?;
    Ok(())
}

pub(super) fn remove_contents_from_messages(
    connection: &mut Connection,
    character_id: &str,
    contents: &[String],
) -> AppResult<()> {
    let normalized_contents: HashSet<String> = contents
        .iter()
        .map(|content| normalize_content(content))
        .filter(|content| !content.is_empty())
        .collect();
    if character_id.is_empty() || normalized_contents.is_empty() {
        return Ok(());
    }

    let transaction = connection.transaction()?;
    let messages = query_json_values(
        &transaction,
        "SELECT data_json FROM messages ORDER BY id",
        [],
    )?;
    for mut message in messages {
        if optional_string(&message, &["characterId"]).as_deref() != Some(character_id) {
            continue;
        }
        let previous_memories = string_array(&message, "memories");
        if previous_memories.is_empty() {
            continue;
        }
        let memories: Vec<String> = previous_memories
            .iter()
            .filter(|memory| !normalized_contents.contains(&normalize_content(memory)))
            .cloned()
            .collect();
        if memories.len() == previous_memories.len() {
            continue;
        }
        let object = message
            .as_object_mut()
            .ok_or_else(|| AppError::Internal("保存済みメッセージの形式が不正です。".to_owned()))?;
        if memories.is_empty() {
            object.remove("memories");
        } else {
            object.insert(
                "memories".to_owned(),
                Value::Array(memories.into_iter().map(Value::String).collect()),
            );
        }
        let message_id = required_string(&message, "id")?;
        transaction.execute(
            "UPDATE messages SET data_json = ?2 WHERE id = ?1",
            params![message_id, serialize(&message)?],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub(super) fn delete_by_character_and_content(
    connection: &mut Connection,
    character_id: &str,
    contents: &[String],
) -> AppResult<()> {
    let normalized_contents: HashSet<String> = contents
        .iter()
        .map(|content| normalize_content(content))
        .filter(|content| !content.is_empty())
        .collect();
    if normalized_contents.is_empty() {
        return Ok(());
    }
    let transaction = connection.transaction()?;
    let memories = query_json_values(
        &transaction,
        "SELECT data_json FROM memories WHERE character_id = ?1",
        params![character_id],
    )?;
    for memory in memories {
        let content = optional_string(&memory, &["content"]).unwrap_or_default();
        if normalized_contents.contains(&normalize_content(&content)) {
            transaction.execute(
                "DELETE FROM memories WHERE id = ?1",
                params![required_string(&memory, "id")?],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

pub(super) fn delete_by_source_message_ids(
    connection: &mut Connection,
    message_ids: &[String],
) -> AppResult<()> {
    let targets: HashSet<&str> = message_ids
        .iter()
        .filter(|message_id| !message_id.is_empty())
        .map(String::as_str)
        .collect();
    if targets.is_empty() {
        return Ok(());
    }

    let transaction = connection.transaction()?;
    let memories = get_all(&transaction)?;
    for mut memory in memories {
        let source_message_ids = string_array(&memory, "sourceMessageIds");
        let remaining_source_message_ids: Vec<String> = source_message_ids
            .iter()
            .filter(|message_id| !targets.contains(message_id.as_str()))
            .cloned()
            .collect();
        if remaining_source_message_ids.len() == source_message_ids.len() {
            continue;
        }
        let memory_id = required_string(&memory, "id")?;
        if remaining_source_message_ids.is_empty() {
            transaction.execute("DELETE FROM memories WHERE id = ?1", params![memory_id])?;
        } else {
            let source_room_id =
                first_message_room_id(&transaction, &remaining_source_message_ids)?;
            update_sources(
                &transaction,
                &mut memory,
                remaining_source_message_ids,
                source_room_id,
                true,
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

pub(super) fn touch(
    connection: &mut Connection,
    memory_ids: &[String],
    timestamp: i64,
) -> AppResult<()> {
    let transaction = connection.transaction()?;
    for memory_id in unique_string_refs(memory_ids) {
        let Some(mut memory) = get(&transaction, memory_id)? else {
            continue;
        };
        let usage_count = required_object(&memory)?
            .get("usageCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(1);
        let object = memory
            .as_object_mut()
            .ok_or_else(|| AppError::Internal("保存済みメモリの形式が不正です。".to_owned()))?;
        object.insert("lastUsedAt".to_owned(), Value::from(timestamp));
        object.insert("usageCount".to_owned(), Value::from(usage_count));
        object.insert("updatedAt".to_owned(), Value::from(timestamp));
        transaction.execute(
            "UPDATE memories SET updated_at = ?2, data_json = ?3 WHERE id = ?1",
            params![memory_id, timestamp, serialize(&memory)?],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub(super) fn clean_after_history_deletion(
    transaction: &Transaction<'_>,
    deleted_room_ids: &HashSet<String>,
    deleted_message_ids: &HashSet<String>,
) -> AppResult<()> {
    let memories = get_all(transaction)?;
    for mut memory in memories {
        let source_message_ids = string_array(&memory, "sourceMessageIds");
        let remaining_source_message_ids: Vec<String> = source_message_ids
            .iter()
            .filter(|message_id| !deleted_message_ids.contains(*message_id))
            .cloned()
            .collect();
        let has_deleted_source = remaining_source_message_ids.len() != source_message_ids.len();
        let is_room_scoped = optional_string(&memory, &["roomId"])
            .is_some_and(|room_id| deleted_room_ids.contains(&room_id));
        let source_room_is_deleted = optional_string(&memory, &["sourceRoomId"])
            .is_some_and(|room_id| deleted_room_ids.contains(&room_id));
        let has_only_deleted_room_sources =
            source_room_is_deleted && remaining_source_message_ids.is_empty();
        let has_only_deleted_message_sources =
            has_deleted_source && remaining_source_message_ids.is_empty();
        let memory_id = required_string(&memory, "id")?;

        if is_room_scoped || has_only_deleted_room_sources || has_only_deleted_message_sources {
            transaction.execute("DELETE FROM memories WHERE id = ?1", params![memory_id])?;
        } else if source_room_is_deleted || has_deleted_source {
            let source_room_id = first_message_room_id(transaction, &remaining_source_message_ids)?;
            update_sources(
                transaction,
                &mut memory,
                remaining_source_message_ids,
                source_room_id,
                false,
            )?;
        }
    }
    Ok(())
}

fn update_sources(
    transaction: &Transaction<'_>,
    memory: &mut Value,
    source_message_ids: Vec<String>,
    source_room_id: Option<String>,
    preserve_source_room_when_missing: bool,
) -> AppResult<()> {
    let updated_at = now_millis();
    let object = memory
        .as_object_mut()
        .ok_or_else(|| AppError::Internal("保存済みメモリの形式が不正です。".to_owned()))?;
    object.insert(
        "sourceMessageIds".to_owned(),
        Value::Array(source_message_ids.into_iter().map(Value::String).collect()),
    );
    match source_room_id {
        Some(source_room_id) => {
            object.insert("sourceRoomId".to_owned(), Value::String(source_room_id));
        }
        None if !preserve_source_room_when_missing => {
            object.remove("sourceRoomId");
        }
        None => {}
    }
    object.insert("updatedAt".to_owned(), Value::from(updated_at));

    let memory_id = required_string(memory, "id")?;
    let source_room_id = optional_string(memory, &["sourceRoomId"]);
    transaction.execute(
        "UPDATE memories
         SET source_room_id = ?2, updated_at = ?3, data_json = ?4
         WHERE id = ?1",
        params![memory_id, source_room_id, updated_at, serialize(memory)?],
    )?;
    Ok(())
}

fn first_message_room_id(
    connection: &Connection,
    message_ids: &[String],
) -> AppResult<Option<String>> {
    let Some(message_id) = message_ids.first() else {
        return Ok(None);
    };
    connection
        .query_row(
            "SELECT room_id FROM messages WHERE id = ?1",
            params![message_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(AppError::from)
}

fn normalize_content(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
