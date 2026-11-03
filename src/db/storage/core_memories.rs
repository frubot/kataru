use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::{
    core_memory::{
        CORE_MEMORY_MAX_CHARS_META_KEY, CoreMemory, normalize_max_chars, normalize_user_edit,
    },
    error::{AppError, AppResult},
};

use super::{Database, json::now_millis};

pub(super) fn get(connection: &Connection, character_id: &str) -> AppResult<Option<CoreMemory>> {
    let raw = connection
        .query_row(
            "SELECT data_json FROM core_memories WHERE character_id = ?1",
            params![character_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str::<CoreMemory>(&raw).map_err(AppError::from))
        .transpose()
}

pub(super) fn get_all(connection: &Connection) -> AppResult<Vec<Value>> {
    super::json::query_json_values(
        connection,
        "SELECT data_json FROM core_memories ORDER BY character_id",
        [],
    )
}

fn write(connection: &Connection, memory: &CoreMemory) -> AppResult<()> {
    connection.execute(
        "INSERT INTO core_memories(character_id, updated_at, data_json) VALUES (?1, ?2, ?3)
         ON CONFLICT(character_id) DO UPDATE SET
             updated_at = excluded.updated_at,
             data_json = excluded.data_json",
        params![
            memory.character_id,
            memory.updated_at,
            serde_json::to_string(memory)?
        ],
    )?;
    Ok(())
}

/// 画面からの保存。`expected_version` が保存済みの版と違えば保存せず、今の内容を返す。
pub(super) fn put_user_edit(
    connection: &mut Connection,
    submitted: Value,
    expected_version: i64,
) -> AppResult<Value> {
    let submitted: CoreMemory = serde_json::from_value(submitted)?;
    let transaction = connection.transaction()?;
    let previous = get(&transaction, submitted.character_id.trim())?;
    let current_version = previous.as_ref().map_or(0, |memory| memory.version);
    if current_version != expected_version {
        return Ok(json!({
            "status": "conflict",
            "coreMemory": previous,
        }));
    }
    let max_chars = max_chars(&transaction)?;
    let memory = normalize_user_edit(previous.as_ref(), submitted, now_millis(), max_chars)?;
    write(&transaction, &memory)?;
    transaction.commit()?;
    Ok(json!({
        "status": "saved",
        "coreMemory": memory,
    }))
}

/// バックアップからの復元。中身はそのまま入れる。
pub(super) fn upsert(connection: &Connection, value: Value) -> AppResult<()> {
    let memory: CoreMemory = serde_json::from_value(value)?;
    if memory.character_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "常駐記憶の characterId がありません。".to_owned(),
        ));
    }
    write(connection, &memory)
}

pub(super) fn delete(connection: &Connection, character_id: &str) -> AppResult<()> {
    connection.execute(
        "DELETE FROM core_memories WHERE character_id = ?1",
        params![character_id],
    )?;
    Ok(())
}

/// 設定された常駐記憶全体の文字数の上限。
fn max_chars(connection: &Connection) -> AppResult<usize> {
    Ok(normalize_max_chars(&super::meta::get(
        connection,
        CORE_MEMORY_MAX_CHARS_META_KEY,
    )?))
}

/// 裏の更新で使う、設定された常駐記憶全体の文字数の上限。
pub async fn get_core_memory_max_chars(database: &Database) -> AppResult<usize> {
    database.call(|connection| max_chars(connection)).await
}

/// 会話や裏の更新で使う読み込み。
pub async fn get_core_memory(
    database: &Database,
    character_id: &str,
) -> AppResult<Option<CoreMemory>> {
    let character_id = character_id.to_owned();
    database
        .call(move |connection| get(connection, &character_id))
        .await
}

/// AI の更新を保存する。読んだときから版が変わっていたら（画面で編集されたら）保存せず `false`。
pub async fn save_core_memory_if_version(
    database: &Database,
    memory: CoreMemory,
    expected_version: i64,
) -> AppResult<bool> {
    database
        .call(move |connection| {
            let transaction = connection.transaction()?;
            let current_version =
                get(&transaction, &memory.character_id)?.map_or(0, |memory| memory.version);
            if current_version != expected_version {
                return Ok(false);
            }
            write(&transaction, &memory)?;
            transaction.commit()?;
            Ok(true)
        })
        .await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::db::storage::test_support::open_test_database;

    #[test]
    fn user_edits_check_the_version() {
        let mut connection = open_test_database();
        let first = put_user_edit(
            &mut connection,
            json!({
                "characterId": "c1",
                "entries": [{"section": "user", "text": "呼び名はミナト"}],
            }),
            0,
        )
        .expect("save");
        assert_eq!(first["status"], "saved");
        assert_eq!(first["coreMemory"]["version"], 1);
        assert_eq!(first["coreMemory"]["entries"][0]["id"], "u1");

        let stale = put_user_edit(
            &mut connection,
            json!({"characterId": "c1", "entries": []}),
            0,
        )
        .expect("conflict is not an error");
        assert_eq!(stale["status"], "conflict");
        assert_eq!(stale["coreMemory"]["entries"][0]["text"], "呼び名はミナト");

        let stored = get(&connection, "c1").expect("read").expect("exists");
        assert_eq!(stored.version, 1);
        assert_eq!(stored.next_id, 2);

        delete(&connection, "c1").expect("delete");
        assert!(get(&connection, "c1").expect("read").is_none());
    }
}
