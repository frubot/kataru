mod storage;

use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use rusqlite::{
    Connection, ErrorCode, OptionalExtension,
    backup::{Backup, StepResult},
};

use crate::error::{AppError, AppResult};

pub use storage::{
    handle_storage_command, migrate_character_images, migrate_situation_images,
    persist_conversation_result, persist_conversation_submission,
};

const INITIAL_MIGRATION: &str = include_str!("../../migrations/0001_initial.sql");
const IMAGE_ASSET_MIGRATION: &str = include_str!("../../migrations/0002_image_assets.sql");
const SITUATION_IMAGE_ASSET_MIGRATION: &str =
    include_str!("../../migrations/0003_situation_image_assets.sql");
pub const CURRENT_SCHEMA_VERSION: i64 = 3;

// 自動バックアップはDBと同じデータディレクトリ内に5世代だけ保持する。
// ファイル名のUnixミリ秒と連番で、同一ミリ秒の起動でも世代を上書きしない。
const BACKUP_DIRECTORY_NAME: &str = "kataru-backups";
const BACKUP_FILE_PREFIX: &str = "kataru-auto-";
const BACKUP_FILE_EXTENSION: &str = ".db";
const BACKUP_RETENTION_COUNT: usize = 5;
const BACKUP_PAGES_PER_STEP: i32 = 100;
const BACKUP_BUSY_LOCKED_RETRY_LIMIT: usize = 8;
const BACKUP_RETRY_DELAY: Duration = Duration::from_millis(25);
const BACKUP_MAX_DURATION: Duration = Duration::from_secs(5 * 60);

pub struct ImageAsset {
    pub mime_type: String,
    pub data: Vec<u8>,
}

#[derive(Clone)]
pub struct Database {
    inner: Arc<Mutex<Connection>>,
    path: Arc<PathBuf>,
}

impl Database {
    pub fn open(path: &Path) -> AppResult<Self> {
        let should_backup = is_existing_database(path)?;
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        if should_backup {
            create_startup_backup(&connection, path)?;
        }
        let transaction = connection.transaction()?;
        transaction.execute_batch(INITIAL_MIGRATION)?;
        transaction.execute_batch(IMAGE_ASSET_MIGRATION)?;
        transaction.execute_batch(SITUATION_IMAGE_ASSET_MIGRATION)?;
        migrate_character_images(&transaction)?;
        migrate_situation_images(&transaction)?;
        transaction.commit()?;
        Ok(Self {
            inner: Arc::new(Mutex::new(connection)),
            path: Arc::new(path.to_path_buf()),
        })
    }

    pub fn path(&self) -> &Path {
        self.path.as_path()
    }

    pub async fn call<T, F>(&self, operation: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> AppResult<T> + Send + 'static,
    {
        let connection = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = connection
                .lock()
                .map_err(|_| AppError::Internal("SQLiteロックが破損しました。".to_owned()))?;
            operation(&mut connection)
        })
        .await
        .map_err(|error| AppError::Internal(format!("SQLiteタスクが失敗しました: {error}")))?
    }

    pub async fn get_image_asset(&self, asset_id: String) -> AppResult<Option<ImageAsset>> {
        self.call(move |connection| {
            connection
                .query_row(
                    "SELECT mime_type, data FROM image_assets WHERE id = ?1",
                    rusqlite::params![asset_id],
                    |row| {
                        Ok(ImageAsset {
                            mime_type: row.get(0)?,
                            data: row.get(1)?,
                        })
                    },
                )
                .optional()
                .map_err(AppError::from)
        })
        .await
    }
}

fn is_existing_database(path: &Path) -> AppResult<bool> {
    if path == Path::new(":memory:") {
        return Ok(false);
    }

    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.is_file() && metadata.len() > 0),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn backup_directory(database_path: &Path) -> PathBuf {
    database_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .join(BACKUP_DIRECTORY_NAME)
}

fn create_startup_backup(connection: &Connection, database_path: &Path) -> AppResult<()> {
    create_startup_backup_with_pruner(connection, database_path, prune_old_backups)
}

