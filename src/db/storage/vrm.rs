use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::HashSet;

use super::images::store_asset;
use crate::error::{AppError, AppResult};

const MAX_VRM_BYTES: usize = 50 * 1024 * 1024;
const VRM_MIME: &str = "model/gltf-binary";
const DATA_PREFIX: &str = "data:model/gltf-binary;base64,";

fn invalid() -> AppError {
    AppError::BadRequest(
        "VRMデータまたは表示設定が不正です。VRM 0.x / 1.0（50MB以下）を指定してください。".into(),
    )
}

fn validate_model(data: &[u8]) -> AppResult<()> {
    if data.len() < 20 || data.len() > MAX_VRM_BYTES {
        return Err(invalid());
    }
    let word = |offset| u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
    if word(0) != 0x46546c67
        || word(4) != 2
        || word(8) != data.len()
        || word(16) != 0x4e4f534a
        || word(12) > data.len() - 20
    {
        return Err(invalid());
    }
    let json: Value = serde_json::from_slice(&data[20..20 + word(12)]).map_err(|_| invalid())?;
    if !json["extensions"]["VRM"].is_object() && !json["extensions"]["VRMC_vrm"].is_object() {
        return Err(invalid());
    }
    fn has_uri(value: &Value) -> bool {
        match value {
            Value::Object(object) => object.contains_key("uri") || object.values().any(has_uri),
            Value::Array(array) => array.iter().any(has_uri),
            _ => false,
        }
    }
    if has_uri(&json) {
        return Err(AppError::BadRequest(
            "外部リソースを参照するVRMには対応していません。".into(),
        ));
    }
    Ok(())
}

pub(super) fn persist_vrm(
    connection: &Connection,
    avatar: &mut Value,
    references: &mut HashSet<String>,
) -> AppResult<bool> {
    for (key, min, max) in [
        ("scale", 0.5, 2.0),
        ("offsetY", -0.5, 0.5),
        ("rotation", -180.0, 180.0),
    ] {
        let value = avatar["framing"][key].as_f64().ok_or_else(invalid)?;
        if !value.is_finite() || value < min || value > max {
            return Err(invalid());
        }
    }
    let expressions = avatar["expressionMap"].as_object().ok_or_else(invalid)?;
    if expressions.len() > 256
        || expressions.iter().any(|(key, value)| {
            key.trim().is_empty()
                || key.len() > 256
                || value.as_str().is_none_or(|name| name.len() > 256)
        })
    {
        return Err(invalid());
    }
    let source = avatar["source"].as_str().ok_or_else(invalid)?;
    if let Some(id) = source.strip_prefix("asset:") {
        let mime: Option<String> = connection
            .query_row(
                "SELECT mime_type FROM image_assets WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        if mime.as_deref() != Some(VRM_MIME) {
            return Err(invalid());
        }
        references.insert(id.to_owned());
        return Ok(false);
    }
    let encoded = source.strip_prefix(DATA_PREFIX).ok_or_else(invalid)?;
    if encoded.len() > MAX_VRM_BYTES.div_ceil(3) * 4 {
        return Err(invalid());
    }
    let data = BASE64.decode(encoded).map_err(|_| invalid())?;
    validate_model(&data)?;
    let id = store_asset(connection, VRM_MIME, &data)?;
    references.insert(id.clone());
    avatar["source"] = Value::String(format!("asset:{id}"));
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::storage::{
        characters::{get_character_with_images, put_character, put_situation},
        test_support::open_test_database,
    };
    use serde_json::json;

    fn model_data(json: Value) -> Vec<u8> {
        let mut payload = serde_json::to_vec(&json).unwrap();
        payload.resize(payload.len().div_ceil(4) * 4, b' ');
        let mut data = Vec::new();
        for word in [
            0x46546c67,
            2,
            (20 + payload.len()) as u32,
            payload.len() as u32,
            0x4e4f534a,
        ] {
            data.extend_from_slice(&word.to_le_bytes());
        }
        data.extend(payload);
        data
    }

    fn character(source: &str, id: &str) -> Value {
        json!({ "id": id, "updatedAt": 1, "costumes": [{
            "name": "3d", "kind": "vrm", "image": "data:image/png;base64,aW1hZ2U=",
            "vrm": { "source": source, "framing": { "scale": 1, "offsetY": 0, "rotation": 0 }, "expressionMap": { "smile": "happy" } }
        }] })
    }

    #[test]
    fn vrm_assets_round_trip_and_survive_until_the_last_owner_is_removed() {
        let mut db = open_test_database();
        let data = model_data(json!({ "extensions": { "VRMC_vrm": {} } }));
        let source = format!("{DATA_PREFIX}{}", BASE64.encode(&data));
        let original = character(&source, "one");
        put_character(&mut db, original.clone()).unwrap();
        let stored_json: String = db
            .query_row(
                "SELECT data_json FROM characters WHERE id = 'one'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let stored: Value = serde_json::from_str(&stored_json).unwrap();
        let reference = stored["costumes"][0]["vrm"]["source"].as_str().unwrap();
        assert!(reference.starts_with("asset:"));
        assert!(!stored_json.contains(DATA_PREFIX));
        assert_eq!(
            get_character_with_images(&db, "one").unwrap().unwrap(),
            original
        );
        let count = |db: &Connection| {
            db.query_row(
                "SELECT COUNT(*) FROM image_assets WHERE mime_type = 'model/gltf-binary'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
        };
        put_character(&mut db, character(reference, "two")).unwrap();
        assert_eq!(count(&db), 1);
        // Temporary actors in situations also own their models.
        put_situation(
            &mut db,
            json!({ "id": "scene", "updatedAt": 1, "actors": [character(reference, "temporary")] }),
        )
        .unwrap();
        for id in ["one", "two"] {
            put_character(&mut db, json!({ "id": id, "updatedAt": 2 })).unwrap();
        }
        assert_eq!(count(&db), 1);
        put_situation(
            &mut db,
            json!({ "id": "scene", "updatedAt": 2, "actors": [] }),
        )
        .unwrap();
        assert_eq!(count(&db), 0);
    }

    #[test]
    fn rejects_external_or_invalid_vrm_without_saving_partial_assets() {
        let mut db = open_test_database();
        for data in [
            b"not a model".to_vec(),
            model_data(
                json!({ "extensions": { "VRM": {} }, "images": [{ "uri": "https://example.com/texture.png" }] }),
            ),
            model_data(json!({ "asset": { "version": "2.0" } })),
        ] {
            let source = format!("{DATA_PREFIX}{}", BASE64.encode(&data));
            assert!(put_character(&mut db, character(&source, "invalid")).is_err());
        }
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM image_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert!(validate_model(&model_data(json!({ "extensions": { "VRM": {} } }))).is_ok());
    }
}
