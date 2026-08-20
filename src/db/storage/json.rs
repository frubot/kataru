use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Params};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

pub(super) fn query_json_values<P: Params>(
    connection: &Connection,
    sql: &str,
    parameters: P,
) -> AppResult<Vec<Value>> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(parameters, |row| row.get::<_, String>(0))?;
    let mut values = Vec::new();
    for row in rows {
        values.push(serde_json::from_str(&row?)?);
    }
    Ok(values)
}

pub(super) fn query_optional_json<P: Params>(
    connection: &Connection,
    sql: &str,
    parameters: P,
) -> AppResult<Option<Value>> {
    let value_json = connection
        .query_row(sql, parameters, |row| row.get::<_, String>(0))
        .optional()?;
    value_json
        .map(|value| serde_json::from_str(&value).map_err(AppError::from))
        .transpose()
}

pub(super) fn required_object(value: &Value) -> AppResult<&Map<String, Value>> {
    value.as_object().ok_or_else(|| {
        AppError::BadRequest("保存データはJSONオブジェクトである必要があります。".to_owned())
    })
}

pub(super) fn required_string(value: &Value, key: &str) -> AppResult<String> {
    required_object(value)?
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::BadRequest(format!("保存データの `{key}` が不正です。")))
}

pub(super) fn optional_string(value: &Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(super) fn required_i64(value: &Value, key: &str) -> AppResult<i64> {
    let number = required_object(value)?
        .get(key)
        .ok_or_else(|| AppError::BadRequest(format!("保存データの `{key}` がありません。")))?;
    if let Some(number) = number.as_i64() {
        return Ok(number);
    }
    number
        .as_u64()
        .and_then(|number| i64::try_from(number).ok())
        .ok_or_else(|| AppError::BadRequest(format!("保存データの `{key}` が不正です。")))
}

pub(super) fn serialize(value: &Value) -> AppResult<String> {
    serde_json::to_string(value).map_err(AppError::from)
}

pub(super) fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

pub(super) fn unique_string_refs(values: &[String]) -> Vec<&str> {
    let mut seen = HashSet::new();
    values
        .iter()
        .map(String::as_str)
        .filter(|value| !value.is_empty() && seen.insert(*value))
        .collect()
}

pub(super) fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn is_true(value: &Value, key: &str) -> bool {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_bool)
        == Some(true)
}

pub(super) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
