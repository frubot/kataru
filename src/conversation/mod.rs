pub mod jobs;
mod orchestrator;
mod prompts;
mod response;

use serde_json::Value;

use crate::error::{AppError, AppResult};

pub use orchestrator::turn;
pub(crate) use response::sanitize_assistant_reply_content;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GenerationMode {
    Reply,
    Continue,
}

impl GenerationMode {
    pub(crate) fn from_payload(payload: &Value) -> AppResult<Self> {
        match payload
            .get("generationMode")
            .and_then(Value::as_str)
            .unwrap_or("reply")
        {
            "reply" => Ok(Self::Reply),
            "continue" => Ok(Self::Continue),
            _ => Err(AppError::BadRequest(
                "generationMode は reply または continue である必要があります。".to_owned(),
            )),
        }
    }

    pub(crate) fn is_continue(self) -> bool {
        self == Self::Continue
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::GenerationMode;

    #[test]
    fn generation_mode_defaults_to_reply_and_accepts_continue() {
        assert_eq!(
            GenerationMode::from_payload(&json!({})).expect("default generation mode"),
            GenerationMode::Reply
        );
        assert_eq!(
            GenerationMode::from_payload(&json!({"generationMode": "continue"}))
                .expect("continuation generation mode"),
            GenerationMode::Continue
        );
    }

    #[test]
    fn generation_mode_rejects_unknown_values() {
        assert!(GenerationMode::from_payload(&json!({"generationMode": "other"})).is_err());
    }
}
