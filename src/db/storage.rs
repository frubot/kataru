mod bulk;
mod characters;
mod command;
mod conversation;
mod images;
mod json;
mod memories;
mod messages;
mod meta;
mod rooms;
#[cfg(test)]
mod test_support;
mod usage;

use axum::{Json, extract::State};
use serde_json::{Value, json};

use crate::error::AppResult;

use super::Database;

pub use command::StorageCommand;
pub use conversation::{persist_conversation_result, persist_conversation_submission};
pub use images::migrate_character_images;

pub async fn handle_storage_command(
    State(state): State<crate::AppState>,
    Json(command): Json<StorageCommand>,
) -> AppResult<Json<Value>> {
    let clear_history = matches!(
        &command,
        StorageCommand::ClearAllConversationHistory | StorageCommand::ResetAll
    );
    let _history_persistence_guard = if clear_history {
        Some(state.conversation_jobs.lock_history_persistence().await)
    } else {
        None
    };
    if clear_history {
        state.conversation_jobs.cancel_recoverable().await;
    }
    let database: Database = state.database.clone();
    let result = database
        .call(move |connection| command::execute(connection, command))
        .await?;
    Ok(Json(json!({ "result": result })))
}
