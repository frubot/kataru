//! .kataru キャラクターパッケージ（ZIP）のエクスポート・検査・インポート。
//!
//! レイアウト:
//!   manifest.json    パッケージ形式・収録ファイルの目録
//!   character.json   共有キャラクター（画像・モデルは "asset:<sha256>" 参照）
//!   assets/<sha256>.<ext>  収録バイナリ（拡張子はMIME typeから決まる）

use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read, Write},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::error::{AppError, AppResult};

use super::{
    characters::upsert_character,
    images::{detect_image_mime, prune_orphaned_image_assets, store_asset},
    json::{now_millis, serialize},
    vrm::{
        MAX_VRM_ANIMATIONS, MAX_VRM_BYTES, MAX_VRMA_BYTES, VRM_MIME, VRMA_MIME, valid_motion_name,
        validate_model, validate_vrma,
    },
};

const MANIFEST_ENTRY: &str = "manifest.json";
const CHARACTER_ENTRY: &str = "character.json";
const ASSET_DIRECTORY: &str = "assets/";
const ASSET_REFERENCE_PREFIX: &str = "asset:";
const PACKAGE_FORMAT: &str = "kataru-character";
const PACKAGE_VERSION: i64 = 1;
const MAX_PACKAGE_ENTRIES: usize = 64;
const MAX_JSON_ENTRY_BYTES: u64 = 4 * 1024 * 1024;
const MAX_IMAGE_ENTRY_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PACKAGE_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

/// `copySharedCharacter` (lib/importExport.ts) が出力するオプション・フィールド。
const SHARED_OPTIONAL_FIELDS: &[&str] = &[
    "speechStyle",
    "protagonistPrompt",
    "userConstraints",
    "icon",
    "maxCharacters",
    "maxHistory",
    "temperature",
    "topP",
    "topK",
    "frequencyPenalty",
    "presencePenalty",
    "repetitionPenalty",
    "enableMemory",
];

fn invalid_package() -> AppError {
    AppError::BadRequest("キャラクターパッケージの形式が正しくありません。".to_owned())
}

fn package_too_large() -> AppError {
    AppError::BadRequest("キャラクターパッケージが大きすぎます。".to_owned())
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 共有キャラクターのうち `copySharedCharacter` が引き継ぐフィールドだけを抜き出す
/// （model・id・favorite・createdAt・updatedAt・enableThinking は呼び出し側で扱う）。
fn shared_character_fields(character: &Value) -> Map<String, Value> {
    let mut shared = Map::new();
    let Some(object) = character.as_object() else {
        return shared;
    };
    for key in ["name", "systemPrompt"] {
        shared.insert(
            key.to_owned(),
            object.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    for &key in SHARED_OPTIONAL_FIELDS {
        if let Some(value) = object.get(key) {
            shared.insert(key.to_owned(), value.clone());
        }
    }
    for key in ["expressions", "costumes"] {
        if let Some(value) = object.get(key) {
            shared.insert(key.to_owned(), value.clone());
        }
    }
    shared
}

/// `normalizeModelRef` (lib/modelDefaults.ts) の移植。(model, connectionId) を返す。
fn normalize_model_ref(
    value: &Value,
    fallback_model: &str,
    fallback_connection_id: &str,
) -> (String, String) {
    let fallback = || (fallback_model.to_owned(), fallback_connection_id.to_owned());
    if let Some(model) = value.as_str() {
        let model = model.trim();
        return if model.is_empty() {
            fallback()
        } else {
            (model.to_owned(), fallback_connection_id.to_owned())
        };
    }
    let Some(object) = value.as_object() else {
        return fallback();
    };
    let trimmed = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let connection_id = trimmed("connectionId")
        .or_else(|| trimmed("aiApiType"))
        .unwrap_or(fallback_connection_id)
        .to_owned();
    let model = trimmed("model").unwrap_or(fallback_model).to_owned();
    (model, connection_id)
}

/// includeVrm=false のとき VRM衣装を画像衣装に落とす
/// （lib/importExport.ts の createCharacterBackup と同じ形）。
fn downgrade_vrm_costumes(shared: &mut Map<String, Value>) {
    let Some(costumes) = shared.get_mut("costumes").and_then(Value::as_array_mut) else {
        return;
    };
    for costume in costumes.iter_mut() {
        if costume.get("kind").and_then(Value::as_str) != Some("vrm") {
            continue;
        }
        let mut replacement = Map::new();
        if let Some(name) = costume.get("name") {
            replacement.insert("name".to_owned(), name.clone());
        }
        replacement.insert("kind".to_owned(), Value::String("image".to_owned()));
        for key in ["image", "promptDetail"] {
            if let Some(value) = costume.get(key) {
                replacement.insert(key.to_owned(), value.clone());
            }
        }
        *costume = Value::Object(replacement);
    }
}

fn push_asset_ref(refs: &mut Vec<String>, seen: &mut HashSet<String>, source: Option<&Value>) {
    let Some(asset_id) = source
        .and_then(Value::as_str)
        .and_then(|source| source.strip_prefix(ASSET_REFERENCE_PREFIX))
    else {
        return;
    };
    if seen.insert(asset_id.to_owned()) {
        refs.push(asset_id.to_owned());
    }
}

fn collect_expression_refs(
    expressions: Option<&Value>,
    refs: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    if let Some(expressions) = expressions.and_then(Value::as_array) {
        for expression in expressions {
            push_asset_ref(refs, seen, expression.get("image"));
        }
    }
}

/// `inline_character_images` と同じ巡回で `asset:` 参照を収集する（順序保持・重複なし）。
fn collect_asset_refs(character: &Value) -> Vec<String> {
    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    let Some(object) = character.as_object() else {
        return refs;
    };
    push_asset_ref(&mut refs, &mut seen, object.get("icon"));
    collect_expression_refs(object.get("expressions"), &mut refs, &mut seen);
    if let Some(costumes) = object.get("costumes").and_then(Value::as_array) {
        for costume in costumes {
            let Some(costume) = costume.as_object() else {
                continue;
            };
            push_asset_ref(&mut refs, &mut seen, costume.get("image"));
            if let Some(avatar) = costume.get("vrm") {
                push_asset_ref(&mut refs, &mut seen, avatar.get("source"));
                if let Some(animations) = avatar.get("animations").and_then(Value::as_array) {
                    for animation in animations {
                        push_asset_ref(&mut refs, &mut seen, animation.get("source"));
                    }
                }
            }
            collect_expression_refs(costume.get("expressions"), &mut refs, &mut seen);
        }
    }
    refs
}

fn extension_for_mime(mime_type: &str) -> AppResult<&'static str> {
    match mime_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        VRM_MIME => Ok("vrm"),
        VRMA_MIME => Ok("vrma"),
        _ => Err(AppError::Internal(format!(
            "保存アセットのMIME typeが不正です: {mime_type}"
        ))),
    }
}

/// 保存時の形式検証が入る前に取り込まれた画像の救済。未知の image/* MIMEでも
/// 内容が対応形式なら検出結果で書き出す。
fn normalize_stored_mime(mime_type: &str, data: &[u8]) -> AppResult<String> {
    if extension_for_mime(mime_type).is_ok() {
        return Ok(mime_type.to_owned());
    }
    if mime_type.starts_with("image/")
        && let Some(detected) = detect_image_mime(data)
    {
        return Ok(detected.to_owned());
    }
    Err(AppError::Internal(format!(
        "保存アセットのMIME typeが不正です: {mime_type}"
    )))
}

/// 画像フィールドの値。アセット参照か画像data URLのみ許可し、
/// 外部URLを参照するキャラクターの取り込みを防ぐ。
fn valid_image_source(value: &Value) -> bool {
    value.as_str().is_some_and(|source| {
        source.starts_with(ASSET_REFERENCE_PREFIX) || source.starts_with("data:image/")
    })
}

/// `isValidExpression` (lib/importExport.ts) の移植。
fn valid_expression(value: &Value) -> bool {
    let Some(expression) = value.as_object() else {
        return false;
    };
    expression
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| !name.trim().is_empty())
        && expression.get("image").is_some_and(valid_image_source)
        && expression.get("promptDetail").is_none_or(Value::is_string)
}

