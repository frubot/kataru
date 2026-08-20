use rusqlite::{Connection, Transaction, params};
use serde_json::Value;

use crate::error::AppResult;

use super::{
    characters::{upsert_character, upsert_situation},
    images::prune_orphaned_image_assets,
    json::required_string,
    memories::upsert as upsert_memory,
    messages::upsert as upsert_message,
    rooms::upsert as upsert_room,
    usage::upsert as upsert_usage_record,
};

pub(super) fn clear_all(connection: &mut Connection, include_meta: bool) -> AppResult<()> {
    let transaction = connection.transaction()?;
    clear_data_tables(&transaction)?;
    if include_meta {
        transaction.execute("DELETE FROM meta", [])?;
    }
    transaction.commit()?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn bulk_write(
    connection: &mut Connection,
    characters: Vec<Value>,
    situations: Vec<Value>,
    rooms: Vec<Value>,
    messages: Vec<Value>,
    memories: Vec<Value>,
    usage_records: Vec<Value>,
) -> AppResult<()> {
    let transaction = connection.transaction()?;
    write(
        &transaction,
        characters,
        situations,
        rooms,
        messages,
        memories,
        usage_records,
    )?;
    transaction.commit()?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn replace_all(
    connection: &mut Connection,
    characters: Vec<Value>,
    situations: Vec<Value>,
    rooms: Vec<Value>,
    messages: Vec<Value>,
    memories: Vec<Value>,
    usage_records: Vec<Value>,
    current_room_id: Option<String>,
) -> AppResult<()> {
    let transaction = connection.transaction()?;
    clear_data_tables(&transaction)?;
    write(
        &transaction,
        characters,
        situations,
        rooms,
        messages,
        memories,
        usage_records,
    )?;
    let current_room_exists = current_room_id
        .as_deref()
        .map(|room_id| {
            transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM rooms WHERE id = ?1)",
                params![room_id],
                |row| row.get::<_, bool>(0),
            )
        })
        .transpose()?
        .unwrap_or(false);
    let current_room = if current_room_exists {
        current_room_id
    } else {
        None
    };
    let value_json = serde_json::to_string(&current_room)?;
    transaction.execute(
        "INSERT INTO meta(key, value_json) VALUES ('currentRoomId', ?1)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        params![value_json],
    )?;
    transaction.commit()?;
    Ok(())
}

fn clear_data_tables(transaction: &Transaction<'_>) -> AppResult<()> {
    transaction.execute("DELETE FROM usage_records", [])?;
    transaction.execute("DELETE FROM memories", [])?;
    transaction.execute("DELETE FROM messages", [])?;
    transaction.execute("DELETE FROM rooms", [])?;
    transaction.execute("DELETE FROM situations", [])?;
    transaction.execute("DELETE FROM characters", [])?;
    transaction.execute("DELETE FROM image_assets", [])?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn write(
    transaction: &Transaction<'_>,
    characters: Vec<Value>,
    situations: Vec<Value>,
    rooms: Vec<Value>,
    messages: Vec<Value>,
    memories: Vec<Value>,
    usage_records: Vec<Value>,
) -> AppResult<()> {
    for character in characters {
        upsert_character(transaction, character)?;
    }
    for situation in situations {
        upsert_situation(transaction, situation)?;
    }
    for room in rooms {
        upsert_room(transaction, room)?;
    }
    for message in messages {
        let room_id = required_string(&message, "roomId")?;
        upsert_message(transaction, &room_id, message)?;
    }
    for memory in memories {
        upsert_memory(transaction, memory)?;
    }
    for usage_record in usage_records {
        upsert_usage_record(transaction, usage_record)?;
    }
    prune_orphaned_image_assets(transaction)
}
