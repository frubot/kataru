use std::collections::HashSet;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

use super::json::{now_millis, serialize};

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

pub(super) fn externalize_character_images(
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

pub(super) fn externalize_situation_images(
    connection: &Connection,
    situation: &mut Value,
) -> AppResult<(HashSet<String>, bool)> {
    let object = situation.as_object_mut().ok_or_else(|| {
        AppError::BadRequest("シチュエーションはJSONオブジェクトである必要があります。".to_owned())
    })?;
    let mut referenced_assets = HashSet::new();
    let changed = persist_image_field(
        connection,
        object,
        "backgroundImage",
        &mut referenced_assets,
    )?;
    Ok((referenced_assets, changed))
}

pub(super) fn sync_character_image_assets(
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

pub(super) fn sync_situation_image_assets(
    connection: &Connection,
    situation_id: &str,
    asset_ids: &HashSet<String>,
) -> AppResult<()> {
    connection.execute(
        "DELETE FROM situation_image_assets WHERE situation_id = ?1",
        params![situation_id],
    )?;
    for asset_id in asset_ids {
        connection.execute(
            "INSERT INTO situation_image_assets(situation_id, asset_id) VALUES (?1, ?2)",
            params![situation_id, asset_id],
        )?;
    }
    Ok(())
}

pub(super) fn prune_orphaned_image_assets(connection: &Connection) -> AppResult<()> {
    connection.execute(
        "DELETE FROM image_assets
         WHERE NOT EXISTS (
             SELECT 1 FROM character_image_assets
             WHERE character_image_assets.asset_id = image_assets.id
         )
         AND NOT EXISTS (
             SELECT 1 FROM situation_image_assets
             WHERE situation_image_assets.asset_id = image_assets.id
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

pub(super) fn inline_character_images(
    connection: &Connection,
    character: &mut Value,
) -> AppResult<()> {
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

pub(super) fn inline_situation_images(
    connection: &Connection,
    situation: &mut Value,
) -> AppResult<()> {
    let Some(object) = situation.as_object_mut() else {
        return Ok(());
    };
    if let Some(background_image) = object.get_mut("backgroundImage") {
        inline_image_source(connection, background_image)?;
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

pub fn migrate_situation_images(transaction: &Transaction<'_>) -> AppResult<()> {
    let stored_situations = {
        let mut statement =
            transaction.prepare("SELECT id, data_json FROM situations ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut situations = Vec::new();
        for row in rows {
            situations.push(row?);
        }
        situations
    };

    for (situation_id, data_json) in stored_situations {
        let mut situation: Value = serde_json::from_str(&data_json)?;
        let (asset_ids, changed) = externalize_situation_images(transaction, &mut situation)?;
        if changed {
            transaction.execute(
                "UPDATE situations SET data_json = ?2 WHERE id = ?1",
                params![situation_id, serialize(&situation)?],
            )?;
        }
        sync_situation_image_assets(transaction, &situation_id, &asset_ids)?;
    }
    prune_orphaned_image_assets(transaction)
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
    use serde_json::{Value, json};

    use super::{
        IMAGE_ASSET_PREFIX, inline_character_images, inline_situation_images,
        prune_orphaned_image_assets,
    };
    use crate::db::storage::{
        characters::{upsert_character, upsert_situation},
        test_support::open_test_database,
    };

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
                .query_row("SELECT COUNT(*) FROM image_assets", [], |row| {
                    row.get::<_, i64>(0)
                })
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
                .query_row("SELECT COUNT(*) FROM image_assets", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count remaining assets"),
            0
        );
    }

    #[test]
    fn situation_background_is_externalized_and_inlined_for_export() {
        let mut connection = open_test_database();
        let data_url = format!(
            "data:image/png;base64,{}",
            BASE64.encode(b"situation-background")
        );
        let transaction = connection.transaction().expect("start transaction");
        upsert_situation(
            &transaction,
            json!({
                "id": "situation-1",
                "updatedAt": 1,
                "backgroundImage": data_url
            }),
        )
        .expect("store situation background");
        prune_orphaned_image_assets(&transaction).expect("prune assets");
        transaction.commit().expect("commit situation");

        let stored_json: String = connection
            .query_row(
                "SELECT data_json FROM situations WHERE id = 'situation-1'",
                [],
                |row| row.get(0),
            )
            .expect("read stored situation");
        assert!(!stored_json.contains("data:image"));
        assert!(stored_json.contains(IMAGE_ASSET_PREFIX));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM situation_image_assets", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count situation image assets"),
            1
        );

        let mut exported: Value =
            serde_json::from_str(&stored_json).expect("parse stored situation");
        inline_situation_images(&connection, &mut exported)
            .expect("inline exported situation background");
        assert_eq!(exported["backgroundImage"], data_url);
    }
}