fn valid_expression_list(value: Option<&Value>) -> bool {
    value.is_none_or(|expressions| {
        expressions
            .as_array()
            .is_some_and(|expressions| expressions.iter().all(valid_expression))
    })
}

/// `isVrmSource` / `isVrmaSource` (lib/vrm.ts) の移植。パッケージ内では
/// "asset:" 参照が主だが、data URLも保存経路で受理されるため両方を許可する。
fn valid_model_source(value: Option<&Value>, mime: &str) -> bool {
    value.and_then(Value::as_str).is_some_and(|source| {
        source.starts_with(ASSET_REFERENCE_PREFIX)
            || source.starts_with(&format!("data:{mime};base64,"))
    })
}

/// `isValidVrmAvatar` (lib/importExport.ts) の移植。バイナリ実体の検証は
/// persist_vrm / validate_model が担うため、ここでは構造と値域だけを見る。
fn valid_vrm_avatar(value: &Value) -> bool {
    let Some(avatar) = value.as_object() else {
        return false;
    };
    let Some(framing) = avatar.get("framing").and_then(Value::as_object) else {
        return false;
    };
    let framing_valid = [
        ("scale", 0.5, 2.0),
        ("offsetY", -0.5, 0.5),
        ("rotation", -180.0, 180.0),
    ]
    .iter()
    .all(|(key, min, max)| {
        framing
            .get(*key)
            .and_then(Value::as_f64)
            .is_some_and(|value| value >= *min && value <= *max)
    });
    let Some(expression_map) = avatar.get("expressionMap").and_then(Value::as_object) else {
        return false;
    };
    let map_valid = expression_map.len() <= 256
        && expression_map.iter().all(|(name, target)| {
            !name.trim().is_empty()
                && name.len() <= 256
                && target.as_str().is_some_and(|target| target.len() <= 256)
        });
    let animations_valid = avatar.get("animations").is_none_or(|animations| {
        animations.as_array().is_some_and(|animations| {
            animations.len() <= MAX_VRM_ANIMATIONS
                && animations.iter().all(|animation| {
                    let Some(animation) = animation.as_object() else {
                        return false;
                    };
                    animation
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(valid_motion_name)
                        && ["loop", "useExpressions"]
                            .iter()
                            .all(|key| animation.get(*key).is_none_or(Value::is_boolean))
                        && valid_model_source(animation.get("source"), VRMA_MIME)
                })
        })
    });
    let idle_valid = avatar.get("idleAnimation").is_none_or(|idle| {
        idle.as_str().is_some_and(|idle| {
            avatar
                .get("animations")
                .and_then(Value::as_array)
                .is_some_and(|animations| {
                    animations.iter().any(|animation| {
                        animation.get("name").and_then(Value::as_str) == Some(idle)
                    })
                })
        })
    });
    framing_valid
        && map_valid
        && animations_valid
        && idle_valid
        && valid_model_source(avatar.get("source"), VRM_MIME)
}

/// `isValidCostume` (lib/importExport.ts) の移植。
fn valid_costume(value: &Value) -> bool {
    let Some(costume) = value.as_object() else {
        return false;
    };
    let kind = costume.get("kind").and_then(Value::as_str);
    costume
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| !name.trim().is_empty())
        && costume.get("image").is_some_and(valid_image_source)
        && costume.get("promptDetail").is_none_or(Value::is_string)
        && costume
            .get("kind")
            .is_none_or(|kind| matches!(kind.as_str(), Some("image" | "vrm")))
        && valid_expression_list(costume.get("expressions"))
        && if kind == Some("vrm") {
            costume.get("vrm").is_some_and(valid_vrm_avatar)
        } else {
            !costume.contains_key("vrm")
        }
}

/// character.json が保存・描画に耐える型かを検証する。upsert_character は
/// 画像参照とVRMを再検証するが、配列以外の costumes 等はそのまま保存して
/// しまい、設定画面の `.find()` が落ちるため、ここで copySharedCharacter が
/// 引き継ぐ全フィールドの型を確認する。
fn valid_shared_character(object: &Map<String, Value>) -> bool {
    object
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| !name.trim().is_empty())
        && object.get("systemPrompt").is_some_and(Value::is_string)
        && ["speechStyle", "protagonistPrompt", "userConstraints"]
            .iter()
            .all(|key| object.get(*key).is_none_or(Value::is_string))
        && object.get("icon").is_none_or(valid_image_source)
        && [
            "maxCharacters",
            "maxHistory",
            "temperature",
            "topP",
            "topK",
            "frequencyPenalty",
            "presencePenalty",
            "repetitionPenalty",
        ]
        .iter()
        .all(|key| object.get(*key).is_none_or(Value::is_number))
        && object.get("enableMemory").is_none_or(Value::is_boolean)
        && object
            .get("model")
            .is_none_or(|model| model.is_string() || model.is_object())
        && valid_expression_list(object.get("expressions"))
        && object.get("costumes").is_none_or(|costumes| {
            costumes
                .as_array()
                .is_some_and(|costumes| costumes.iter().all(valid_costume))
        })
}

