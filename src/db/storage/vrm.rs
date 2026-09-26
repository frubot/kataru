use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::HashSet;

use super::images::store_asset;
use crate::error::{AppError, AppResult};

pub(crate) const MAX_VRM_BYTES: usize = 50 * 1024 * 1024;
pub(crate) const VRM_MIME: &str = "model/gltf-binary";
const DATA_PREFIX: &str = "data:model/gltf-binary;base64,";
pub(crate) const MAX_VRMA_BYTES: usize = 20 * 1024 * 1024;
pub(crate) const VRMA_MIME: &str = "application/x-vrma";
const VRMA_DATA_PREFIX: &str = "data:application/x-vrma;base64,";
pub(crate) const MAX_VRM_ANIMATIONS: usize = 32;
const MAX_VRM_ANIMATION_NAME: usize = 64;

/// モーション名の検証。チャット契約の予約値 "none" はトリガー不能なため禁止する。
pub(crate) fn valid_motion_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.chars().count() <= MAX_VRM_ANIMATION_NAME
        && !name.trim().eq_ignore_ascii_case("none")
}

fn invalid() -> AppError {
    AppError::BadRequest(
        "VRMデータまたは表示設定が不正です。VRM 0.x / 1.0（50MB以下）を指定してください。".into(),
    )
}

fn invalid_vrma() -> AppError {
    AppError::BadRequest("モーションデータが不正です。VRMA（20MB以下）を指定してください。".into())
}

fn parse_glb_json(data: &[u8], invalid: fn() -> AppError) -> AppResult<Value> {
    if data.len() < 20 {
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
    serde_json::from_slice(&data[20..20 + word(12)]).map_err(|_| invalid())
}

fn has_uri(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.contains_key("uri") || object.values().any(has_uri),
        Value::Array(array) => array.iter().any(has_uri),
        _ => false,
    }
}