fn create_startup_backup_with_pruner<P>(
    connection: &Connection,
    database_path: &Path,
    prune: P,
) -> AppResult<()>
where
    P: FnOnce(&Path) -> AppResult<()>,
{
    let directory = backup_directory(database_path);
    fs::create_dir_all(&directory)?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            AppError::Internal(format!("バックアップ時刻を取得できませんでした: {error}"))
        })?
        .as_millis();
    let (temporary_path, backup_path) = reserve_backup_path(&directory, timestamp)?;

    let result = (|| {
        // sqlite3_backup APIはWALを含む接続の一貫したスナップショットを取得する。
        backup_connection_to_path(connection, &temporary_path)?;
        validate_backup(&temporary_path)?;
        if backup_path.exists() {
            return Err(AppError::Internal(format!(
                "バックアップ先が既に存在します: {}",
                backup_path.display()
            )));
        }
        fs::rename(&temporary_path, &backup_path)?;
        if let Err(error) = prune(&directory) {
            tracing::warn!(
                backup_directory = %directory.display(),
                %error,
                "自動バックアップの世代整理に失敗しました。次回起動時に再試行します。"
            );
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn backup_connection_to_path(source: &Connection, destination_path: &Path) -> AppResult<()> {
    let mut destination = Connection::open(destination_path)?;
    let mut initialization_retries = 0;
    let backup = loop {
        match Backup::new(source, &mut destination) {
            Ok(backup) => break backup,
            Err(error)
                if is_retryable_sqlite_error(&error)
                    && initialization_retries < BACKUP_BUSY_LOCKED_RETRY_LIMIT =>
            {
                initialization_retries += 1;
                std::thread::sleep(BACKUP_RETRY_DELAY);
            }
            Err(error) => return Err(error.into()),
        }
    };

    run_backup_steps(|| backup.step(BACKUP_PAGES_PER_STEP))
}

fn is_retryable_sqlite_error(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy) | Some(ErrorCode::DatabaseLocked)
    )
}

fn run_backup_steps<F>(mut step: F) -> AppResult<()>
where
    F: FnMut() -> rusqlite::Result<StepResult>,
{
    let started_at = Instant::now();
    run_backup_steps_with_clock(&mut step, || started_at.elapsed(), std::thread::sleep)
}

fn run_backup_steps_with_clock<F, C, S>(mut step: F, mut elapsed: C, mut sleep: S) -> AppResult<()>
where
    F: FnMut() -> rusqlite::Result<StepResult>,
    C: FnMut() -> Duration,
    S: FnMut(Duration),
{
    let mut busy_locked_retries = 0;
    loop {
        match step()? {
            StepResult::Done => return Ok(()),
            StepResult::More => {
                if elapsed() >= BACKUP_MAX_DURATION {
                    return Err(AppError::Internal(format!(
                        "SQLiteバックアップが時間制限を超えました（{}秒）。",
                        BACKUP_MAX_DURATION.as_secs()
                    )));
                }
            }
            StepResult::Busy | StepResult::Locked => {
                if busy_locked_retries >= BACKUP_BUSY_LOCKED_RETRY_LIMIT {
                    return Err(AppError::Internal(format!(
                        "SQLiteバックアップがロックされたままです。{}回再試行しました。",
                        BACKUP_BUSY_LOCKED_RETRY_LIMIT
                    )));
                }
                busy_locked_retries += 1;
                sleep(BACKUP_RETRY_DELAY);
            }
            _ => {
                return Err(AppError::Internal(
                    "SQLiteバックアップが未知の状態を返しました。".to_owned(),
                ));
            }
        }
    }
}

fn reserve_backup_path(directory: &Path, timestamp: u128) -> AppResult<(PathBuf, PathBuf)> {
    for sequence in 0..=u32::MAX {
        let stem = format!("{BACKUP_FILE_PREFIX}{timestamp}-{sequence}");
        let temporary_path = directory.join(format!(".{stem}.db.tmp"));
        let backup_path = directory.join(format!("{stem}{BACKUP_FILE_EXTENSION}"));

        match OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&temporary_path)
        {
            Ok(_) if !backup_path.exists() => return Ok((temporary_path, backup_path)),
            Ok(_) => {
                fs::remove_file(&temporary_path)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }

    Err(AppError::Internal(
        "バックアップファイル名を確保できませんでした。".to_owned(),
    ))
}

fn validate_backup(path: &Path) -> AppResult<()> {
    let connection = Connection::open(path)?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Internal(format!(
            "SQLiteバックアップの整合性検査に失敗しました: {integrity}"
        )));
    }
    drop(connection);

    let file = OpenOptions::new().read(true).write(true).open(path)?;
    file.sync_all()?;
    Ok(())
}

