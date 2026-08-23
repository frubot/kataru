use rusqlite::{Connection, Transaction, params};
use serde_json::Value;

use crate::error::AppResult;

use super::{
    images::{
        externalize_character_images, externalize_situation_images, inline_character_images,
        inline_situation_images, prune_orphaned_image_assets, sync_character_image_assets,
        sync_situation_image_assets,
    },
    json::{query_json_values, query_optional_json, required_i64, required_string, serialize},
};

pub(super) fn get_character_with_images(
    connection: &Connection,
    character_id: &str,
) -> AppResult<Option<Value>> {
    let mut character = query_optional_json(
        connection,
        "SELECT data_json FROM characters WHERE id = ?1",
        params![character_id],
    )?;
    if let Some(character) = &mut character {
        inline_character_images(connection, character)?;
    }
    Ok(character)
}

pub(super) fn get_all_characters(
    connection: &Connection,
    include_images: bool,
) -> AppResult<Vec<Value>> {
    let mut characters = query_json_values(
        connection,
        "SELECT data_json FROM characters ORDER BY id",
        [],
    )?;
    if include_images {
        for character in &mut characters {
            inline_character_images(connection, character)?;
        }
    }
    Ok(characters)
}

pub(super) fn put_character(connection: &mut Connection, character: Value) -> AppResult<()> {
    let transaction = connection.transaction()?;
    upsert_character(&transaction, character)?;
    prune_orphaned_image_assets(&transaction)?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn delete_character(connection: &mut Connection, character_id: &str) -> AppResult<()> {
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
    Ok(())
}

pub(super) fn upsert_character(
    connection: &Transaction<'_>,
    mut character: Value,
) -> AppResult<()> {
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

pub(super) fn get_all_situations(
    connection: &Connection,
    include_images: bool,
) -> AppResult<Vec<Value>> {
    let mut situations = query_json_values(
        connection,
        "SELECT data_json FROM situations ORDER BY id",
        [],
    )?;
    if include_images {
        for situation in &mut situations {
            inline_situation_images(connection, situation)?;
        }
    }
    Ok(situations)
}

pub(super) fn put_situation(connection: &mut Connection, situation: Value) -> AppResult<()> {
    let transaction = connection.transaction()?;
    upsert_situation(&transaction, situation)?;
    prune_orphaned_image_assets(&transaction)?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn delete_situation(connection: &mut Connection, situation_id: &str) -> AppResult<()> {
    let transaction = connection.transaction()?;
    transaction.execute(
        "DELETE FROM situations WHERE id = ?1",
        params![situation_id],
    )?;
    prune_orphaned_image_assets(&transaction)?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn upsert_situation(connection: &Connection, mut situation: Value) -> AppResult<()> {
    let id = required_string(&situation, "id")?;
    let updated_at = required_i64(&situation, "updatedAt")?;
    let (asset_ids, _) = externalize_situation_images(connection, &mut situation)?;
    connection.execute(
        "INSERT INTO situations(id, updated_at, data_json) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
             updated_at = excluded.updated_at,
             data_json = excluded.data_json",
        params![id, updated_at, serialize(&situation)?],
    )?;
    sync_situation_image_assets(connection, &id, &asset_ids)?;
    Ok(())
}