pub fn build_character_package(
    connection: &Connection,
    character_id: &str,
    include_vrm: bool,
    builtin_ids: &HashSet<String>,
    fallback_connection_id: &str,
) -> AppResult<Vec<u8>> {
    let data_json = connection
        .query_row(
            "SELECT data_json FROM characters WHERE id = ?1",
            params![character_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("キャラクターが見つかりません。".to_owned()))?;
    let character: Value = serde_json::from_str(&data_json)?;

    let mut shared = shared_character_fields(&character);
    // カスタム接続（cx_*）は他環境に存在しないため、組み込み接続のIDだけを残し、
    // それ以外はモデル名のみに落とす（copySharedCharacter と同じ規則）。
    let (model, connection_id) =
        normalize_model_ref(&character["model"], "", fallback_connection_id);
    shared.insert(
        "model".to_owned(),
        if builtin_ids.contains(&connection_id) {
            json!({ "model": model, "connectionId": connection_id })
        } else {
            Value::String(model)
        },
    );
    if !include_vrm {
        downgrade_vrm_costumes(&mut shared);
    }
    let shared = Value::Object(shared);

    // 参照されているアセットを収集し、実体と拡張子を決める。
    let mut assets = Vec::new();
    for asset_id in collect_asset_refs(&shared) {
        let (mime_type, data) = connection
            .query_row(
                "SELECT mime_type, data FROM image_assets WHERE id = ?1",
                params![asset_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::Internal("保存画像の参照が壊れています。".to_owned()))?;
        let mime_type = normalize_stored_mime(&mime_type, &data)?;
        let extension = extension_for_mime(&mime_type)?;
        assets.push((asset_id, extension, mime_type, data));
    }
    // アセットID順に並べてエクスポート結果を決定的にする。
    assets.sort_by(|left, right| left.0.cmp(&right.0));

    let file_options = |method: CompressionMethod| {
        SimpleFileOptions::default()
            .compression_method(method)
            // エクスポートを決定的にするため固定のタイムスタンプを使う。
            .last_modified_time(
                DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0).expect("fixed package timestamp"),
            )
    };
    let zip_error = |error: zip::result::ZipError| {
        AppError::Internal(format!(
            "キャラクターパッケージの生成に失敗しました: {error}"
        ))
    };

    let manifest_assets: Vec<Value> = assets
        .iter()
        .map(|(asset_id, extension, mime_type, data)| {
            json!({
                "path": format!("{ASSET_DIRECTORY}{asset_id}.{extension}"),
                "sha256": asset_id,
                "mime": mime_type,
                "size": data.len(),
            })
        })
        .collect();
    let manifest = json!({
        "format": PACKAGE_FORMAT,
        "version": PACKAGE_VERSION,
        "exportedAt": now_millis(),
        "generator": format!("Kataru/{}", env!("CARGO_PKG_VERSION")),
        "assets": manifest_assets,
    });
    let manifest_json = serialize(&manifest)?;
    let shared_json = serialize(&shared)?;
    // 読み込み側（parse_package）の上限と揃え、書き出したパッケージが
    // そのまま再インポートできることを保証する。
    if assets.len() + 2 > MAX_PACKAGE_ENTRIES
        || manifest_json.len() as u64 > MAX_JSON_ENTRY_BYTES
        || shared_json.len() as u64 > MAX_JSON_ENTRY_BYTES
    {
        return Err(package_too_large());
    }
    let mut total_size = (manifest_json.len() + shared_json.len()) as u64;
    for (_, _, mime_type, data) in &assets {
        let cap = match mime_type.as_str() {
            VRM_MIME => MAX_VRM_BYTES as u64,
            VRMA_MIME => MAX_VRMA_BYTES as u64,
            _ => MAX_IMAGE_ENTRY_BYTES,
        };
        total_size += data.len() as u64;
        if data.len() as u64 > cap || total_size > MAX_PACKAGE_UNCOMPRESSED_BYTES {
            return Err(package_too_large());
        }
    }

    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(MANIFEST_ENTRY, file_options(CompressionMethod::Deflated))
        .map_err(zip_error)?;
    writer.write_all(manifest_json.as_bytes())?;
    writer
        .start_file(CHARACTER_ENTRY, file_options(CompressionMethod::Deflated))
        .map_err(zip_error)?;
    writer.write_all(shared_json.as_bytes())?;
    for (asset_id, extension, _, data) in &assets {
        writer
            .start_file(
                format!("{ASSET_DIRECTORY}{asset_id}.{extension}"),
                file_options(CompressionMethod::Stored),
            )
            .map_err(zip_error)?;
        writer.write_all(data)?;
    }
    let cursor = writer.finish().map_err(zip_error)?;
    Ok(cursor.into_inner())
}

struct RawAssetFile {
    extension: String,
    data: Vec<u8>,
}

struct ParsedAssetFile {
    mime_type: &'static str,
    data: Vec<u8>,
}

struct ParsedPackage {
    character: Value,
    exported_at: i64,
    files: HashMap<String, ParsedAssetFile>,
    referenced_ids: Vec<String>,
}

enum EntryKind {
    Manifest,
    Character,
    Asset { id: String, extension: String },
}

fn classify_entry(name: &str) -> AppResult<(EntryKind, u64)> {
    if name == MANIFEST_ENTRY {
        return Ok((EntryKind::Manifest, MAX_JSON_ENTRY_BYTES));
    }
    if name == CHARACTER_ENTRY {
        return Ok((EntryKind::Character, MAX_JSON_ENTRY_BYTES));
    }
    let Some(rest) = name.strip_prefix(ASSET_DIRECTORY) else {
        return Err(invalid_package());
    };
    let Some((stem, extension)) = rest.split_once('.') else {
        return Err(invalid_package());
    };
    if stem.len() != 64
        || !stem
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_package());
    }
    let cap = if IMAGE_EXTENSIONS.contains(&extension) {
        MAX_IMAGE_ENTRY_BYTES
    } else if extension == "vrm" {
        MAX_VRM_BYTES as u64
    } else if extension == "vrma" {
        MAX_VRMA_BYTES as u64
    } else {
        return Err(invalid_package());
    };
    Ok((
        EntryKind::Asset {
            id: stem.to_owned(),
            extension: extension.to_owned(),
        },
        cap,
    ))
}

/// 拡張子が内容と一致するか検証し、検出されたMIME typeを返す。
fn validate_asset_content(extension: &str, data: &[u8]) -> AppResult<&'static str> {
    if IMAGE_EXTENSIONS.contains(&extension) {
        let detected = detect_image_mime(data).ok_or_else(|| {
            AppError::BadRequest("パッケージ内の画像ファイル形式が正しくありません。".to_owned())
        })?;
        let expected = match extension {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            _ => "image/gif",
        };
        if detected != expected {
            return Err(AppError::BadRequest(
                "パッケージ内のファイルが拡張子と一致しません。".to_owned(),
            ));
        }
        return Ok(detected);
    }
    match extension {
        "vrm" => {
            validate_model(data)?;
            Ok(VRM_MIME)
        }
        "vrma" => {
            validate_vrma(data)?;
            Ok(VRMA_MIME)
        }
        _ => Err(invalid_package()),
    }
}

fn parse_package(bytes: &[u8]) -> AppResult<ParsedPackage> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid_package())?;
    if archive.len() > MAX_PACKAGE_ENTRIES {
        return Err(package_too_large());
    }
    let mut seen_names = HashSet::new();
    let mut manifest_data = None;
    let mut character_data = None;
    let mut files: HashMap<String, RawAssetFile> = HashMap::new();
    let mut total_size = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|_| invalid_package())?;
        let name = entry.name().to_owned();
        if name.ends_with('/') {
            continue;
        }
        if !seen_names.insert(name.clone()) {
            return Err(invalid_package());
        }
        let (kind, cap) = classify_entry(&name)?;
        if entry.size() > cap {
            return Err(package_too_large());
        }
        // 宣言サイズが上限内でも、実体が溢れないよう cap+1 で打ち切って読む。
        // 読み切った時点で CRC も検証される。
        let mut data = Vec::new();
        entry
            .take(cap + 1)
            .read_to_end(&mut data)
            .map_err(|_| invalid_package())?;
        if data.len() as u64 > cap {
            return Err(package_too_large());
        }
        total_size += data.len() as u64;
        if total_size > MAX_PACKAGE_UNCOMPRESSED_BYTES {
            return Err(package_too_large());
        }
        match kind {
            EntryKind::Manifest => manifest_data = Some(data),
            EntryKind::Character => character_data = Some(data),
            EntryKind::Asset { id, extension } => {
                files.insert(id, RawAssetFile { extension, data });
            }
        }
    }

    let manifest_data = manifest_data.ok_or_else(invalid_package)?;
    let manifest: Value = serde_json::from_slice(&manifest_data).map_err(|_| invalid_package())?;
    let manifest = manifest.as_object().ok_or_else(invalid_package)?;
    if manifest.get("format").and_then(Value::as_str) != Some(PACKAGE_FORMAT)
        || manifest.get("version").and_then(Value::as_i64) != Some(PACKAGE_VERSION)
    {
        return Err(invalid_package());
    }
    let exported_at = manifest
        .get("exportedAt")
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let character_data = character_data.ok_or_else(invalid_package)?;
    let character: Value =
        serde_json::from_slice(&character_data).map_err(|_| invalid_package())?;
    let character_object = character.as_object().ok_or_else(invalid_package)?;
    if !valid_shared_character(character_object) {
        return Err(invalid_package());
    }

    // ファイル名の stem と内容のハッシュ・形式が一致することを確認する。
    let mut checked_files = HashMap::with_capacity(files.len());
    for (id, file) in files {
        if sha256_hex(&file.data) != id {
            return Err(AppError::BadRequest(
                "パッケージ内のファイルが破損しています。".to_owned(),
            ));
        }
        let mime_type = validate_asset_content(&file.extension, &file.data)?;
        checked_files.insert(
            id,
            ParsedAssetFile {
                mime_type,
                data: file.data,
            },
        );
    }

    // キャラクターが参照するアセットは全て同梱されている必要がある。
    let referenced_ids = collect_asset_refs(&character);
    for asset_id in &referenced_ids {
        if !checked_files.contains_key(asset_id) {
            return Err(AppError::BadRequest(
                "キャラクターが参照するパッケージ内ファイルがありません。".to_owned(),
            ));
        }
    }

    Ok(ParsedPackage {
        character,
        exported_at,
        files: checked_files,
        referenced_ids,
    })
}

