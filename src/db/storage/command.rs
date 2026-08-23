use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;

use crate::error::AppResult;

use super::{bulk, characters, json::now_millis, memories, messages, meta, rooms, usage};

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
    GetCharacterWithImages {
        character_id: String,
    },
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
    GetAllSituationsWithImages,
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
    ClearAllConversationHistory,

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
    ResetAll,
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

impl StorageCommand {
    pub(super) fn kind(&self) -> &'static str {
        match self {
            Self::GetMeta { .. } => "get_meta",
            Self::SetMeta { .. } => "set_meta",
            Self::DeleteMeta { .. } => "delete_meta",
            Self::GetAllCharacters => "get_all_characters",
            Self::GetAllCharactersWithImages => "get_all_characters_with_images",
            Self::GetCharacterWithImages { .. } => "get_character_with_images",
            Self::PutCharacter { .. } => "put_character",
            Self::DeleteCharacter { .. } => "delete_character",
            Self::GetAllSituations => "get_all_situations",
            Self::GetAllSituationsWithImages => "get_all_situations_with_images",
            Self::PutSituation { .. } => "put_situation",
            Self::DeleteSituation { .. } => "delete_situation",
            Self::GetAllRooms => "get_all_rooms",
            Self::PutRoom { .. } => "put_room",
            Self::PutRoomAndMessage { .. } => "put_room_and_message",
            Self::DeleteRoom { .. } => "delete_room",
            Self::DeleteRoomHistory { .. } => "delete_room_history",
            Self::GetAllMessages => "get_all_messages",
            Self::GetMessagesByRoom { .. } => "get_messages_by_room",
            Self::PutMessage { .. } => "put_message",
            Self::PutMessages { .. } => "put_messages",
            Self::DeleteMessage { .. } => "delete_message",
            Self::DeleteMessagesByIds { .. } => "delete_messages_by_ids",
            Self::DoMessagesExist { .. } => "do_messages_exist",
            Self::ClearMessagesByRoom { .. } => "clear_messages_by_room",
            Self::ClearAllConversationHistory => "clear_all_conversation_history",
            Self::GetAllMemories => "get_all_memories",
            Self::GetMemory { .. } => "get_memory",
            Self::GetMemoriesBySourceMessageIds { .. } => "get_memories_by_source_message_ids",
            Self::GetMemoriesByCharacter { .. } => "get_memories_by_character",
            Self::GetSearchableMemories { .. } => "get_searchable_memories",
            Self::PutMemory { .. } => "put_memory",
            Self::PutMemories { .. } => "put_memories",
            Self::DeleteMemory { .. } => "delete_memory",
            Self::DeleteMemories { .. } => "delete_memories",
            Self::RemoveMemoryContentsFromMessages { .. } => "remove_memory_contents_from_messages",
            Self::DeleteMemoriesByCharacter { .. } => "delete_memories_by_character",
            Self::DeleteMemoriesByCharacterAndContent { .. } => {
                "delete_memories_by_character_and_content"
            }
            Self::DeleteMemoriesBySourceMessageIds { .. } => {
                "delete_memories_by_source_message_ids"
            }
            Self::TouchMemories { .. } => "touch_memories",
            Self::GetAllUsageRecords => "get_all_usage_records",
            Self::PutUsageRecord { .. } => "put_usage_record",
            Self::DeleteUsageRecordsOlderThan { .. } => "delete_usage_records_older_than",
            Self::ClearAll => "clear_all",
            Self::ResetAll => "reset_all",
            Self::BulkWrite { .. } => "bulk_write",
            Self::ReplaceAll { .. } => "replace_all",
        }
    }
}

