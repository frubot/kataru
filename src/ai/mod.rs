pub mod provider;
pub mod routes;

pub use provider::{AiProviderConfig, Provider};
pub use routes::{
    chat, connection_status, embeddings, extract_memories, generate_character, generate_image,
    generate_situation_description, generate_title, summarize,
};
