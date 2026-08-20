use std::collections::HashSet;

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::error::{AppError, AppResult};

use super::{
    json::{optional_string, query_json_values, required_i64, required_string, serialize},
    memories, messages,
};

pub(super) fn get_all(connection: &Connection) -> AppResult<Vec<Value>> {
    query_json_values(connection, "SELECT data_json FROM rooms ORDER BY id", [])
}

pub(super) fn put(connection: &Connection, room: Value) -> AppResult<bool> {
    upsert(connection, room)
}

pub(super) fn put_with_message(
    connection: &mut Connection,
    room: Value,
    message: Value,
) -> AppResult<()> {
    let room_id = required_string(&room, "id")?;
    let transaction = connection.transaction()?;
    if !upsert(&transaction, room)? {
        return Err(AppError::BadRequest(
            "一時ルームにはメッセージを保存できません。".to_owned(),
        ));
    }
    messages::upsert(&transaction, &room_id, message)?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn delete(connection: &mut Connection, room_id: &str) -> AppResult<()> {
    let transaction = connection.transaction()?;
    let deleted_message_ids: HashSet<String> = {
        let mut statement = transaction.prepare("SELECT id FROM messages WHERE room_id = ?1")?;
        let rows = statement.query_map(params![room_id], |row| row.get::<_, String>(0))?;
        let mut ids = HashSet::new();
        for row in rows {
            ids.insert(row?);
        }
        ids
    };
    let deleted_room_ids = HashSet::from([room_id.to_owned()]);

    transaction.execute("DELETE FROM rooms WHERE id = ?1", params![room_id])?;
    memories::clean_after_history_deletion(&transaction, &deleted_room_ids, &deleted_message_ids)?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn delete_history(connection: &mut Connection, room_id: &str) -> AppResult<()> {
    let transaction = connection.transaction()?;
    transaction.execute("DELETE FROM rooms WHERE id = ?1", params![room_id])?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn clear_all_history(connection: &mut Connection) -> AppResult<()> {
    let transaction = connection.transaction()?;
    let deleted_room_ids: HashSet<String> = {
        let mut statement = transaction.prepare("SELECT id FROM rooms")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut ids = HashSet::new();
        for row in rows {
            ids.insert(row?);
        }
        ids
    };
    let deleted_message_ids: HashSet<String> = {
        let mut statement = transaction.prepare("SELECT id FROM messages")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut ids = HashSet::new();
        for row in rows {
            ids.insert(row?);
        }
        ids
    };

    transaction.execute("DELETE FROM rooms", [])?;
    memories::clean_after_history_deletion(&transaction, &deleted_room_ids, &deleted_message_ids)?;
    transaction.execute(
        "INSERT INTO meta(key, value_json) VALUES ('currentRoomId', 'null')
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}

fn persistent(mut room: Value) -> AppResult<Option<Value>> {
    let object = room.as_object_mut().ok_or_else(|| {
        AppError::BadRequest("ルームはJSONオブジェクトである必要があります。".to_owned())
    })?;
    let is_transient = object.get("secretMode").and_then(Value::as_bool) == Some(true)
        || object.get("isDraft").and_then(Value::as_bool) == Some(true);
    object.remove("messages");
    object.remove("secretMode");
    object.remove("isDraft");
    if is_transient {
        Ok(None)
    } else {
        Ok(Some(room))
    }
}

pub(super) fn upsert(connection: &Connection, room: Value) -> AppResult<bool> {
    let Some(room) = persistent(room)? else {
        return Ok(false);
    };
    let id = required_string(&room, "id")?;
    let character_id = required_string(&room, "characterId")?;
    let situation_id = optional_string(&room, &["groupId", "situationId"]);
    let updated_at = required_i64(&room, "updatedAt")?;
    connection.execute(
        "INSERT INTO rooms(
            id, character_id, situation_id, updated_at, data_json
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
             character_id = excluded.character_id,
             situation_id = excluded.situation_id,
             updated_at = excluded.updated_at,
             data_json = excluded.data_json",
        params![
            id,
            character_id,
            situation_id,
            updated_at,
            serialize(&room)?
        ],
    )?;
    Ok(true)
}