fn is_managed_backup(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with(BACKUP_FILE_PREFIX) && name.ends_with(BACKUP_FILE_EXTENSION)
        })
}

fn prune_old_backups(directory: &Path) -> AppResult<()> {
    prune_old_backups_with(directory, |path| fs::remove_file(path))
}

fn prune_old_backups_with<F>(directory: &Path, mut remove_file: F) -> AppResult<()>
where
    F: FnMut(&Path) -> std::io::Result<()>,
{
    let mut backups = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() || !is_managed_backup(&entry.path()) {
            continue;
        }
        backups.push((entry.metadata()?.modified()?, entry.path()));
    }

    backups.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    for (_, path) in backups.into_iter().skip(BACKUP_RETENTION_COUNT) {
        match remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::cell::Cell;
    use tempfile::{TempDir, tempdir};

    fn database_path(directory: &TempDir) -> PathBuf {
        directory.path().join("kataru.db")
    }

    fn managed_backups(path: &Path) -> Vec<PathBuf> {
        let directory = backup_directory(path);
        if !directory.exists() {
            return Vec::new();
        }
        fs::read_dir(directory)
            .expect("read backup directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| is_managed_backup(path))
            .collect()
    }

    fn create_legacy_database(path: &Path, character_json: Option<&str>) {
        let connection = Connection::open(path).expect("open legacy database");
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .expect("enable WAL");
        connection
            .execute_batch(INITIAL_MIGRATION)
            .expect("apply initial migration");
        if let Some(character_json) = character_json {
            connection
                .execute(
                    "INSERT INTO characters(id, updated_at, data_json) VALUES (?1, ?2, ?3)",
                    params!["character-1", 1_i64, character_json],
                )
                .expect("insert legacy character");
        }
    }

    #[test]
    fn initial_empty_database_does_not_create_backup_directory() {
        let directory = tempdir().expect("create temp directory");
        let path = database_path(&directory);

        Database::open(&path).expect("open initial database");

        assert!(!backup_directory(&path).exists());
    }

    #[test]
    fn online_backup_is_created_before_migration_and_is_restorable() {
        let directory = tempdir().expect("create temp directory");
        let path = database_path(&directory);
        create_legacy_database(&path, None);

        let source = Connection::open(&path).expect("keep source database open");
        source
            .execute(
                "INSERT INTO meta(key, value_json) VALUES (?1, ?2)",
                params!["backup-test", "\"preserved\""],
            )
            .expect("insert backup marker");
        let database = Database::open(&path).expect("migrate database");
        drop(database);
        drop(source);

        let backups = managed_backups(&path);
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(&backups[0]).expect("open backup");
        assert_eq!(
            backup
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .expect("check backup"),
            "ok"
        );
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("read backup version"),
            1
        );
        assert_eq!(
            backup
                .query_row(
                    "SELECT value_json FROM meta WHERE key = 'backup-test'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("read backup marker"),
            "\"preserved\""
        );
        assert_eq!(
            Connection::open(&path)
                .expect("reopen migrated database")
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("read migrated version"),
            CURRENT_SCHEMA_VERSION
        );
    }

    #[test]
    fn verified_backup_remains_usable_when_pruning_fails() {
        let directory = tempdir().expect("create temp directory");
        let path = database_path(&directory);
        create_legacy_database(&path, None);
        let source = Connection::open(&path).expect("open source database");

        let result = create_startup_backup_with_pruner(&source, &path, |_| {
            Err(AppError::Internal("simulated prune failure".to_owned()))
        });

        assert!(result.is_ok());
        let backups = managed_backups(&path);
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(&backups[0]).expect("open retained backup");
        assert_eq!(
            backup
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .expect("check retained backup"),
            "ok"
        );
    }

    #[test]
    fn pruning_treats_a_concurrent_not_found_as_success() {
        let directory = tempdir().expect("create temp directory");
        let path = database_path(&directory);
        let backup_directory = backup_directory(&path);
        fs::create_dir_all(&backup_directory).expect("create backup directory");
        for sequence in 0..=BACKUP_RETENTION_COUNT {
            fs::write(
                backup_directory.join(format!(
                    "{BACKUP_FILE_PREFIX}test-{sequence}{BACKUP_FILE_EXTENSION}"
                )),
                [],
            )
            .expect("create placeholder backup");
        }

        let mut removed_by_race = false;
        let result = prune_old_backups_with(&backup_directory, |path| {
            if !removed_by_race {
                removed_by_race = true;
                fs::remove_file(path).expect("simulate concurrent removal");
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "backup was removed concurrently",
                ));
            }
            fs::remove_file(path)
        });

        assert!(result.is_ok());
        assert_eq!(managed_backups(&path).len(), BACKUP_RETENTION_COUNT);
    }

    #[test]
    fn backup_retries_busy_and_locked_steps_before_completing() {
        let mut steps = [
            StepResult::Busy,
            StepResult::Locked,
            StepResult::More,
            StepResult::Done,
        ]
        .into_iter();

        let result = run_backup_steps_with_clock(
            || Ok(steps.next().expect("return backup step")),
            || Duration::ZERO,
            |_| {},
        );

        assert!(result.is_ok());
    }

    #[test]
    fn backup_busy_locked_retries_are_bounded() {
        let mut calls = 0;
        let result = run_backup_steps_with_clock(
            || {
                calls += 1;
                Ok(StepResult::Busy)
            },
            || Duration::ZERO,
            |_| {},
        );

        assert!(result.is_err());
        assert_eq!(calls, BACKUP_BUSY_LOCKED_RETRY_LIMIT + 1);
    }

    #[test]
    fn backup_allows_many_progressing_more_steps_before_done() {
        let mut steps = vec![StepResult::More; 128];
        steps.push(StepResult::Done);
        let mut steps = steps.into_iter();

        let result = run_backup_steps_with_clock(
            || Ok(steps.next().expect("return backup step")),
            || Duration::ZERO,
            |_| {},
        );

        assert!(result.is_ok());
    }

    #[test]
    fn backup_more_steps_fail_after_the_injected_time_limit() {
        let elapsed = Cell::new(Duration::ZERO);

        let result = run_backup_steps_with_clock(
            || {
                elapsed.set(BACKUP_MAX_DURATION);
                Ok(StepResult::More)
            },
            || elapsed.get(),
            |_| {},
        );

        assert!(result.is_err());
    }

    #[test]
    fn startup_backups_are_limited_to_the_configured_generation_count() {
        let directory = tempdir().expect("create temp directory");
        let path = database_path(&directory);
        Database::open(&path).expect("create database");

        for _ in 0..(BACKUP_RETENTION_COUNT + 2) {
            Database::open(&path).expect("create startup backup");
        }

        let backups = managed_backups(&path);
        assert_eq!(backups.len(), BACKUP_RETENTION_COUNT);
        for backup_path in backups {
            let backup = Connection::open(backup_path).expect("open retained backup");
            assert_eq!(
                backup
                    .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                    .expect("check retained backup"),
                "ok"
            );
        }
    }

    #[test]
    fn backup_failure_stops_before_migration_and_leaves_database_available() {
        let directory = tempdir().expect("create temp directory");
        let path = database_path(&directory);
        create_legacy_database(&path, Some("{}"));
        fs::write(backup_directory(&path), b"not a directory").expect("block backup directory");

        let result = Database::open(&path);
        assert!(result.is_err());

        let connection = Connection::open(&path).expect("reopen after backup failure");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("read original version"),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'image_assets'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("check migration table"),
            0
        );
    }

    #[test]
    fn migration_failure_rolls_back_and_leaves_original_database_available() {
        let directory = tempdir().expect("create temp directory");
        let path = database_path(&directory);
        create_legacy_database(&path, Some("not valid json"));

        let result = Database::open(&path);
        assert!(result.is_err());

        let connection = Connection::open(&path).expect("reopen after migration failure");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("read rolled-back version"),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'image_assets'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("check rolled-back migration table"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT data_json FROM characters WHERE id = 'character-1'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("read original character"),
            "not valid json"
        );
        assert_eq!(managed_backups(&path).len(), 1);
    }
}
