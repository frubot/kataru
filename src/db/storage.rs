use std::{
    collections::{HashMap, HashSet},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{Json, extract::State};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use rusqlite::{Connection, OptionalExtension, Params, Transaction, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

use super::Database;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum StorageCommand {
    GetMeta {
        key: String,
    },
    SetMeta {
        key: String,
        value: Value,
    },
    DeleteMeta {
        key: String,
    },

    GetAllCharacters,
    GetAllCharactersWithImages,
    PutCharacter {
        #[serde(alias = "value")]
        character: Value,
    },
    DeleteCharacter {
        #[serde(alias = "id")]
        character_id: String,
    },

    #[serde(alias = "get_all_groups")]
    GetAllSituations,
    #[serde(alias = "put_group")]
    PutSituation {
        #[serde(alias = "group", alias = "value")]
        situation: Value,
    },
    #[serde(alias = "delete_group")]
    DeleteSituation {
        #[serde(alias = "group_id", alias = "id")]
        situation_id: String,
    },

    GetAllRooms,
    PutRoom {
        #[serde(alias = "value")]
        room: Value,
    },
    PutRoomAndMessage {
        room: Value,
        message: Value,
    },
    DeleteRoom {
        #[serde(alias = "id")]
        room_id: String,
    },
    DeleteRoomHistory {
        #[serde(alias = "id")]
        room_id: String,
    },

    GetAllMessages,
    GetMessagesByRoom {
        room_id: String,
    },
    PutMessage {
        room_id: String,
        #[serde(alias = "value")]
        message: Value,
    },
    PutMessages {
        room_id: String,
        messages: Vec<Value>,
    },
    DeleteMessage {
        #[serde(alias = "id")]
        message_id: String,
    },
    DeleteMessagesByIds {
        #[serde(alias = "ids")]
        message_ids: Vec<String>,
    },
    DoMessagesExist {
        #[serde(alias = "ids")]
        message_ids: Vec<String>,
    },
    ClearMessagesByRoom {
        room_id: String,
    },
    ClearAllMessagesAndPutRooms {
        rooms: Vec<Value>,
    },

    GetAllMemories,
    GetMemory {
        #[serde(alias = "id")]
        memory_id: String,
    },
    GetMemoriesBySourceMessageIds {
        #[serde(alias = "ids")]
        message_ids: Vec<String>,
    },
    GetMemoriesByCharacter {
        character_id: String,
    },
    GetSearchableMemories {
        character_id: String,
        #[serde(default)]
        room_id: Option<String>,
        #[serde(default)]
        recent_message_ids: Vec<String>,
    },
    PutMemory {
        #[serde(alias = "value")]
        memory: Value,
    },
    PutMemories {
        memories: Vec<Value>,
    },
    DeleteMemory {
        #[serde(alias = "id")]
        memory_id: String,
    },
    DeleteMemories {
        #[serde(alias = "ids")]
        memory_ids: Vec<String>,
    },
    RemoveMemoryContentsFromMessages {
        character_id: String,
        contents: Vec<String>,
    },
    DeleteMemoriesByCharacter {
        character_id: String,
    },
    DeleteMemoriesByCharacterAndContent {
        character_id: String,
        contents: Vec<String>,
    },
    DeleteMemoriesBySourceMessageIds {
        #[serde(alias = "ids")]
        message_ids: Vec<String>,
    },
    TouchMemories {
        #[serde(alias = "ids")]
        memory_ids: Vec<String>,
        #[serde(default)]
        timestamp: Option<i64>,
    },

    GetAllUsageRecords,
    PutUsageRecord {
        #[serde(alias = "record", alias = "value")]
        usage_record: Value,
    },
    DeleteUsageRecordsOlderThan {
        #[serde(alias = "ts")]
        timestamp: i64,
    },

    ClearAll,
    BulkWrite {
        #[serde(default)]
        characters: Vec<Value>,
        #[serde(default, alias = "groups")]
        situations: Vec<Value>,
        #[serde(default)]
        rooms: Vec<Value>,
        #[serde(default)]
        messages: Vec<Value>,
        #[serde(default)]
        memories: Vec<Value>,
        #[serde(default)]
        usage_records: Vec<Value>,
    },
    ReplaceAll {
        #[serde(default)]
        characters: Vec<Value>,
        #[serde(default, alias = "groups")]
        situations: Vec<Value>,
        #[serde(default)]
        rooms: Vec<Value>,
        #[serde(default)]
        messages: Vec<Value>,
        #[serde(default)]
        memories: Vec<Value>,
        #[serde(default)]
        usage_records: Vec<Value>,
        #[serde(default)]
        current_room_id: Option<String>,
    },
}

pub async fn handle_storage_command(
    State(state): State<crate::AppState>,
    Json(command): Json<StorageCommand>,
) -> AppResult<Json<Value>> {
    let database: Database = state.database.clone();
    let result = database
        .call(move |connection| execute_command(connection, command))
        .await?;
    Ok(Json(json!({ "result": result })))
}

pub async fn persist_conversation_submission(
    database: &Database,
    payload: &Value,
    secret_mode: bool,
) -> AppResult<()> {
    if secret_mode {
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
    let messages = result
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
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
                    let existing = get_messages_by_room(&transaction, &room_id)?;
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
                        Value::String(conversation_preview(&content)),
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

fn execute_command(connection: &mut Connection, command: StorageCommand) -> AppResult<Value> {
    match command {
        StorageCommand::GetMeta { key } => {
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
        StorageCommand::SetMeta { key, value } => {
            let value_json = serde_json::to_string(&value)?;
            connection.execute(
                "INSERT INTO meta(key, value_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                params![key, value_json],
            )?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMeta { key } => {
            connection.execute("DELETE FROM meta WHERE key = ?1", params![key])?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllCharacters => query_json_values(
            connection,
            "SELECT data_json FROM characters ORDER BY id",
            [],
        )
        .map(Value::Array),
        StorageCommand::GetAllCharactersWithImages => {
            let mut characters = query_json_values(
                connection,
                "SELECT data_json FROM characters ORDER BY id",
                [],
            )?;
            for character in &mut characters {
                inline_character_images(connection, character)?;
            }
            Ok(Value::Array(characters))
        }
        StorageCommand::PutCharacter { character } => {
            let transaction = connection.transaction()?;
            upsert_character(&transaction, character)?;
            prune_orphaned_image_assets(&transaction)?;
            transaction.commit()?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteCharacter { character_id } => {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM memories WHERE character_id = ?1",
                params![character_id],
            )?;
            transaction.execute(
                "DELETE FROM characters WHERE id = ?1",
                params![character_id],
            )?;
            prune_orphaned_image_assets(&transaction)?;
            transaction.commit()?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllSituations => query_json_values(
            connection,
            "SELECT data_json FROM situations ORDER BY id",
            [],
        )
        .map(Value::Array),
        StorageCommand::PutSituation { situation } => {
            upsert_situation(connection, situation)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteSituation { situation_id } => {
            connection.execute(
                "DELETE FROM situations WHERE id = ?1",
                params![situation_id],
            )?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllRooms => {
            query_json_values(connection, "SELECT data_json FROM rooms ORDER BY id", [])
                .map(Value::Array)
        }
        StorageCommand::PutRoom { room } => {
            upsert_room(connection, room)?;
            Ok(Value::Null)
        }
        StorageCommand::PutRoomAndMessage { room, message } => {
            let room_id = required_string(&room, "id")?;
            let transaction = connection.transaction()?;
            if !upsert_room(&transaction, room)? {
                return Err(AppError::BadRequest(
                    "一時ルームにはメッセージを保存できません。".to_owned(),
                ));
            }
            upsert_message(&transaction, &room_id, message)?;
            transaction.commit()?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteRoom { room_id } => {
            delete_room(connection, &room_id)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteRoomHistory { room_id } => {
            let transaction = connection.transaction()?;
            transaction.execute("DELETE FROM rooms WHERE id = ?1", params![room_id])?;
            transaction.commit()?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllMessages => query_json_values(
            connection,
            "SELECT data_json FROM messages ORDER BY room_id, timestamp, id",
            [],
        )
        .map(Value::Array),
        StorageCommand::GetMessagesByRoom { room_id } => {
            get_messages_by_room(connection, &room_id).map(Value::Array)
        }
        StorageCommand::PutMessage { room_id, message } => {
            upsert_message(connection, &room_id, message)?;
            Ok(Value::Null)
        }
        StorageCommand::PutMessages { room_id, messages } => {
            let transaction = connection.transaction()?;
            for message in messages {
                upsert_message(&transaction, &room_id, message)?;
            }
            transaction.commit()?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMessage { message_id } => {
            connection.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMessagesByIds { message_ids } => {
            let transaction = connection.transaction()?;
            for message_id in unique_strings(message_ids) {
                transaction.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
            }
            transaction.commit()?;
            Ok(Value::Null)
        }
        StorageCommand::DoMessagesExist { message_ids } => {
            let mut all_exist = true;
            for message_id in unique_strings(message_ids) {
                let exists = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM messages WHERE id = ?1)",
                    params![message_id],
                    |row| row.get::<_, bool>(0),
                )?;
                if !exists {
                    all_exist = false;
                    break;
                }
            }
            Ok(Value::Bool(all_exist))
        }
        StorageCommand::ClearMessagesByRoom { room_id } => {
            connection.execute("DELETE FROM messages WHERE room_id = ?1", params![room_id])?;
            Ok(Value::Null)
        }
        StorageCommand::ClearAllMessagesAndPutRooms { rooms } => {
            let transaction = connection.transaction()?;
            transaction.execute("DELETE FROM messages", [])?;
            for room in rooms {
                upsert_room(&transaction, room)?;
            }
            transaction.commit()?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllMemories => {
            query_json_values(connection, "SELECT data_json FROM memories ORDER BY id", [])
                .map(Value::Array)
        }
        StorageCommand::GetMemory { memory_id } => query_optional_json(
            connection,
            "SELECT data_json FROM memories WHERE id = ?1",
            params![memory_id],
        )
        .map(|value| value.unwrap_or(Value::Null)),
        StorageCommand::GetMemoriesBySourceMessageIds { message_ids } => {
            get_memories_by_source_message_ids(connection, &message_ids).map(Value::Array)
        }
        StorageCommand::GetMemoriesByCharacter { character_id } => query_json_values(
            connection,
            "SELECT data_json FROM memories
             WHERE character_id = ?1 ORDER BY updated_at DESC, id",
            params![character_id],
        )
        .map(Value::Array),
        StorageCommand::GetSearchableMemories {
            character_id,
            room_id,
            recent_message_ids,
        } => get_searchable_memories(
            connection,
            &character_id,
            room_id.as_deref(),
            &recent_message_ids,
        )
        .map(Value::Array),
        StorageCommand::PutMemory { memory } => {
            upsert_memory(connection, memory)?;
            Ok(Value::Null)
        }
        StorageCommand::PutMemories { memories } => {
            let transaction = connection.transaction()?;
            for memory in memories {
                upsert_memory(&transaction, memory)?;
            }
            transaction.commit()?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMemory { memory_id } => {
            connection.execute("DELETE FROM memories WHERE id = ?1", params![memory_id])?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMemories { memory_ids } => {
            let transaction = connection.transaction()?;
            for memory_id in unique_strings(memory_ids) {
                transaction.execute("DELETE FROM memories WHERE id = ?1", params![memory_id])?;
            }
            transaction.commit()?;
            Ok(Value::Null)
        }
        StorageCommand::RemoveMemoryContentsFromMessages {
            character_id,
            contents,
        } => {
            remove_memory_contents_from_messages(connection, &character_id, &contents)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMemoriesByCharacter { character_id } => {
            connection.execute(
                "DELETE FROM memories WHERE character_id = ?1",
                params![character_id],
            )?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMemoriesByCharacterAndContent {
            character_id,
            contents,
        } => {
            delete_memories_by_character_and_content(connection, &character_id, &contents)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMemoriesBySourceMessageIds { message_ids } => {
            delete_memories_by_source_message_ids(connection, &message_ids)?;
            Ok(Value::Null)
        }
        StorageCommand::TouchMemories {
            memory_ids,
            timestamp,
        } => {
            touch_memories(
                connection,
                &memory_ids,
                timestamp.unwrap_or_else(now_millis),
            )?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllUsageRecords => query_json_values(
            connection,
            "SELECT data_json FROM usage_records ORDER BY id",
            [],
        )
        .map(Value::Array),
        StorageCommand::PutUsageRecord { usage_record } => {
            upsert_usage_record(connection, usage_record)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteUsageRecordsOlderThan { timestamp } => {
            connection.execute(
                "DELETE FROM usage_records WHERE timestamp < ?1",
                params![timestamp],
            )?;
            Ok(Value::Null)
        }

        StorageCommand::ClearAll => {
            let transaction = connection.transaction()?;
            clear_data_tables(&transaction)?;
            transaction.commit()?;
            Ok(Value::Null)
        }
        StorageCommand::BulkWrite {
            characters,
            situations,
            rooms,
            messages,
            memories,
            usage_records,
        } => {
            let transaction = connection.transaction()?;
            write_bulk(
                &transaction,
                characters,
                situations,
                rooms,
                messages,
                memories,
                usage_records,
            )?;
            transaction.commit()?;
            Ok(Value::Null)
        }
        StorageCommand::ReplaceAll {
            characters,
            situations,
            rooms,
            messages,
            memories,
            usage_records,
            current_room_id,
        } => {
            let transaction = connection.transaction()?;
            clear_data_tables(&transaction)?;
            write_bulk(
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
            Ok(Value::Null)
        }
    }
}

fn query_json_values<P: Params>(
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

fn query_optional_json<P: Params>(
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

fn required_object(value: &Value) -> AppResult<&Map<String, Value>> {
    value.as_object().ok_or_else(|| {
        AppError::BadRequest("保存データはJSONオブジェクトである必要があります。".to_owned())
    })
}

fn required_string(value: &Value, key: &str) -> AppResult<String> {
    required_object(value)?
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::BadRequest(format!("保存データの `{key}` が不正です。")))
}

fn optional_string(value: &Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn required_i64(value: &Value, key: &str) -> AppResult<i64> {
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

fn serialize(value: &Value) -> AppResult<String> {
    serde_json::to_string(value).map_err(AppError::from)
}

const IMAGE_ASSET_PREFIX: &str = "asset:";

fn image_asset_id(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_image_data_url(source: &str) -> AppResult<Option<(String, Vec<u8>)>> {
    let Some(rest) = source.strip_prefix("data:") else {
        return Ok(None);
    };
    let Some((metadata, encoded)) = rest.split_once(',') else {
        return Err(AppError::BadRequest(
            "画像data URLの形式が不正です。".to_owned(),
        ));
    };
    let Some(mime_type) = metadata.strip_suffix(";base64") else {
        return Err(AppError::BadRequest(
            "画像data URLはbase64形式である必要があります。".to_owned(),
        ));
    };
    if !mime_type.starts_with("image/") {
        return Ok(None);
    }
    let data = BASE64
        .decode(encoded)
        .map_err(|_| AppError::BadRequest("画像data URLをデコードできません。".to_owned()))?;
    if data.is_empty() {
        return Err(AppError::BadRequest(
            "空の画像は保存できません。".to_owned(),
        ));
    }
    Ok(Some((mime_type.to_owned(), data)))
}

fn persist_image_source(
    connection: &Connection,
    source: &mut Value,
    referenced_assets: &mut HashSet<String>,
) -> AppResult<bool> {
    let Some(source_text) = source.as_str().map(str::to_owned) else {
        return Ok(false);
    };
    if let Some(asset_id) = source_text.strip_prefix(IMAGE_ASSET_PREFIX) {
        let exists = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM image_assets WHERE id = ?1)",
            params![asset_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Err(AppError::BadRequest(
                "参照された保存画像が見つかりません。".to_owned(),
            ));
        }
        referenced_assets.insert(asset_id.to_owned());
        return Ok(false);
    }
    let Some((mime_type, data)) = decode_image_data_url(&source_text)? else {
        return Ok(false);
    };
    let asset_id = image_asset_id(&data);
    connection.execute(
        "INSERT INTO image_assets(id, mime_type, data, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO NOTHING",
        params![asset_id, mime_type, data, now_millis()],
    )?;
    referenced_assets.insert(asset_id.clone());
    *source = Value::String(format!("{IMAGE_ASSET_PREFIX}{asset_id}"));
    Ok(true)
}

fn persist_image_field(
    connection: &Connection,
    object: &mut Map<String, Value>,
    key: &str,
    referenced_assets: &mut HashSet<String>,
) -> AppResult<bool> {
    let Some(source) = object.get_mut(key) else {
        return Ok(false);
    };
    persist_image_source(connection, source, referenced_assets)
}

fn persist_expression_images(
    connection: &Connection,
    expressions: &mut Value,
    referenced_assets: &mut HashSet<String>,
) -> AppResult<bool> {
    let Some(expressions) = expressions.as_array_mut() else {
        return Ok(false);
    };
    let mut changed = false;
    for expression in expressions {
        if let Some(object) = expression.as_object_mut() {
            changed |= persist_image_field(connection, object, "image", referenced_assets)?;
        }
    }
    Ok(changed)
}

fn externalize_character_images(
    connection: &Connection,
    character: &mut Value,
) -> AppResult<(HashSet<String>, bool)> {
    let object = character.as_object_mut().ok_or_else(|| {
        AppError::BadRequest("キャラクターはJSONオブジェクトである必要があります。".to_owned())
    })?;
    let mut referenced_assets = HashSet::new();
    let mut changed = persist_image_field(connection, object, "icon", &mut referenced_assets)?;
    if let Some(expressions) = object.get_mut("expressions") {
        changed |= persist_expression_images(connection, expressions, &mut referenced_assets)?;
    }
    if let Some(costumes) = object.get_mut("costumes").and_then(Value::as_array_mut) {
        for costume in costumes {
            let Some(costume) = costume.as_object_mut() else {
                continue;
            };
            changed |= persist_image_field(connection, costume, "image", &mut referenced_assets)?;
            if let Some(expressions) = costume.get_mut("expressions") {
                changed |=
                    persist_expression_images(connection, expressions, &mut referenced_assets)?;
            }
        }
    }
    Ok((referenced_assets, changed))
}

fn sync_character_image_assets(
    connection: &Connection,
    character_id: &str,
    asset_ids: &HashSet<String>,
) -> AppResult<()> {
    connection.execute(
        "DELETE FROM character_image_assets WHERE character_id = ?1",
        params![character_id],
    )?;
    for asset_id in asset_ids {
        connection.execute(
            "INSERT INTO character_image_assets(character_id, asset_id) VALUES (?1, ?2)",
            params![character_id, asset_id],
        )?;
    }
    Ok(())
}

fn prune_orphaned_image_assets(connection: &Connection) -> AppResult<()> {
    connection.execute(
        "DELETE FROM image_assets
         WHERE NOT EXISTS (
             SELECT 1 FROM character_image_assets
             WHERE character_image_assets.asset_id = image_assets.id
         )",
        [],
    )?;
    Ok(())
}

fn inline_image_source(connection: &Connection, source: &mut Value) -> AppResult<()> {
    let Some(source_text) = source.as_str() else {
        return Ok(());
    };
    let Some(asset_id) = source_text.strip_prefix(IMAGE_ASSET_PREFIX) else {
        return Ok(());
    };
    let (mime_type, data) = connection
        .query_row(
            "SELECT mime_type, data FROM image_assets WHERE id = ?1",
            params![asset_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::Internal("保存画像の参照が壊れています。".to_owned()))?;
    *source = Value::String(format!("data:{mime_type};base64,{}", BASE64.encode(data)));
    Ok(())
}

fn inline_expression_images(connection: &Connection, expressions: &mut Value) -> AppResult<()> {
    let Some(expressions) = expressions.as_array_mut() else {
        return Ok(());
    };
    for expression in expressions {
        if let Some(source) = expression
            .as_object_mut()
            .and_then(|object| object.get_mut("image"))
        {
            inline_image_source(connection, source)?;
        }
    }
    Ok(())
}

fn inline_character_images(connection: &Connection, character: &mut Value) -> AppResult<()> {
    let Some(object) = character.as_object_mut() else {
        return Ok(());
    };
    if let Some(icon) = object.get_mut("icon") {
        inline_image_source(connection, icon)?;
    }
    if let Some(expressions) = object.get_mut("expressions") {
        inline_expression_images(connection, expressions)?;
    }
    if let Some(costumes) = object.get_mut("costumes").and_then(Value::as_array_mut) {
        for costume in costumes {
            let Some(costume) = costume.as_object_mut() else {
                continue;
            };
            if let Some(image) = costume.get_mut("image") {
                inline_image_source(connection, image)?;
            }
            if let Some(expressions) = costume.get_mut("expressions") {
                inline_expression_images(connection, expressions)?;
            }
        }
    }
    Ok(())
}

pub fn migrate_character_images(transaction: &Transaction<'_>) -> AppResult<()> {
    let stored_characters = {
        let mut statement =
            transaction.prepare("SELECT id, data_json FROM characters ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut characters = Vec::new();
        for row in rows {
            characters.push(row?);
        }
        characters
    };

    for (character_id, data_json) in stored_characters {
        let mut character: Value = serde_json::from_str(&data_json)?;
        let (asset_ids, changed) = externalize_character_images(transaction, &mut character)?;
        if changed {
            transaction.execute(
                "UPDATE characters SET data_json = ?2 WHERE id = ?1",
                params![character_id, serialize(&character)?],
            )?;
        }
        sync_character_image_assets(transaction, &character_id, &asset_ids)?;
    }
    prune_orphaned_image_assets(transaction)
}

fn upsert_character(connection: &Transaction<'_>, mut character: Value) -> AppResult<()> {
    let id = required_string(&character, "id")?;
    let updated_at = required_i64(&character, "updatedAt")?;
    let (asset_ids, _) = externalize_character_images(connection, &mut character)?;
    connection.execute(
        "INSERT INTO characters(id, updated_at, data_json) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
             updated_at = excluded.updated_at,
             data_json = excluded.data_json",
        params![id, updated_at, serialize(&character)?],
    )?;
    sync_character_image_assets(connection, &id, &asset_ids)?;
    Ok(())
}

fn upsert_situation(connection: &Connection, situation: Value) -> AppResult<()> {
    let id = required_string(&situation, "id")?;
    let updated_at = required_i64(&situation, "updatedAt")?;
    connection.execute(
        "INSERT INTO situations(id, updated_at, data_json) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
             updated_at = excluded.updated_at,
             data_json = excluded.data_json",
        params![id, updated_at, serialize(&situation)?],
    )?;
    Ok(())
}

fn persistent_room(mut room: Value) -> AppResult<Option<Value>> {
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

fn upsert_room(connection: &Connection, room: Value) -> AppResult<bool> {
    let Some(room) = persistent_room(room)? else {
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

fn stored_message(room_id: &str, mut message: Value) -> AppResult<Value> {
    let object = message.as_object_mut().ok_or_else(|| {
        AppError::BadRequest("メッセージはJSONオブジェクトである必要があります。".to_owned())
    })?;
    object.insert("roomId".to_owned(), Value::String(room_id.to_owned()));
    Ok(message)
}

fn upsert_message(connection: &Connection, room_id: &str, message: Value) -> AppResult<()> {
    let message = stored_message(room_id, message)?;
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

fn upsert_memory(connection: &Connection, memory: Value) -> AppResult<()> {
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

fn upsert_usage_record(connection: &Connection, usage_record: Value) -> AppResult<()> {
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

fn get_messages_by_room(connection: &Connection, room_id: &str) -> AppResult<Vec<Value>> {
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

fn delete_room(connection: &mut Connection, room_id: &str) -> AppResult<()> {
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

    transaction.execute("DELETE FROM rooms WHERE id = ?1", params![room_id])?;
    let memories = query_json_values(
        &transaction,
        "SELECT data_json FROM memories ORDER BY id",
        [],
    )?;
    for mut memory in memories {
        let source_message_ids = string_array(&memory, "sourceMessageIds");
        let remaining_source_message_ids: Vec<String> = source_message_ids
            .iter()
            .filter(|message_id| !deleted_message_ids.contains(*message_id))
            .cloned()
            .collect();
        let has_deleted_source = remaining_source_message_ids.len() != source_message_ids.len();
        let is_room_scoped = optional_string(&memory, &["roomId"]).as_deref() == Some(room_id);
        let source_room_is_deleted =
            optional_string(&memory, &["sourceRoomId"]).as_deref() == Some(room_id);
        let has_only_deleted_room_sources =
            source_room_is_deleted && remaining_source_message_ids.is_empty();
        let has_only_deleted_message_sources =
            has_deleted_source && remaining_source_message_ids.is_empty();
        let memory_id = required_string(&memory, "id")?;

        if is_room_scoped || has_only_deleted_room_sources || has_only_deleted_message_sources {
            transaction.execute("DELETE FROM memories WHERE id = ?1", params![memory_id])?;
        } else if source_room_is_deleted || has_deleted_source {
            let source_room_id =
                first_message_room_id(&transaction, &remaining_source_message_ids)?;
            update_memory_sources(
                &transaction,
                &mut memory,
                remaining_source_message_ids,
                source_room_id,
                false,
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

fn get_memories_by_source_message_ids(
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
    let memories = query_json_values(connection, "SELECT data_json FROM memories ORDER BY id", [])?;
    Ok(memories
        .into_iter()
        .filter(|memory| {
            string_array(memory, "sourceMessageIds")
                .iter()
                .any(|message_id| targets.contains(message_id.as_str()))
        })
        .collect())
}

fn get_searchable_memories(
    connection: &Connection,
    character_id: &str,
    room_id: Option<&str>,
    recent_message_ids: &[String],
) -> AppResult<Vec<Value>> {
    let memories = query_json_values(
        connection,
        "SELECT data_json FROM memories
         WHERE character_id = ?1 ORDER BY updated_at DESC, id",
        params![character_id],
    )?;
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

fn remove_memory_contents_from_messages(
    connection: &mut Connection,
    character_id: &str,
    contents: &[String],
) -> AppResult<()> {
    let normalized_contents: HashSet<String> = contents
        .iter()
        .map(|content| normalize_memory_content(content))
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
            .filter(|memory| !normalized_contents.contains(&normalize_memory_content(memory)))
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

fn delete_memories_by_character_and_content(
    connection: &mut Connection,
    character_id: &str,
    contents: &[String],
) -> AppResult<()> {
    let normalized_contents: HashSet<String> = contents
        .iter()
        .map(|content| normalize_memory_content(content))
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
        if normalized_contents.contains(&normalize_memory_content(&content)) {
            transaction.execute(
                "DELETE FROM memories WHERE id = ?1",
                params![required_string(&memory, "id")?],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

fn delete_memories_by_source_message_ids(
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
    let memories = query_json_values(
        &transaction,
        "SELECT data_json FROM memories ORDER BY id",
        [],
    )?;
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
            update_memory_sources(
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

fn update_memory_sources(
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

fn touch_memories(
    connection: &mut Connection,
    memory_ids: &[String],
    timestamp: i64,
) -> AppResult<()> {
    let transaction = connection.transaction()?;
    for memory_id in unique_string_refs(memory_ids) {
        let Some(mut memory) = query_optional_json(
            &transaction,
            "SELECT data_json FROM memories WHERE id = ?1",
            params![memory_id],
        )?
        else {
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
fn write_bulk(
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

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

fn unique_string_refs(values: &[String]) -> Vec<&str> {
    let mut seen = HashSet::new();
    values
        .iter()
        .map(String::as_str)
        .filter(|value| !value.is_empty() && seen.insert(*value))
        .collect()
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
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

fn is_true(value: &Value, key: &str) -> bool {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_bool)
        == Some(true)
}

fn normalize_memory_content(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn conversation_preview(content: &str) -> String {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.chars().take(50).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_database() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .pragma_update(None, "foreign_keys", true)
            .expect("enable foreign keys");
        connection
            .execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .expect("apply initial migration");
        connection
            .execute_batch(include_str!("../../migrations/0002_image_assets.sql"))
            .expect("apply image asset migration");
        connection
    }

    fn test_room(id: &str) -> Value {
        json!({
            "id": id,
            "characterId": "character-1",
            "name": "Test room",
            "createdAt": 1,
            "updatedAt": 1
        })
    }

    #[tokio::test]
    async fn background_conversation_persists_submission_and_result() {
        let database = Database::open(std::path::Path::new(":memory:"))
            .expect("open background conversation database");
        let payload = json!({
            "room": test_room("room-background"),
            "messages": [{
                "id": "message-user",
                "role": "user",
                "content": "hello",
                "timestamp": 10
            }]
        });
        persist_conversation_submission(&database, &payload, false)
            .await
            .expect("persist submitted message");

        let result = json!({
            "messages": [{
                "id": "message-assistant",
                "role": "assistant",
                "content": "saved in the background",
                "characterId": "character-1",
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
                let messages = get_messages_by_room(connection, "room-background")?;
                assert_eq!(messages.len(), 2);
                assert_eq!(messages[1]["id"], "message-assistant");
                let room = query_optional_json(
                    connection,
                    "SELECT data_json FROM rooms WHERE id = ?1",
                    params!["room-background"],
                )?
                .expect("stored room");
                assert_eq!(room["summary"], "summary");
                assert_eq!(room["lastMessagePreview"], "saved in the background");
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

    #[test]
    fn put_room_and_message_stores_first_message_with_foreign_keys_enabled() {
        let mut connection = open_test_database();

        execute_command(
            &mut connection,
            StorageCommand::PutRoomAndMessage {
                room: test_room("room-1"),
                message: json!({
                    "id": "message-1",
                    "role": "user",
                    "content": "hello",
                    "timestamp": 1
                }),
            },
        )
        .expect("store room and first message");

        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM rooms WHERE id = 'room-1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count rooms"),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM messages
                     WHERE id = 'message-1' AND room_id = 'room-1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count messages"),
            1
        );
    }

    #[test]
    fn put_room_and_message_rolls_back_room_when_message_is_invalid() {
        let mut connection = open_test_database();

        let result = execute_command(
            &mut connection,
            StorageCommand::PutRoomAndMessage {
                room: test_room("room-1"),
                message: json!({
                    "id": "message-1",
                    "role": "user",
                    "content": "missing timestamp"
                }),
            },
        );

        assert!(result.is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM rooms WHERE id = 'room-1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count rolled-back rooms"),
            0
        );
    }

    #[test]
    fn character_images_are_externalized_deduplicated_and_inlined_for_export() {
        let mut connection = open_test_database();
        let data_url = format!(
            "data:image/png;base64,{}",
            BASE64.encode(b"same-image-bytes")
        );
        let character = json!({
            "id": "character-1",
            "updatedAt": 1,
            "icon": data_url,
            "expressions": [{ "name": "neutral", "image": data_url }],
            "costumes": [{ "name": "default", "image": data_url }]
        });

        let transaction = connection.transaction().expect("start transaction");
        upsert_character(&transaction, character).expect("store character");
        prune_orphaned_image_assets(&transaction).expect("prune assets");
        transaction.commit().expect("commit character");

        let stored_json: String = connection
            .query_row(
                "SELECT data_json FROM characters WHERE id = 'character-1'",
                [],
                |row| row.get(0),
            )
            .expect("read stored character");
        assert!(!stored_json.contains("data:image"));
        assert!(stored_json.contains(IMAGE_ASSET_PREFIX));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM image_assets", [], |row| row
                    .get::<_, i64>(0))
                .expect("count image assets"),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM character_image_assets", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count character image assets"),
            1
        );

        let mut exported: Value =
            serde_json::from_str(&stored_json).expect("parse stored character");
        inline_character_images(&connection, &mut exported).expect("inline exported images");
        assert_eq!(exported["icon"], data_url);
        assert_eq!(exported["expressions"][0]["image"], data_url);
        assert_eq!(exported["costumes"][0]["image"], data_url);
    }

    #[test]
    fn replacing_character_images_prunes_unreferenced_assets() {
        let mut connection = open_test_database();
        let data_url = format!(
            "data:image/png;base64,{}",
            BASE64.encode(b"temporary-image")
        );
        let transaction = connection.transaction().expect("start first transaction");
        upsert_character(
            &transaction,
            json!({ "id": "character-1", "updatedAt": 1, "icon": data_url }),
        )
        .expect("store image");
        transaction.commit().expect("commit image");

        let transaction = connection
            .transaction()
            .expect("start replacement transaction");
        upsert_character(&transaction, json!({ "id": "character-1", "updatedAt": 2 }))
            .expect("replace character");
        prune_orphaned_image_assets(&transaction).expect("prune replaced image");
        transaction.commit().expect("commit replacement");

        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM image_assets", [], |row| row
                    .get::<_, i64>(0))
                .expect("count remaining assets"),
            0
        );
    }
}