pub(crate) fn validate_model(data: &[u8]) -> AppResult<()> {
    if data.len() > MAX_VRM_BYTES {
        return Err(invalid());
    }
    let json = parse_glb_json(data, invalid)?;
    if !json["extensions"]["VRM"].is_object() && !json["extensions"]["VRMC_vrm"].is_object() {
        return Err(invalid());
    }
    if has_uri(&json) {
        return Err(AppError::BadRequest(
            "外部リソースを参照するVRMには対応していません。".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_vrma(data: &[u8]) -> AppResult<()> {
    if data.len() > MAX_VRMA_BYTES {
        return Err(invalid_vrma());
    }
    let json = parse_glb_json(data, invalid_vrma)?;
    if !json["extensions"]["VRMC_vrm_animation"].is_object() {
        return Err(invalid_vrma());
    }
    if has_uri(&json) {
        return Err(AppError::BadRequest(
            "外部リソースを参照するVRMAには対応していません。".into(),
        ));
    }
    Ok(())
}

fn asset_mime(connection: &Connection, id: &str) -> AppResult<Option<String>> {
    connection
        .query_row(
            "SELECT mime_type FROM image_assets WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn persist_model_source(
    connection: &Connection,
    avatar: &mut Value,
    references: &mut HashSet<String>,
) -> AppResult<bool> {
    let source = avatar["source"].as_str().ok_or_else(invalid)?.to_owned();
    if let Some(id) = source.strip_prefix("asset:") {
        if asset_mime(connection, id)?.as_deref() != Some(VRM_MIME) {
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

fn persist_animations(
    connection: &Connection,
    avatar: &mut Value,
    references: &mut HashSet<String>,
) -> AppResult<bool> {
    let mut changed = false;
    if let Some(animations) = avatar.get_mut("animations") {
        let animations = animations.as_array_mut().ok_or_else(invalid)?;
        if animations.len() > MAX_VRM_ANIMATIONS {
            return Err(invalid());
        }
        for animation in animations {
            if !animation.is_object() {
                return Err(invalid());
            }
            let name = animation["name"].as_str().ok_or_else(invalid)?;
            // "none" is the chat contract's reserved "no motion" value, so a
            // clip stored under it could never be triggered.
            if !valid_motion_name(name) {
                return Err(invalid());
            }
            for flag in ["loop", "useExpressions"] {
                if animation.get(flag).is_some_and(|value| !value.is_boolean()) {
                    return Err(invalid());
                }
            }
            let source = animation["source"].as_str().ok_or_else(invalid)?.to_owned();
            if let Some(id) = source.strip_prefix("asset:") {
                if asset_mime(connection, id)?.as_deref() != Some(VRMA_MIME) {
                    return Err(invalid());
                }
                references.insert(id.to_owned());
            } else {
                let encoded = source
                    .strip_prefix(VRMA_DATA_PREFIX)
                    .ok_or_else(invalid_vrma)?;
                if encoded.len() > MAX_VRMA_BYTES.div_ceil(3) * 4 {
                    return Err(invalid_vrma());
                }
                let data = BASE64.decode(encoded).map_err(|_| invalid_vrma())?;
                validate_vrma(&data)?;
                let id = store_asset(connection, VRMA_MIME, &data)?;
                references.insert(id.clone());
                animation["source"] = Value::String(format!("asset:{id}"));
                changed = true;
            }
        }
    }
    if let Some(idle) = avatar.get("idleAnimation") {
        let idle = idle.as_str().ok_or_else(invalid)?;
        let known = avatar["animations"].as_array().is_some_and(|animations| {
            animations
                .iter()
                .any(|animation| animation["name"].as_str() == Some(idle))
        });
        if !known {
            return Err(invalid());
        }
    }
    Ok(changed)
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
    let mut changed = persist_model_source(connection, avatar, references)?;
    changed |= persist_animations(connection, avatar, references)?;
    Ok(changed)
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

    fn model_source() -> String {
        format!(
            "{DATA_PREFIX}{}",
            BASE64.encode(model_data(json!({ "extensions": { "VRMC_vrm": {} } })))
        )
    }

    fn vrma_data() -> Vec<u8> {
        model_data(json!({ "extensions": { "VRMC_vrm_animation": {} } }))
    }

    fn vrma_source() -> String {
        format!("{VRMA_DATA_PREFIX}{}", BASE64.encode(vrma_data()))
    }

    fn avatar(source: &str) -> Value {
        json!({ "source": source, "framing": { "scale": 1, "offsetY": 0, "rotation": 0 }, "expressionMap": { "smile": "happy" } })
    }

    fn character(source: &str, id: &str) -> Value {
        character_with_avatar(avatar(source), id)
    }

    fn character_with_avatar(avatar: Value, id: &str) -> Value {
        json!({ "id": id, "updatedAt": 1, "costumes": [{
            "name": "3d", "kind": "vrm", "image": format!("data:image/png;base64,{}", BASE64.encode(b"\x89PNG\r\n\x1a\nimage")), "vrm": avatar
        }] })
    }

    fn stored_character(db: &Connection, id: &str) -> String {
        db.query_row(
            "SELECT data_json FROM characters WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn asset_count(db: &Connection, mime_type: &str) -> i64 {
        db.query_row(
            "SELECT COUNT(*) FROM image_assets WHERE mime_type = ?1",
            params![mime_type],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn vrm_assets_round_trip_and_survive_until_the_last_owner_is_removed() {
        let mut db = open_test_database();
        let data = model_data(json!({ "extensions": { "VRMC_vrm": {} } }));
        let source = format!("{DATA_PREFIX}{}", BASE64.encode(&data));
        let original = character(&source, "one");
        put_character(&mut db, original.clone()).unwrap();
        let stored_json = stored_character(&db, "one");
        let stored: Value = serde_json::from_str(&stored_json).unwrap();
        let reference = stored["costumes"][0]["vrm"]["source"].as_str().unwrap();
        assert!(reference.starts_with("asset:"));
        assert!(!stored_json.contains(DATA_PREFIX));
        assert_eq!(
            get_character_with_images(&db, "one").unwrap().unwrap(),
            original
        );
        let count = |db: &Connection| asset_count(db, VRM_MIME);
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

    #[test]
    fn vrma_animations_round_trip_and_are_pruned_with_the_owner() {
        let mut db = open_test_database();
        let mut avatar = avatar(&model_source());
        avatar["idleAnimation"] = json!("wave");
        avatar["animations"] = json!([
            { "name": "wave", "source": vrma_source(), "loop": true, "useExpressions": false },
            { "name": "nod", "source": vrma_source() }
        ]);
        let original = character_with_avatar(avatar, "animated");
        put_character(&mut db, original.clone()).unwrap();
        let stored_json = stored_character(&db, "animated");
        assert!(!stored_json.contains(DATA_PREFIX));
        assert!(!stored_json.contains(VRMA_DATA_PREFIX));
        let stored: Value = serde_json::from_str(&stored_json).unwrap();
        let animations = stored["costumes"][0]["vrm"]["animations"]
            .as_array()
            .unwrap();
        assert!(
            animations
                .iter()
                .all(|animation| animation["source"].as_str().unwrap().starts_with("asset:"))
        );
        assert_eq!(stored["costumes"][0]["vrm"]["idleAnimation"], "wave");
        // Both motions share one payload, so a single VRMA asset is stored.
        assert_eq!(asset_count(&db, VRMA_MIME), 1);
        assert_eq!(
            get_character_with_images(&db, "animated").unwrap().unwrap(),
            original
        );
        put_character(&mut db, json!({ "id": "animated", "updatedAt": 2 })).unwrap();
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM image_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn rejects_assets_with_the_wrong_mime_type_for_vrm_and_vrma() {
        let mut db = open_test_database();
        let model_id = store_asset(
            &db,
            VRM_MIME,
            &model_data(json!({ "extensions": { "VRMC_vrm": {} } })),
        )
        .unwrap();
        let motion_id = store_asset(&db, VRMA_MIME, &vrma_data()).unwrap();
        // A motion asset cannot be used as the avatar model.
        assert!(
            put_character(
                &mut db,
                character(&format!("asset:{motion_id}"), "bad-model")
            )
            .is_err()
        );
        // A model asset cannot be used as a motion source.
        let mut bad = avatar(&format!("asset:{model_id}"));
        bad["animations"] = json!([{ "name": "wave", "source": format!("asset:{model_id}") }]);
        assert!(put_character(&mut db, character_with_avatar(bad, "bad-motion")).is_err());
        // The same references succeed once the mime types match.
        let mut good = avatar(&format!("asset:{model_id}"));
        good["animations"] = json!([{ "name": "wave", "source": format!("asset:{motion_id}") }]);
        assert!(put_character(&mut db, character_with_avatar(good, "good")).is_ok());
    }

    #[test]
    fn rejects_invalid_vrma_without_saving_partial_assets() {
        let mut db = open_test_database();
        for data in [
            b"not a motion".to_vec(),
            model_data(json!({ "extensions": { "VRM": {} } })),
            model_data(
                json!({ "extensions": { "VRMC_vrm_animation": {} }, "buffers": [{ "uri": "https://example.com/a.bin" }] }),
            ),
        ] {
            let mut avatar = avatar(&model_source());
            avatar["animations"] = json!([{ "name": "wave", "source": format!("{VRMA_DATA_PREFIX}{}", BASE64.encode(&data)) }]);
            assert!(put_character(&mut db, character_with_avatar(avatar, "invalid")).is_err());
        }
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM image_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert!(validate_vrma(&vrma_data()).is_ok());
    }

    #[test]
    fn rejects_malformed_animation_entries() {
        let mut db = open_test_database();
        let entry = json!({ "name": "wave", "source": vrma_source() });
        let too_many = vec![entry; MAX_VRM_ANIMATIONS + 1];
        for animations in [
            json!({ "name": "wave" }),
            json!([{ "source": vrma_source() }]),
            json!([{ "name": " ", "source": vrma_source() }]),
            json!([{ "name": "x".repeat(MAX_VRM_ANIMATION_NAME + 1), "source": vrma_source() }]),
            json!([{ "name": "none", "source": vrma_source() }]),
            json!([{ "name": " NoNe ", "source": vrma_source() }]),
            json!([{ "name": "wave", "source": vrma_source(), "loop": "yes" }]),
            json!([{ "name": "wave", "source": vrma_source(), "useExpressions": 1 }]),
            json!([{ "name": "wave", "source": "data:model/gltf-binary;base64,AAAA" }]),
            json!(["wave"]),
            Value::Array(too_many),
        ] {
            let mut avatar = avatar(&model_source());
            avatar["animations"] = animations;
            assert!(put_character(&mut db, character_with_avatar(avatar, "invalid")).is_err());
        }
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM image_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn rejects_idle_animation_without_a_matching_animation_name() {
        let mut db = open_test_database();
        for (idle, animations) in [
            (json!("wave"), None),
            (
                json!("spin"),
                Some(json!([{ "name": "wave", "source": vrma_source() }])),
            ),
            (
                json!(3),
                Some(json!([{ "name": "wave", "source": vrma_source() }])),
            ),
        ] {
            let mut avatar = avatar(&model_source());
            avatar["idleAnimation"] = idle;
            if let Some(animations) = animations {
                avatar["animations"] = animations;
            }
            assert!(put_character(&mut db, character_with_avatar(avatar, "idle")).is_err());
        }
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM image_assets", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