pub(super) fn execute(connection: &mut Connection, command: StorageCommand) -> AppResult<Value> {
    match command {
        StorageCommand::GetMeta { key } => meta::get(connection, &key),
        StorageCommand::SetMeta { key, value } => {
            meta::set(connection, &key, &value)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMeta { key } => {
            meta::delete(connection, &key)?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllCharacters => {
            characters::get_all_characters(connection, false).map(Value::Array)
        }
        StorageCommand::GetAllCharactersWithImages => {
            characters::get_all_characters(connection, true).map(Value::Array)
        }
        StorageCommand::GetCharacterWithImages { character_id } => {
            characters::get_character_with_images(connection, &character_id)
                .map(|character| character.unwrap_or(Value::Null))
        }
        StorageCommand::PutCharacter { character } => {
            characters::put_character(connection, character)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteCharacter { character_id } => {
            characters::delete_character(connection, &character_id)?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllSituations => {
            characters::get_all_situations(connection, false).map(Value::Array)
        }
        StorageCommand::GetAllSituationsWithImages => {
            characters::get_all_situations(connection, true).map(Value::Array)
        }
        StorageCommand::PutSituation { situation } => {
            characters::put_situation(connection, situation)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteSituation { situation_id } => {
            characters::delete_situation(connection, &situation_id)?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllRooms => rooms::get_all(connection).map(Value::Array),
        StorageCommand::PutRoom { room } => {
            rooms::put(connection, room)?;
            Ok(Value::Null)
        }
        StorageCommand::PutRoomAndMessage { room, message } => {
            rooms::put_with_message(connection, room, message)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteRoom { room_id } => {
            rooms::delete(connection, &room_id)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteRoomHistory { room_id } => {
            rooms::delete_history(connection, &room_id)?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllMessages => messages::get_all(connection).map(Value::Array),
        StorageCommand::GetMessagesByRoom { room_id } => {
            messages::get_by_room(connection, &room_id).map(Value::Array)
        }
        StorageCommand::PutMessage { room_id, message } => {
            messages::put(connection, &room_id, message)?;
            Ok(Value::Null)
        }
        StorageCommand::PutMessages { room_id, messages } => {
            messages::put_many(connection, &room_id, messages)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMessage { message_id } => {
            messages::delete(connection, &message_id)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMessagesByIds { message_ids } => {
            messages::delete_many(connection, message_ids)?;
            Ok(Value::Null)
        }
        StorageCommand::DoMessagesExist { message_ids } => {
            messages::all_exist(connection, message_ids).map(Value::Bool)
        }
        StorageCommand::ClearMessagesByRoom { room_id } => {
            messages::clear_by_room(connection, &room_id)?;
            Ok(Value::Null)
        }
        StorageCommand::ClearAllConversationHistory => {
            rooms::clear_all_history(connection)?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllMemories => memories::get_all(connection).map(Value::Array),
        StorageCommand::GetMemory { memory_id } => {
            memories::get(connection, &memory_id).map(|value| value.unwrap_or(Value::Null))
        }
        StorageCommand::GetMemoriesBySourceMessageIds { message_ids } => {
            memories::get_by_source_message_ids(connection, &message_ids).map(Value::Array)
        }
        StorageCommand::GetMemoriesByCharacter { character_id } => {
            memories::get_by_character(connection, &character_id).map(Value::Array)
        }
        StorageCommand::GetSearchableMemories {
            character_id,
            room_id,
            recent_message_ids,
        } => memories::get_searchable(
            connection,
            &character_id,
            room_id.as_deref(),
            &recent_message_ids,
        )
        .map(Value::Array),
        StorageCommand::PutMemory { memory } => {
            memories::put(connection, memory)?;
            Ok(Value::Null)
        }
        StorageCommand::PutMemories { memories } => {
            memories::put_many(connection, memories)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMemory { memory_id } => {
            memories::delete(connection, &memory_id)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMemories { memory_ids } => {
            memories::delete_many(connection, memory_ids)?;
            Ok(Value::Null)
        }
        StorageCommand::RemoveMemoryContentsFromMessages {
            character_id,
            contents,
        } => {
            memories::remove_contents_from_messages(connection, &character_id, &contents)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMemoriesByCharacter { character_id } => {
            memories::delete_by_character(connection, &character_id)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMemoriesByCharacterAndContent {
            character_id,
            contents,
        } => {
            memories::delete_by_character_and_content(connection, &character_id, &contents)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteMemoriesBySourceMessageIds { message_ids } => {
            memories::delete_by_source_message_ids(connection, &message_ids)?;
            Ok(Value::Null)
        }
        StorageCommand::TouchMemories {
            memory_ids,
            timestamp,
        } => {
            memories::touch(
                connection,
                &memory_ids,
                timestamp.unwrap_or_else(now_millis),
            )?;
            Ok(Value::Null)
        }

        StorageCommand::GetAllUsageRecords => usage::get_all(connection).map(Value::Array),
        StorageCommand::PutUsageRecord { usage_record } => {
            usage::put(connection, usage_record)?;
            Ok(Value::Null)
        }
        StorageCommand::DeleteUsageRecordsOlderThan { timestamp } => {
            usage::delete_older_than(connection, timestamp)?;
            Ok(Value::Null)
        }

        StorageCommand::ClearAll => {
            bulk::clear_all(connection, false)?;
            Ok(Value::Null)
        }
        StorageCommand::ResetAll => {
            bulk::clear_all(connection, true)?;
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
            bulk::bulk_write(
                connection,
                characters,
                situations,
                rooms,
                messages,
                memories,
                usage_records,
            )?;
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
            bulk::replace_all(
                connection,
                characters,
                situations,
                rooms,
                messages,
                memories,
                usage_records,
                current_room_id,
            )?;
            Ok(Value::Null)
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{StorageCommand, execute};
    use crate::db::storage::test_support::{open_test_database, test_room};

    #[test]
    fn command_kind_contains_only_the_operation_name() {
        let command: StorageCommand = serde_json::from_value(serde_json::json!({
            "op": "put_message",
            "room_id": "secret-room",
            "message": { "content": "must never be logged" }
        }))
        .expect("parse storage command");

        assert_eq!(command.kind(), "put_message");
        assert!(!command.kind().contains("secret"));
        assert!(!command.kind().contains("content"));
    }

    #[test]
    fn put_room_and_message_stores_first_message_with_foreign_keys_enabled() {
        let mut connection = open_test_database();

        execute(
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
    fn get_character_with_images_returns_only_the_requested_hydrated_character() {
        let mut connection = open_test_database();
        execute(
            &mut connection,
            StorageCommand::PutCharacter {
                character: json!({
                    "id": "character-1",
                    "name": "Alice",
                    "icon": "data:image/png;base64,AA==",
                    "updatedAt": 1
                }),
            },
        )
        .expect("store character image");
        execute(
            &mut connection,
            StorageCommand::PutCharacter {
                character: json!({
                    "id": "character-2",
                    "name": "Bob",
                    "updatedAt": 1
                }),
            },
        )
        .expect("store another character");

        let character = execute(
            &mut connection,
            StorageCommand::GetCharacterWithImages {
                character_id: "character-1".to_owned(),
            },
        )
        .expect("load character with images");

        assert_eq!(character["id"], "character-1");
        assert_eq!(character["icon"], "data:image/png;base64,AA==");
        assert_eq!(
            execute(
                &mut connection,
                StorageCommand::GetCharacterWithImages {
                    character_id: "missing".to_owned(),
                },
            )
            .expect("load missing character"),
            Value::Null
        );
    }

    #[test]
    fn clearing_all_conversation_history_keeps_settings_and_independent_memories() {
        let mut connection = open_test_database();

        execute(
            &mut connection,
            StorageCommand::PutCharacter {
                character: json!({
                    "id": "character-1",
                    "name": "Test character",
                    "updatedAt": 1
                }),
            },
        )
        .expect("store character");
        execute(
            &mut connection,
            StorageCommand::PutSituation {
                situation: json!({
                    "id": "situation-1",
                    "name": "Test situation",
                    "updatedAt": 1
                }),
            },
        )
        .expect("store situation");
        execute(
            &mut connection,
            StorageCommand::PutRoomAndMessage {
                room: json!({
                    "id": "room-1",
                    "characterId": "character-1",
                    "groupId": "situation-1",
                    "name": "Test room",
                    "createdAt": 1,
                    "updatedAt": 1
                }),
                message: json!({
                    "id": "message-1",
                    "role": "user",
                    "content": "hello",
                    "timestamp": 1
                }),
            },
        )
        .expect("store room history");
        execute(
            &mut connection,
            StorageCommand::PutMemory {
                memory: json!({
                    "id": "memory-linked",
                    "characterId": "character-1",
                    "roomId": "room-1",
                    "sourceRoomId": "room-1",
                    "sourceMessageIds": ["message-1"],
                    "scope": "room",
                    "kind": "fact",
                    "content": "linked memory",
                    "updatedAt": 1
                }),
            },
        )
        .expect("store linked memory");
        execute(
            &mut connection,
            StorageCommand::PutMemory {
                memory: json!({
                    "id": "memory-global",
                    "characterId": "character-1",
                    "scope": "global",
                    "kind": "fact",
                    "content": "independent memory",
                    "updatedAt": 1
                }),
            },
        )
        .expect("store independent memory");
        execute(
            &mut connection,
            StorageCommand::SetMeta {
                key: "currentRoomId".to_owned(),
                value: Value::String("room-1".to_owned()),
            },
        )
        .expect("store current room");

        execute(&mut connection, StorageCommand::ClearAllConversationHistory)
            .expect("clear conversation history");

        for table in ["rooms", "messages"] {
            let count = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count cleared rows");
            assert_eq!(count, 0, "{table} should be empty");
        }
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM characters", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count characters"),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM situations", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count situations"),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM memories WHERE id = 'memory-linked'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count linked memories"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM memories WHERE id = 'memory-global'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count independent memories"),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT value_json FROM meta WHERE key = 'currentRoomId'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("read current room"),
            "null"
        );
    }

    #[test]
    fn resetting_all_clears_every_persisted_table() {
        let mut connection = open_test_database();
        connection
            .execute_batch(
                "INSERT INTO meta(key, value_json) VALUES ('themeMode', '\"light\"');
                 INSERT INTO characters(id, updated_at, data_json)
                    VALUES ('character-1', 1, '{}');
                 INSERT INTO situations(id, updated_at, data_json)
                    VALUES ('situation-1', 1, '{}');
                 INSERT INTO rooms(id, character_id, situation_id, updated_at, data_json)
                    VALUES ('room-1', 'character-1', 'situation-1', 1, '{}');
                 INSERT INTO messages(id, room_id, timestamp, data_json)
                    VALUES ('message-1', 'room-1', 1, '{}');
                 INSERT INTO memories(id, character_id, room_id, source_room_id, scope, kind, updated_at, data_json)
                    VALUES ('memory-1', 'character-1', 'room-1', 'room-1', 'character', 'fact', 1, '{}');
                 INSERT INTO usage_records(id, character_id, timestamp, data_json)
                    VALUES ('usage-1', 'character-1', 1, '{}');
                 INSERT INTO image_assets(id, mime_type, data, created_at)
                    VALUES ('asset-1', 'image/png', X'00', 1);
                 INSERT INTO character_image_assets(character_id, asset_id)
                    VALUES ('character-1', 'asset-1');",
            )
            .expect("seed persisted data");

        execute(&mut connection, StorageCommand::ResetAll).expect("reset all persisted data");

        for table in [
            "meta",
            "characters",
            "situations",
            "rooms",
            "messages",
            "memories",
            "usage_records",
            "image_assets",
            "character_image_assets",
        ] {
            let count = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count rows after reset");
            assert_eq!(count, 0, "{table} should be empty");
        }
    }

    #[test]
    fn put_room_and_message_rolls_back_room_when_message_is_invalid() {
        let mut connection = open_test_database();

        let result = execute(
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
}
