mod catalog;
mod chat;
mod common;
mod embeddings;
mod generation;
mod image;
mod memory;
mod structured;
mod tts;

pub use catalog::{
    ModelCatalogCache, connection_status, models, providers, run_models_cli_command_if_requested,
};
pub use chat::chat;
pub use embeddings::embeddings;
pub use generation::{
    detect_expression_name, generate_character, generate_reply_suggestions,
    generate_situation_description, generate_title, summarize,
};
pub use image::generate_image;
pub use memory::extract_memories;
pub use tts::{list_tts_speakers, synthesize_speech};

pub(crate) use common::{
    RoleSelection, entity_connection_id, model_string, optional_role_selection,
    resolve_role_selection, role_connection, role_default_selection, upstream_error,
};
pub(crate) use memory::{
    memory_extraction_guided_prompt, memory_extraction_prompt, memory_schema, parse_memory_updates,
};
pub(crate) use structured::{
    extract_message_text, structured_completion, structured_completion_streaming,
};
