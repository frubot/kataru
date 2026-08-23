use rusqlite::Connection;
use serde_json::{Value, json};

pub(super) fn open_test_database() -> Connection {
    let connection = Connection::open_in_memory().expect("open in-memory database");
    connection
        .pragma_update(None, "foreign_keys", true)
        .expect("enable foreign keys");
    connection
        .execute_batch(include_str!("../../../migrations/0001_initial.sql"))
        .expect("apply initial migration");
    connection
        .execute_batch(include_str!("../../../migrations/0002_image_assets.sql"))
        .expect("apply image asset migration");
    connection
        .execute_batch(include_str!(
            "../../../migrations/0003_situation_image_assets.sql"
        ))
        .expect("apply situation image asset migration");
    connection
}

pub(super) fn test_room(id: &str) -> Value {
    json!({
        "id": id,
        "characterId": "character-1",
        "name": "Test room",
        "createdAt": 1,
        "updatedAt": 1
    })
}
