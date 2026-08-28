mod catalog;
mod chat;
mod common;
mod embeddings;
mod generation;
mod image;
mod memory;
mod structured;

pub use catalog::{
    ModelCatalogCache, connection_status, models, providers, run_models_cli_command_if_requested,
};
pub use chat::chat;
pub use embeddings::embeddings;
pub use generation::{
    generate_character, generate_reply_suggestions, generate_situation_description, generate_title,
    summarize,
};
pub use image::generate_image;
pub use memory::extract_memories;

pub(crate) use common::{optional_model, resolve_model};
pub(crate) use memory::{memory_extraction_prompt, memory_schema, parse_memory_updates};
pub(crate) use structured::{
    extract_message_text, structured_completion, structured_completion_streaming,
};
