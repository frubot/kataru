use rusqlite::{Connection, params};
use serde_json::Value;

use crate::error::AppResult;

use super::json::{query_json_values, required_i64, required_string, serialize};

pub(super) fn get_all(connection: &Connection) -> AppResult<Vec<Value>> {
    query_json_values(
        connection,
        "SELECT data_json FROM usage_records ORDER BY id",
        [],
    )
}

pub(super) fn put(connection: &Connection, usage_record: Value) -> AppResult<()> {
    upsert(connection, usage_record)
}

pub(super) fn delete_older_than(connection: &Connection, timestamp: i64) -> AppResult<()> {
    connection.execute(
        "DELETE FROM usage_records WHERE timestamp < ?1",
        params![timestamp],
    )?;
    Ok(())
}

pub(super) fn upsert(connection: &Connection, usage_record: Value) -> AppResult<()> {
    let id = required_string(&usage_record, "id")?;
    let character_id = required_string(&usage_record, "characterId")?;
    let timestamp = required_i64(&usage_record, "timestamp")?;
    connection.execute(
        "INSERT INTO usage_records(id, character_id, timestamp, data_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
             character_id = excluded.character_id,
             timestamp = excluded.timestamp,
             data_json = excluded.data_json",
        params![id, character_id, timestamp, serialize(&usage_record)?],
    )?;
    Ok(())
}