pub fn import_character_package(
    connection: &mut Connection,
    bytes: &[u8],
    fallback_model: &str,
    fallback_connection_id: &str,
    known_ids: &HashSet<String>,
) -> AppResult<Value> {
    let parsed = parse_package(bytes)?;
    let transaction = connection.transaction()?;
    for asset_id in &parsed.referenced_ids {
        let file = &parsed.files[asset_id];
        store_asset(&transaction, file.mime_type, &file.data)?;
    }

    let mut shared = shared_character_fields(&parsed.character);
    let (model, connection_id) = normalize_model_ref(
        &parsed.character["model"],
        fallback_model,
        fallback_connection_id,
    );
    // この環境に存在しない接続はフォールバックの接続に置き換える。
    let connection_id = if known_ids.contains(&connection_id) {
        connection_id
    } else {
        fallback_connection_id.to_owned()
    };
    shared.insert(
        "model".to_owned(),
        json!({ "model": model, "connectionId": connection_id }),
    );
    let now = now_millis();
    shared.insert(
        "id".to_owned(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    shared.insert("createdAt".to_owned(), json!(now));
    shared.insert("updatedAt".to_owned(), json!(now));

    // upsert_character がアセット存在・MIME・外部URI禁止・framing を再検証する。
    let stored = upsert_character(&transaction, Value::Object(shared))?;
    prune_orphaned_image_assets(&transaction)?;
    transaction.commit()?;
    Ok(stored)
}

/// インポート確認用のパッケージ概要。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePreview {
    name: String,
    preview_image: Option<String>,
    exported_at: i64,
    has_vrm: bool,
    asset_count: usize,
}

fn name_is(value: &Value, expected: &str) -> bool {
    value
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| name.trim().to_lowercase() == expected)
}

fn image_source_of(value: &Value) -> Option<&str> {
    value.get("image").and_then(Value::as_str)
}

/// `resolveCharacterImportPreviewImage` (lib/characterImportPreview.ts) の移植。
fn preview_image_source(character: &Value) -> Option<&str> {
    let object = character.as_object()?;
    let default_costume = object
        .get("costumes")
        .and_then(Value::as_array)
        .and_then(|costumes| costumes.iter().find(|&c| name_is(c, "default")));
    if let Some(costume) = default_costume {
        if let Some(image) = costume
            .get("expressions")
            .and_then(Value::as_array)
            .and_then(|expressions| expressions.iter().find(|&e| name_is(e, "neutral")))
            .and_then(image_source_of)
        {
            return Some(image);
        }
        if let Some(image) = image_source_of(costume) {
            return Some(image);
        }
    }
    if let Some(image) = object
        .get("expressions")
        .and_then(Value::as_array)
        .and_then(|expressions| expressions.iter().find(|&e| name_is(e, "neutral")))
        .and_then(image_source_of)
    {
        return Some(image);
    }
    object.get("icon").and_then(Value::as_str)
}

fn preview_image(parsed: &ParsedPackage) -> Option<String> {
    let source = preview_image_source(&parsed.character)?;
    let Some(asset_id) = source.strip_prefix(ASSET_REFERENCE_PREFIX) else {
        // 参照形式でない値（例: data URL）はそのまま返す。
        return Some(source.to_owned());
    };
    let file = parsed.files.get(asset_id)?;
    Some(format!(
        "data:{};base64,{}",
        file.mime_type,
        BASE64.encode(&file.data)
    ))
}

