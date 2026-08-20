use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::error::{AppError, AppResult};

pub(super) fn get(connection: &Connection, key: &str) -> AppResult<Value> {
    let value_json = connection
        .query_row(
            "SELECT value_json FROM meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    value_json
        .map(|value| serde_json::from_str(&value).map_err(AppError::from))
        .transpose()
        .map(|value| value.unwrap_or(Value::Null))
}

pub(super) fn set(connection: &Connection, key: &str, value: &Value) -> AppResult<()> {
    let value_json = serde_json::to_string(value)?;
    connection.execute(
        "INSERT INTO meta(key, value_json) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        params![key, value_json],
    )?;
    Ok(())
}

pub(super) fn delete(connection: &Connection, key: &str) -> AppResult<()> {
    connection.execute("DELETE FROM meta WHERE key = ?1", params![key])?;
    Ok(())
}
