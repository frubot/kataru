use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::error::{AppError, AppResult};

use super::json::{
    is_true, optional_string, query_json_values, required_i64, required_string, serialize,
    string_array, unique_strings,
};

pub(super) fn get_all(connection: &Connection) -> AppResult<Vec<Value>> {
    query_json_values(
        connection,
        "SELECT data_json FROM messages ORDER BY room_id, timestamp, id",
        [],
    )
}

pub(super) fn get_by_room(connection: &Connection, room_id: &str) -> AppResult<Vec<Value>> {
    let mut messages = query_json_values(
        connection,
        "SELECT data_json FROM messages
         WHERE room_id = ?1 ORDER BY timestamp, id",
        params![room_id],
    )?;
    for message in &mut messages {
        if let Some(object) = message.as_object_mut() {
            object.remove("roomId");
        }
    }

    let message_ids: HashSet<String> = messages
        .iter()
        .filter_map(|message| optional_string(message, &["id"]))
        .collect();
    if message_ids.is_empty() {
        return Ok(messages);
    }

    let memory_rows = query_json_values(
        connection,
        "SELECT data_json FROM memories
         WHERE source_room_id = ?1 OR room_id = ?1
         ORDER BY updated_at DESC, id",
        params![room_id],
    )?;
    let mut seen_memory_ids = HashSet::new();
    let mut memories_by_message: HashMap<String, Vec<String>> = HashMap::new();
    for memory in memory_rows {
        let memory_id = optional_string(&memory, &["id"]).unwrap_or_default();
        if !seen_memory_ids.insert(memory_id) || is_true(&memory, "archived") {
            continue;
        }
        let Some(content) = optional_string(&memory, &["content"]) else {
            continue;
        };
        let Some(source_message_id) = string_array(&memory, "sourceMessageIds")
            .into_iter()
            .find(|message_id| message_ids.contains(message_id))
        else {
            continue;
        };
        memories_by_message
            .entry(source_message_id)
            .or_default()
            .push(content);
    }

    for message in &mut messages {
        let Some(message_id) = optional_string(message, &["id"]) else {
            continue;
        };
        let Some(linked_memories) = memories_by_message.remove(&message_id) else {
            continue;
        };
        let mut merged = Vec::new();
        let mut seen = HashSet::new();
        for content in string_array(message, "memories")
            .into_iter()
            .chain(linked_memories)
        {
            let content = content.trim().to_owned();
            if !content.is_empty() && seen.insert(content.clone()) {
                merged.push(Value::String(content));
            }
        }
        if !merged.is_empty()
            && let Some(object) = message.as_object_mut()
        {
            object.insert("memories".to_owned(), Value::Array(merged));
        }
    }
    Ok(messages)
}

pub(super) fn put(connection: &Connection, room_id: &str, message: Value) -> AppResult<()> {
    upsert(connection, room_id, message)
}

pub(super) fn put_many(
    connection: &mut Connection,
    room_id: &str,
    messages: Vec<Value>,
) -> AppResult<()> {
    let transaction = connection.transaction()?;
    for message in messages {
        upsert(&transaction, room_id, message)?;
    }
    transaction.commit()?;
    Ok(())
}

pub(super) fn delete(connection: &Connection, message_id: &str) -> AppResult<()> {
    connection.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
    Ok(())
}

pub(super) fn delete_many(connection: &mut Connection, message_ids: Vec<String>) -> AppResult<()> {
    let transaction = connection.transaction()?;
    for message_id in unique_strings(message_ids) {
        transaction.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
    }
    transaction.commit()?;
    Ok(())
}

pub(super) fn all_exist(connection: &Connection, message_ids: Vec<String>) -> AppResult<bool> {
    for message_id in unique_strings(message_ids) {
        let exists = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE id = ?1)",
            params![message_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn clear_by_room(connection: &Connection, room_id: &str) -> AppResult<()> {
    connection.execute("DELETE FROM messages WHERE room_id = ?1", params![room_id])?;
    Ok(())
}

fn stored_message(room_id: &str, mut message: Value) -> AppResult<Value> {
    let object = message.as_object_mut().ok_or_else(|| {
        AppError::BadRequest("メッセージはJSONオブジェクトである必要があります。".to_owned())
    })?;
    object.insert("roomId".to_owned(), Value::String(room_id.to_owned()));
    Ok(message)
}

pub(super) fn upsert(connection: &Connection, room_id: &str, message: Value) -> AppResult<()> {
    let mut message = stored_message(room_id, message)?;
    sanitize_assistant(&mut message);
    let id = required_string(&message, "id")?;
    let timestamp = required_i64(&message, "timestamp")?;
    connection.execute(
        "INSERT INTO messages(id, room_id, timestamp, data_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
             room_id = excluded.room_id,
             timestamp = excluded.timestamp,
             data_json = excluded.data_json",
        params![id, room_id, timestamp, serialize(&message)?],
    )?;
    Ok(())
}

pub(super) fn sanitize_assistant(message: &mut Value) {
    if optional_string(message, &["role"]).as_deref() == Some("assistant")
        && let Some(content) = optional_string(message, &["content"])
        && let Some(object) = message.as_object_mut()
    {
        object.insert(
            "content".to_owned(),
            Value::String(crate::conversation::sanitize_assistant_reply_content(
                &content,
            )),
        );
    }
}