pub fn inspect_character_package(bytes: &[u8]) -> AppResult<PackagePreview> {
    let parsed = parse_package(bytes)?;
    let character_object = parsed.character.as_object();
    let name = character_object
        .and_then(|object| object.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let has_vrm = character_object
        .and_then(|object| object.get("costumes"))
        .and_then(Value::as_array)
        .is_some_and(|costumes| {
            costumes
                .iter()
                .any(|costume| costume.get("kind").and_then(Value::as_str) == Some("vrm"))
        });
    Ok(PackagePreview {
        name,
        preview_image: preview_image(&parsed),
        exported_at: parsed.exported_at,
        has_vrm,
        asset_count: parsed.referenced_ids.len(),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    use crate::db::storage::{
        characters::{get_character_with_images, put_character},
        test_support::open_test_database,
    };

    fn id_set(values: &[&str]) -> HashSet<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn model_data(json: Value) -> Vec<u8> {
        let mut payload = serde_json::to_vec(&json).expect("serialize model json");
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

    fn vrm_bytes() -> Vec<u8> {
        model_data(json!({ "extensions": { "VRMC_vrm": {} } }))
    }

    fn vrma_bytes() -> Vec<u8> {
        model_data(json!({ "extensions": { "VRMC_vrm_animation": {} } }))
    }

    fn png_bytes(tag: &str) -> Vec<u8> {
        let mut data = b"\x89PNG\r\n\x1a\n".to_vec();
        data.extend_from_slice(tag.as_bytes());
        data
    }

    fn jpeg_bytes(tag: &str) -> Vec<u8> {
        let mut data = b"\xff\xd8\xff\xe0".to_vec();
        data.extend_from_slice(tag.as_bytes());
        data
    }

    fn data_url(mime_type: &str, data: &[u8]) -> String {
        format!("data:{mime_type};base64,{}", BASE64.encode(data))
    }

    fn manifest_bytes() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "format": "kataru-character",
            "version": 1,
            "exportedAt": 1_700_000_000_000_i64,
            "generator": "Kataru/0.0.0-test",
            "assets": [],
        }))
        .expect("serialize manifest")
    }

    fn asset_entry(data: &[u8], extension: &str) -> (String, Vec<u8>) {
        (
            format!("assets/{}.{extension}", sha256_hex(data)),
            data.to_vec(),
        )
    }

    fn write_package(entries: Vec<(String, Vec<u8>)>) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in entries {
            writer
                .start_file(name, SimpleFileOptions::default())
                .expect("start entry");
            writer.write_all(&data).expect("write entry");
        }
        writer.finish().expect("finish package").into_inner()
    }

    fn package_of(character: &Value, assets: Vec<(String, Vec<u8>)>) -> Vec<u8> {
        let mut entries = vec![
            ("manifest.json".to_owned(), manifest_bytes()),
            (
                "character.json".to_owned(),
                serde_json::to_vec(character).expect("serialize character"),
            ),
        ];
        entries.extend(assets);
        write_package(entries)
    }

    fn zip_names(bytes: &[u8]) -> Vec<String> {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("open package");
        (0..archive.len())
            .map(|index| {
                archive
                    .by_index(index)
                    .expect("read entry name")
                    .name()
                    .to_owned()
            })
            .collect()
    }

    fn zip_entry(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("open package");
        let mut entry = archive.by_name(name).ok()?;
        let mut data = Vec::new();
        entry.read_to_end(&mut data).expect("read entry");
        Some(data)
    }

    fn vrm_avatar(vrm_id: &str, vrma_id: &str) -> Value {
        json!({
            "source": format!("asset:{vrm_id}"),
            "framing": { "scale": 1, "offsetY": 0, "rotation": 0 },
            "expressionMap": { "smile": "happy" },
            "animations": [{ "name": "wave", "source": format!("asset:{vrma_id}") }],
            "idleAnimation": "wave",
        })
    }

    /// put_character が受理する実データURLを持つキャラクター。
    fn rich_character() -> Value {
        json!({
            "id": "character-1",
            "name": "Alice",
            "systemPrompt": "You are Alice.",
            "model": { "model": "z-ai/glm-5.2", "connectionId": "openrouter" },
            "speechStyle": "gentle",
            "icon": data_url("image/png", &png_bytes("icon")),
            "maxCharacters": 400,
            "temperature": 0.8,
            "enableMemory": true,
            "expressions": [
                { "name": "neutral", "image": data_url("image/png", &png_bytes("neutral")) },
                { "name": "happy", "image": data_url("image/jpeg", &jpeg_bytes("happy")) },
            ],
            "costumes": [
                {
                    "name": "default",
                    "image": data_url("image/png", &png_bytes("costume")),
                    "expressions": [
                        { "name": "neutral", "image": data_url("image/png", &png_bytes("costume-neutral")) },
                    ],
                },
                {
                    "name": "3d",
                    "kind": "vrm",
                    "image": data_url("image/png", &png_bytes("costume-3d")),
                    "promptDetail": "3d model",
                    "vrm": {
                        "source": data_url("model/gltf-binary", &vrm_bytes()),
                        "framing": { "scale": 1, "offsetY": 0, "rotation": 0 },
                        "expressionMap": { "smile": "happy" },
                        "animations": [
                            { "name": "wave", "source": data_url("application/x-vrma", &vrma_bytes()) },
                        ],
                        "idleAnimation": "wave",
                    },
                },
            ],
            "favorite": true,
            "enableThinking": true,
            "createdAt": 1,
            "updatedAt": 1,
        })
    }

    fn simple_shared_character() -> Value {
        json!({ "name": "Alice", "systemPrompt": "hi", "model": "vendor/model" })
    }

    fn assert_bad_request<T>(result: AppResult<T>, context: &str) {
        assert!(
            matches!(result, Err(AppError::BadRequest(_))),
            "expected BadRequest for {context}"
        );
    }

    #[test]
    fn exported_package_imports_into_a_fresh_database() {
        let mut source_db = open_test_database();
        put_character(&mut source_db, rich_character()).expect("store source character");
        let package = build_character_package(
            &source_db,
            "character-1",
            true,
            &id_set(&["openrouter", "anthropic"]),
            "openrouter",
        )
        .expect("build package");

        // character.json は共有フィールドだけを持ち、バイナリはZIP内ファイルになる。
        let shared: Value = serde_json::from_slice(
            &zip_entry(&package, "character.json").expect("read character entry"),
        )
        .expect("parse shared character");
        for key in ["id", "createdAt", "updatedAt", "favorite", "enableThinking"] {
            assert!(shared.get(key).is_none(), "shared must not contain {key}");
        }
        assert_eq!(
            shared["model"],
            json!({ "model": "z-ai/glm-5.2", "connectionId": "openrouter" })
        );
        assert!(
            shared["icon"]
                .as_str()
                .expect("icon")
                .starts_with(ASSET_REFERENCE_PREFIX)
        );
        let names = zip_names(&package);
        assert_eq!(names[0], "manifest.json");
        assert_eq!(names[1], "character.json");
        assert_eq!(names.len(), 2 + 8);
        assert!(names.iter().any(|name| name.ends_with(".jpg")));
        assert!(names.iter().any(|name| name.ends_with(".vrm")));
        assert!(names.iter().any(|name| name.ends_with(".vrma")));

        let manifest: Value = serde_json::from_slice(
            &zip_entry(&package, "manifest.json").expect("read manifest entry"),
        )
        .expect("parse manifest");
        assert_eq!(manifest["format"], "kataru-character");
        assert_eq!(manifest["version"], 1);
        assert!(
            manifest["generator"]
                .as_str()
                .expect("generator")
                .starts_with("Kataru/")
        );
        let assets = manifest["assets"].as_array().expect("manifest assets");
        assert_eq!(assets.len(), 8);
        for entry in assets {
            let path = entry["path"].as_str().expect("asset path");
            assert!(path.starts_with("assets/"));
            assert_eq!(
                path,
                format!(
                    "assets/{}.{}",
                    entry["sha256"].as_str().expect("sha"),
                    extension_for_mime(entry["mime"].as_str().expect("mime")).expect("extension")
                )
            );
            assert!(entry["size"].as_u64().expect("size") > 0);
        }

        let mut target_db = open_test_database();
        let stored = import_character_package(
            &mut target_db,
            &package,
            "fallback/model",
            "openrouter",
            &id_set(&["openrouter", "anthropic"]),
        )
        .expect("import package");
        // 返り値は asset: 参照を持つ保存済みキャラクター。
        assert!(
            stored["icon"]
                .as_str()
                .expect("stored icon")
                .starts_with(ASSET_REFERENCE_PREFIX)
        );
        let imported_id = stored["id"].as_str().expect("imported id").to_owned();
        assert_ne!(imported_id, "character-1");

        // 画像・モデルを含めて同じ内容で復元される。
        let mut expected = get_character_with_images(&source_db, "character-1")
            .expect("read source")
            .expect("source character");
        let mut actual = get_character_with_images(&target_db, &imported_id)
            .expect("read target")
            .expect("imported character");
        for key in ["id", "createdAt", "updatedAt", "favorite", "enableThinking"] {
            expected.as_object_mut().expect("object").remove(key);
            actual.as_object_mut().expect("object").remove(key);
        }
        assert_eq!(actual, expected);

        let asset_count = |db: &Connection| {
            db.query_row("SELECT COUNT(*) FROM image_assets", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count assets")
        };
        assert_eq!(asset_count(&target_db), asset_count(&source_db));
    }

    #[test]
    fn export_without_vrm_downgrades_vrm_costumes_to_image_costumes() {
        let mut source_db = open_test_database();
        put_character(&mut source_db, rich_character()).expect("store source character");
        let package = build_character_package(
            &source_db,
            "character-1",
            false,
            &id_set(&["openrouter"]),
            "openrouter",
        )
        .expect("build package without vrm");

        let names = zip_names(&package);
        assert!(!names.iter().any(|name| name.ends_with(".vrm")));
        assert!(!names.iter().any(|name| name.ends_with(".vrma")));
        let shared: Value = serde_json::from_slice(
            &zip_entry(&package, "character.json").expect("read character entry"),
        )
        .expect("parse shared character");
        let downgraded = &shared["costumes"][1];
        assert_eq!(downgraded["name"], "3d");
        assert_eq!(downgraded["kind"], "image");
        assert_eq!(downgraded["promptDetail"], "3d model");
        assert!(
            downgraded["image"]
                .as_str()
                .expect("image")
                .starts_with(ASSET_REFERENCE_PREFIX)
        );
        assert!(downgraded.get("vrm").is_none());
        assert!(downgraded.get("expressions").is_none());

        let preview = inspect_character_package(&package).expect("inspect downgraded");
        assert!(!preview.has_vrm);

        let mut target_db = open_test_database();
        let stored = import_character_package(
            &mut target_db,
            &package,
            "fallback/model",
            "openrouter",
            &id_set(&["openrouter"]),
        )
        .expect("import downgraded package");
        assert_eq!(stored["costumes"][1]["kind"], "image");
        assert!(stored["costumes"][1].get("vrm").is_none());
    }

    #[test]
    fn export_rewrites_model_connection_ids() {
        let mut db = open_test_database();
        for (id, model) in [
            (
                "custom",
                json!({ "model": "acme/llm", "connectionId": "cx_123" }),
            ),
            (
                "builtin",
                json!({ "model": "acme/llm", "connectionId": "anthropic" }),
            ),
            (
                "legacy",
                json!({ "model": "acme/llm", "aiApiType": "anthropic" }),
            ),
            ("string", json!("acme/llm")),
        ] {
            put_character(
                &mut db,
                json!({ "id": id, "name": "N", "systemPrompt": "s", "model": model, "updatedAt": 1 }),
            )
            .expect("store character");
        }
        let builtin = id_set(&["openrouter", "anthropic"]);

        let shared_of = |character_id: &str| {
            let package = build_character_package(&db, character_id, true, &builtin, "openrouter")
                .expect("build package");
            let entry = zip_entry(&package, "character.json").expect("character entry");
            serde_json::from_slice::<Value>(&entry).expect("parse shared")
        };

        // カスタム接続IDはモデル名だけに落とす。
        assert_eq!(shared_of("custom")["model"], "acme/llm");
        // 組み込み接続IDは {model, connectionId} のまま残す。
        assert_eq!(
            shared_of("builtin")["model"],
            json!({ "model": "acme/llm", "connectionId": "anthropic" })
        );
        // 旧形式の aiApiType は connectionId として読み替える。
        assert_eq!(
            shared_of("legacy")["model"],
            json!({ "model": "acme/llm", "connectionId": "anthropic" })
        );
        // 文字列モデルはフォールバック接続を付けた上で組み込み判定する。
        assert_eq!(
            shared_of("string")["model"],
            json!({ "model": "acme/llm", "connectionId": "openrouter" })
        );
    }

    #[test]
    fn package_parsing_rejects_entries_outside_the_layout() {
        let character = simple_shared_character();
        for name in [
            "evil.txt",
            "../evil.png",
            "assets/../x.png",
            "assetsx/x.png",
            "assets/x.png",
            "assets/sub/x.png",
            "assets/Abcd.png",
            "Manifest.json",
        ] {
            let package = package_of(&character, vec![(name.to_owned(), b"x".to_vec())]);
            assert_bad_request(parse_package(&package), name);
        }
        // stem が64桁小文字hexでない（大文字を含む）名前も拒否する。
        let package = package_of(
            &character,
            vec![(format!("assets/{}.png", "A".repeat(64)), b"x".to_vec())],
        );
        assert_bad_request(parse_package(&package), "uppercase stem");
        // ただし "/" で終わるディレクトリエントリはスキップする。
        let package = package_of(
            &character,
            vec![
                ("assets/".to_owned(), Vec::new()),
                ("dir/".to_owned(), Vec::new()),
            ],
        );
        parse_package(&package).expect("directory entries are skipped");
    }

    #[test]
    fn package_parsing_rejects_tampered_or_missing_files() {
        // ファイル名の stem と内容のハッシュが一致しない。
        let package = package_of(
            &simple_shared_character(),
            vec![(
                format!("assets/{}.png", sha256_hex(b"other")),
                png_bytes("actual"),
            )],
        );
        assert_bad_request(parse_package(&package), "sha mismatch");

        // 参照されているファイルが同梱されていない。
        let missing = "0".repeat(64);
        let package = package_of(
            &json!({ "name": "N", "systemPrompt": "s", "icon": format!("asset:{missing}") }),
            vec![],
        );
        assert_bad_request(parse_package(&package), "missing referenced asset");

        // SVGなど画像マジックバイトを持たないファイルは拒否する。
        let package = package_of(
            &simple_shared_character(),
            vec![asset_entry(
                b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
                "png",
            )],
        );
        assert_bad_request(parse_package(&package), "svg bytes");

        // 拡張子と内容が一致しない。
        let package = package_of(
            &simple_shared_character(),
            vec![asset_entry(&png_bytes("p"), "jpg")],
        );
        assert_bad_request(parse_package(&package), "extension/content mismatch");

        // 画像上限（20MiB）を超えるエントリ。
        let oversized = {
            let mut data = b"\x89PNG\r\n\x1a\n".to_vec();
            data.resize(20 * 1024 * 1024 + 1, 0);
            data
        };
        let package = package_of(
            &simple_shared_character(),
            vec![asset_entry(&oversized, "png")],
        );
        assert_bad_request(parse_package(&package), "oversized entry");

        // 外部リソースを参照するVRM。
        let package = package_of(
            &simple_shared_character(),
            vec![asset_entry(
                &model_data(
                    json!({ "extensions": { "VRMC_vrm": {} }, "buffers": [{ "uri": "https://example.com/a.bin" }] }),
                ),
                "vrm",
            )],
        );
        assert_bad_request(parse_package(&package), "vrm with external uri");
    }

    #[test]
    fn package_parsing_rejects_malformed_packages() {
        let character = simple_shared_character();
        assert_bad_request(parse_package(b"not a zip"), "not a zip");

        // manifest.json / character.json が無い。
        assert_bad_request(
            parse_package(&write_package(vec![(
                "character.json".to_owned(),
                serde_json::to_vec(&character).expect("serialize"),
            )])),
            "missing manifest",
        );
        assert_bad_request(
            parse_package(&write_package(vec![(
                "manifest.json".to_owned(),
                manifest_bytes(),
            )])),
            "missing character",
        );

        // エントリ重複。ZipWriterは同名を拒否するため、書き出し後に
        // 中央ディレクトリ側の名前だけを同じ長さで書き換えて作る。
        let mut duplicated = write_package(vec![
            ("manifest.json".to_owned(), manifest_bytes()),
            ("manifest2json".to_owned(), b"duplicate".to_vec()),
            (
                "character.json".to_owned(),
                serde_json::to_vec(&character).expect("serialize"),
            ),
        ]);
        let needle = b"manifest2json";
        let position = duplicated
            .windows(needle.len())
            .rposition(|window| window == needle)
            .expect("central directory filename");
        duplicated[position..position + needle.len()].copy_from_slice(b"manifest.json");
        assert_bad_request(parse_package(&duplicated), "duplicate names");

        // エントリ数上限（64）。
        let mut entries = vec![
            ("manifest.json".to_owned(), manifest_bytes()),
            (
                "character.json".to_owned(),
                serde_json::to_vec(&character).expect("serialize"),
            ),
        ];
        for index in 0..63_u32 {
            entries.push((format!("assets/{index:064x}.png"), png_bytes("a")));
        }
        assert_bad_request(parse_package(&write_package(entries)), "too many entries");

        // マニフェストの format/version が合わない。
        for manifest in [
            json!({ "format": "other", "version": 1 }),
            json!({ "format": "kataru-character", "version": 2 }),
            json!({ "version": 1 }),
        ] {
            let package = write_package(vec![
                (
                    "manifest.json".to_owned(),
                    serde_json::to_vec(&manifest).expect("serialize"),
                ),
                (
                    "character.json".to_owned(),
                    serde_json::to_vec(&character).expect("serialize"),
                ),
            ]);
            assert_bad_request(parse_package(&package), "bad manifest");
        }

        // character.json の必須フィールドが不正。
        for invalid in [
            json!("not an object"),
            json!({ "systemPrompt": "s" }),
            json!({ "name": "  ", "systemPrompt": "s" }),
            json!({ "name": "N" }),
        ] {
            let package = package_of(&invalid, vec![]);
            assert_bad_request(parse_package(&package), "bad character.json");
        }
    }

    #[test]
    fn unreferenced_files_are_validated_but_not_imported() {
        let icon = png_bytes("icon");
        let icon_id = sha256_hex(&icon);
        let character = json!({
            "name": "N",
            "systemPrompt": "s",
            "icon": format!("asset:{icon_id}"),
        });
        let package = package_of(
            &character,
            vec![
                asset_entry(&icon, "png"),
                asset_entry(&png_bytes("unreferenced"), "png"),
            ],
        );

        // 未参照ファイルを含んでも検査・インポートは通り、参照分だけ保存される。
        let preview = inspect_character_package(&package).expect("inspect");
        assert_eq!(preview.asset_count, 1);
        let mut db = open_test_database();
        import_character_package(
            &mut db,
            &package,
            "fallback/model",
            "openrouter",
            &id_set(&["openrouter"]),
        )
        .expect("import");
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM image_assets", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count assets"),
            1
        );
    }

    #[test]
    fn import_normalizes_model_and_repairs_unknown_connection_ids() {
        let mut db = open_test_database();
        let known = id_set(&["openrouter", "anthropic"]);
        let mut import_model = |character: &Value| {
            let package = package_of(character, vec![]);
            import_character_package(&mut db, &package, "fallback/model", "openrouter", &known)
                .expect("import")["model"]
                .clone()
        };

        // 既知の組み込み接続はそのまま。
        assert_eq!(
            import_model(
                &json!({ "name": "N", "systemPrompt": "s", "model": { "model": "x", "connectionId": "anthropic" } })
            ),
            json!({ "model": "x", "connectionId": "anthropic" })
        );
        // 未知の接続IDはフォールバックに置き換える。
        assert_eq!(
            import_model(
                &json!({ "name": "N", "systemPrompt": "s", "model": { "model": "x", "connectionId": "cx_gone" } })
            ),
            json!({ "model": "x", "connectionId": "openrouter" })
        );
        // 文字列モデルはフォールバック接続を使う。
        assert_eq!(
            import_model(&json!({ "name": "N", "systemPrompt": "s", "model": "vendor/x" })),
            json!({ "model": "vendor/x", "connectionId": "openrouter" })
        );
        // 旧形式の aiApiType を読み替え、既知なら残る。
        assert_eq!(
            import_model(
                &json!({ "name": "N", "systemPrompt": "s", "model": { "model": "x", "aiApiType": "anthropic" } })
            ),
            json!({ "model": "x", "connectionId": "anthropic" })
        );
        // 空のモデル名にはフォールバックモデルを使う。
        assert_eq!(
            import_model(
                &json!({ "name": "N", "systemPrompt": "s", "model": { "model": " ", "connectionId": "anthropic" } })
            ),
            json!({ "model": "fallback/model", "connectionId": "anthropic" })
        );
        // model 自体が無くてもフォールバックに落ちる。
        assert_eq!(
            import_model(&json!({ "name": "N", "systemPrompt": "s" })),
            json!({ "model": "fallback/model", "connectionId": "openrouter" })
        );
    }

    #[test]
    fn import_stores_assets_and_validates_references_through_upsert() {
        let icon = png_bytes("icon");
        let icon_id = sha256_hex(&icon);
        let vrm = vrm_bytes();
        let vrm_id = sha256_hex(&vrm);
        let vrma = vrma_bytes();
        let vrma_id = sha256_hex(&vrma);
        let character = json!({
            "name": "A",
            "systemPrompt": "s",
            "icon": format!("asset:{icon_id}"),
            "costumes": [{
                "name": "3d",
                "kind": "vrm",
                "image": format!("asset:{icon_id}"),
                "vrm": vrm_avatar(&vrm_id, &vrma_id),
            }],
        });
        let package = package_of(
            &character,
            vec![
                asset_entry(&icon, "png"),
                asset_entry(&vrm, "vrm"),
                asset_entry(&vrma, "vrma"),
            ],
        );
        let mut db = open_test_database();
        let stored = import_character_package(
            &mut db,
            &package,
            "fallback/model",
            "openrouter",
            &id_set(&["openrouter"]),
        )
        .expect("import vrm package");
        assert_eq!(
            stored["costumes"][0]["vrm"]["source"],
            format!("asset:{vrm_id}")
        );
        // MIMEの異なるアセットを画像フィールドに置くと upsert_character が拒否する。
        let bad_character = json!({
            "name": "B",
            "systemPrompt": "s",
            "icon": format!("asset:{vrm_id}"),
        });
        let bad_package = package_of(&bad_character, vec![asset_entry(&vrm, "vrm")]);
        assert_bad_request(
            import_character_package(
                &mut db,
                &bad_package,
                "fallback/model",
                "openrouter",
                &id_set(&["openrouter"]),
            ),
            "vrm asset in image field",
        );
    }

    #[test]
    fn inspect_reports_preview_priority_and_package_facts() {
        let icon = png_bytes("icon");
        let neutral = png_bytes("neutral");
        let costume_image = png_bytes("costume");
        let costume_neutral = png_bytes("costume-neutral");
        let id_of = sha256_hex;

        // 優先順位: default衣装のneutral表情 > default衣装の画像 > トップレベルneutral > icon。
        let make_package = |character: &Value, files: Vec<&Vec<u8>>| {
            package_of(
                character,
                files
                    .into_iter()
                    .map(|data| asset_entry(data, "png"))
                    .collect(),
            )
        };
        let full = json!({
            "name": "Alice",
            "systemPrompt": "s",
            "icon": format!("asset:{}", id_of(&icon)),
            "expressions": [{ "name": "neutral", "image": format!("asset:{}", id_of(&neutral)) }],
            "costumes": [{
                "name": " default ",
                "image": format!("asset:{}", id_of(&costume_image)),
                "expressions": [{ "name": "NEUTRAL", "image": format!("asset:{}", id_of(&costume_neutral)) }],
            }],
        });
        let package = make_package(
            &full,
            vec![&icon, &neutral, &costume_image, &costume_neutral],
        );
        let preview = inspect_character_package(&package).expect("inspect full");
        assert_eq!(preview.name, "Alice");
        assert_eq!(preview.exported_at, 1_700_000_000_000);
        assert_eq!(preview.asset_count, 4);
        assert!(!preview.has_vrm);
        assert_eq!(
            preview.preview_image.expect("preview"),
            format!("data:image/png;base64,{}", BASE64.encode(&costume_neutral))
        );

        // default衣装にneutral表情がなければ衣装画像。
        let costume_only = json!({
            "name": "A",
            "systemPrompt": "s",
            "icon": format!("asset:{}", id_of(&icon)),
            "costumes": [{ "name": "default", "image": format!("asset:{}", id_of(&costume_image)) }],
        });
        let package = make_package(&costume_only, vec![&icon, &costume_image]);
        assert_eq!(
            inspect_character_package(&package)
                .expect("inspect costume")
                .preview_image
                .expect("preview"),
            format!("data:image/png;base64,{}", BASE64.encode(&costume_image))
        );

        // default衣装がなければトップレベルのneutral表情。
        let neutral_only = json!({
            "name": "A",
            "systemPrompt": "s",
            "icon": format!("asset:{}", id_of(&icon)),
            "expressions": [{ "name": "neutral", "image": format!("asset:{}", id_of(&neutral)) }],
        });
        let package = make_package(&neutral_only, vec![&icon, &neutral]);
        assert_eq!(
            inspect_character_package(&package)
                .expect("inspect neutral")
                .preview_image
                .expect("preview"),
            format!("data:image/png;base64,{}", BASE64.encode(&neutral))
        );

        // どれも無ければicon、それも無ければnull。
        let icon_only = json!({
            "name": "A",
            "systemPrompt": "s",
            "icon": format!("asset:{}", id_of(&icon)),
        });
        let package = make_package(&icon_only, vec![&icon]);
        assert_eq!(
            inspect_character_package(&package)
                .expect("inspect icon")
                .preview_image
                .expect("preview"),
            format!("data:image/png;base64,{}", BASE64.encode(&icon))
        );
        assert!(
            inspect_character_package(&package_of(&simple_shared_character(), vec![]))
                .expect("inspect none")
                .preview_image
                .is_none()
        );

        // VRM衣装を含むパッケージは hasVrm=true。
        let vrm = vrm_bytes();
        let vrma = vrma_bytes();
        let vrm_character = json!({
            "name": "A",
            "systemPrompt": "s",
            "costumes": [{
                "name": "3d",
                "kind": "vrm",
                "image": format!("asset:{}", id_of(&icon)),
                "vrm": vrm_avatar(&id_of(&vrm), &id_of(&vrma)),
            }],
        });
        let package = package_of(
            &vrm_character,
            vec![
                asset_entry(&icon, "png"),
                asset_entry(&vrm, "vrm"),
                asset_entry(&vrma, "vrma"),
            ],
        );
        let preview = inspect_character_package(&package).expect("inspect vrm");
        assert!(preview.has_vrm);
        assert_eq!(preview.asset_count, 3);
    }

    #[test]
    fn package_parsing_rejects_malformed_shared_character_fields() {
        // 配列以外の costumes / expressions や型違いのフィールドはそのまま
        // 保存されると設定画面の .find() 等が落ちるため、取り込み前に拒否する。
        for character in [
            json!({ "name": "N", "systemPrompt": "s", "costumes": "not-an-array" }),
            json!({ "name": "N", "systemPrompt": "s", "costumes": { "0": {} } }),
            json!({ "name": "N", "systemPrompt": "s", "expressions": "neutral" }),
            json!({ "name": "N", "systemPrompt": "s", "costumes": ["default"] }),
            json!({ "name": "N", "systemPrompt": "s", "costumes": [{ "name": 42, "image": "i" }] }),
            json!({ "name": "N", "systemPrompt": "s", "costumes": [{ "name": "c" }] }),
            json!({ "name": "N", "systemPrompt": "s", "costumes": [{ "name": "c", "image": "i", "kind": "audio" }] }),
            // kind が "vrm" でないのに vrm を保持、または "vrm" なのに vrm が無い。
            json!({ "name": "N", "systemPrompt": "s", "costumes": [{ "name": "c", "image": "i", "vrm": {} }] }),
            json!({ "name": "N", "systemPrompt": "s", "costumes": [{ "name": "c", "image": "i", "kind": "vrm" }] }),
            json!({ "name": "N", "systemPrompt": "s", "expressions": [{ "name": "n" }] }),
            json!({ "name": "N", "systemPrompt": "s", "expressions": [{ "name": "n", "image": "i", "promptDetail": 1 }] }),
            json!({ "name": "N", "systemPrompt": "s", "temperature": "hot" }),
            json!({ "name": "N", "systemPrompt": "s", "maxCharacters": "400" }),
            json!({ "name": "N", "systemPrompt": "s", "enableMemory": "yes" }),
            json!({ "name": "N", "systemPrompt": "s", "icon": 3 }),
            json!({ "name": "N", "systemPrompt": "s", "model": 7 }),
        ] {
            let package = package_of(&character, vec![]);
            assert_bad_request(parse_package(&package), "malformed shared fields");
        }

        // VRMアバターの構造（framing・expressionMap・モーション・idle整合）も検査する。
        let icon = png_bytes("icon");
        let icon_id = sha256_hex(&icon);
        for avatar in [
            json!({ "source": format!("asset:{icon_id}") }),
            json!({ "source": format!("asset:{icon_id}"), "framing": "fit", "expressionMap": {} }),
            json!({ "source": format!("asset:{icon_id}"), "framing": { "scale": 9, "offsetY": 0, "rotation": 0 }, "expressionMap": {} }),
            json!({ "source": format!("asset:{icon_id}"), "framing": { "scale": 1, "offsetY": 0, "rotation": 0 }, "expressionMap": { "": "x" } }),
            json!({ "source": format!("asset:{icon_id}"), "framing": { "scale": 1, "offsetY": 0, "rotation": 0 }, "expressionMap": {},
                "animations": [{ "name": "none", "source": format!("asset:{icon_id}") }] }),
            json!({ "source": format!("asset:{icon_id}"), "framing": { "scale": 1, "offsetY": 0, "rotation": 0 }, "expressionMap": {},
                "animations": [{ "name": "wave", "source": "https://example.com/a.vrma" }] }),
            json!({ "source": format!("asset:{icon_id}"), "framing": { "scale": 1, "offsetY": 0, "rotation": 0 }, "expressionMap": {},
                "idleAnimation": "missing" }),
            json!({ "source": "https://example.com/a.vrm", "framing": { "scale": 1, "offsetY": 0, "rotation": 0 }, "expressionMap": {} }),
        ] {
            let character = json!({
                "name": "N",
                "systemPrompt": "s",
                "costumes": [{
                    "name": "3d", "kind": "vrm",
                    "image": format!("asset:{icon_id}"),
                    "vrm": avatar,
                }],
            });
            let package = package_of(&character, vec![asset_entry(&icon, "png")]);
            assert_bad_request(parse_package(&package), "malformed vrm avatar");
        }

        // 妥当なフィールドは従来どおり受理する。
        let valid = json!({
            "name": "N",
            "systemPrompt": "s",
            "model": { "model": "x", "connectionId": "openrouter" },
            "icon": format!("asset:{icon_id}"),
            "temperature": 0.8,
            "enableMemory": true,
            "expressions": [{ "name": "neutral", "image": format!("asset:{icon_id}") }],
            "costumes": [{ "name": "default", "kind": "image", "image": format!("asset:{icon_id}") }],
        });
        parse_package(&package_of(&valid, vec![asset_entry(&icon, "png")]))
            .expect("valid shared character");
    }

    #[test]
    fn export_enforces_the_same_limits_as_import() {
        let mut db = open_test_database();
        // manifest+character と合わせて64エントリに収まるのは62アセットまで。
        // 63個は書き出しても再インポートできないため、書き出し時点で拒否する。
        let expressions =
            |count: usize| -> Value {
                json!((0..count)
                .map(|index| {
                    json!({
                        "name": format!("e{index}"),
                        "image": data_url("image/png", &png_bytes(&format!("asset-{index}"))),
                    })
                })
                .collect::<Vec<_>>())
            };
        put_character(
            &mut db,
            json!({ "id": "fits", "name": "N", "systemPrompt": "s", "updatedAt": 1,
                "expressions": expressions(62) }),
        )
        .expect("store 62-asset character");
        let package = build_character_package(&db, "fits", true, &id_set(&[]), "openrouter")
            .expect("62 assets must fit");
        assert_eq!(zip_names(&package).len(), MAX_PACKAGE_ENTRIES);
        parse_package(&package).expect("62-asset package reimports");

        put_character(
            &mut db,
            json!({ "id": "overflow", "name": "N", "systemPrompt": "s", "updatedAt": 1,
                "expressions": expressions(63) }),
        )
        .expect("store 63-asset character");
        assert_bad_request(
            build_character_package(&db, "overflow", true, &id_set(&[]), "openrouter"),
            "63 assets exceed the entry limit",
        );

        // 保存側にサイズ上限がないため、20MiBを超える画像アセットも同様に拒否する。
        let oversized = {
            let mut data = b"\x89PNG\r\n\x1a\n".to_vec();
            data.resize(MAX_IMAGE_ENTRY_BYTES as usize + 1, 0);
            data
        };
        let asset_id = store_asset(&db, "image/png", &oversized).expect("store oversized image");
        put_character(
            &mut db,
            json!({ "id": "huge", "name": "N", "systemPrompt": "s", "updatedAt": 1,
                "icon": format!("asset:{asset_id}") }),
        )
        .expect("store oversized icon");
        assert_bad_request(
            build_character_package(&db, "huge", true, &id_set(&[]), "openrouter"),
            "oversized image asset",
        );
    }

    #[test]
    fn export_normalizes_stored_mime_by_content() {
        let mut db = open_test_database();
        // 形式検証の導入前に保存された画像を想定。MIMEが未知でも実体がPNGなら
        // 検出結果で書き出し、再インポートできる。
        let data = png_bytes("legacy");
        let asset_id = store_asset(&db, "image/avif", &data).expect("store legacy asset");
        put_character(
            &mut db,
            json!({ "id": "c", "name": "N", "systemPrompt": "s", "updatedAt": 1,
                "icon": format!("asset:{asset_id}") }),
        )
        .expect("store character");
        let package = build_character_package(&db, "c", true, &id_set(&[]), "openrouter")
            .expect("build package");
        let names = zip_names(&package);
        assert!(names.iter().any(|name| name.ends_with(".png")));
        let manifest: Value =
            serde_json::from_slice(&zip_entry(&package, "manifest.json").expect("manifest"))
                .expect("parse manifest");
        assert_eq!(manifest["assets"][0]["mime"], "image/png");

        let mut target = open_test_database();
        import_character_package(&mut target, &package, "f", "openrouter", &id_set(&[]))
            .expect("import normalized package");
    }
}
