mod storage;

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

pub use storage::{
    handle_storage_command, migrate_character_images, persist_conversation_result,
    persist_conversation_submission,
};

const INITIAL_MIGRATION: &str = include_str!("../../migrations/0001_initial.sql");
const IMAGE_ASSET_MIGRATION: &str = include_str!("../../migrations/0002_image_assets.sql");

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
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        let transaction = connection.transaction()?;
        transaction.execute_batch(INITIAL_MIGRATION)?;
        transaction.execute_batch(IMAGE_ASSET_MIGRATION)?;
        migrate_character_images(&transaction)?;
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
