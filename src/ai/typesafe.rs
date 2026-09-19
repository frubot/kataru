//! TypeSafe AI (Jev) System One API client.

use std::collections::HashMap;

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    ai::{AiApiClient, routes::upstream_error},
    error::{AppError, AppResult},
};

pub const DEFAULT_JEV_MODEL: &str = "jev-latest";
const SYSTEM_ONE_PATH: &str = "systemone";

/// Jev model ids are `jev-*` names on TypeSafe and `typesafe/*` slugs — with a
/// `~typesafe/` redirecting alias — on OpenRouter. Jev only answers through
/// the System One / Decisions API, so a stored selection pointing at one
/// implies the TypeSafe engine even when `engine` is unset (e.g. a global
/// director default chosen from the model catalog).
pub fn is_jev_model(model: &str) -> bool {
    let model = model.trim();
    model == "jev"
        || model.starts_with("jev-")
        || model.starts_with("typesafe/")
        || model.starts_with("~typesafe/")
}

/// OpenRouter serves Jev under `typesafe/` slugs (`typesafe/jev-1.13`, with
/// `~typesafe/jev-latest` as the redirecting alias). Bare TypeSafe model
/// names resolve to the matching slug so a stored `jev-latest` keeps working
/// when the director is routed through OpenRouter instead.
fn openrouter_model(model: &str) -> String {
    if model.starts_with('~') || model.contains('/') {
        model.to_owned()
    } else if model == DEFAULT_JEV_MODEL {
        "~typesafe/jev-latest".to_owned()
    } else {
        format!("typesafe/{model}")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct JevUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SystemOneResponse {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub answers: HashMap<String, Value>,
    #[serde(default)]
    pub usage: Option<JevUsage>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChoiceAnswer {
    pub choice: String,
    #[serde(default)]
    pub probabilities: HashMap<String, f64>,
    #[serde(default)]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NoulAnswer {
    pub noul: f64,
}

/// Evaluates `state` against typed `questions` via `POST /v1/systemone` on
/// TypeSafe, or the Decisions API (`POST /api/alpha/decisions`) on
/// OpenRouter. All questions are answered in parallel in a single call.
pub async fn system_one(
    api_client: &AiApiClient,
    model: &str,
    state: &Value,
    questions: &Value,
    timeout_secs: u64,
) -> AppResult<SystemOneResponse> {
    let model = if api_client.is_openrouter() {
        openrouter_model(model)
    } else {
        model.to_owned()
    };
    let request = json!({
        "state": state,
        "model": model,
        "questions": questions,
    });
    let response = if api_client.is_openrouter() {
        api_client
            .send_json_url(
                &api_client.decisions_endpoint(),
                "decisions",
                &request,
                timeout_secs,
            )
            .await?
    } else {
        api_client
            .send_json(SYSTEM_ONE_PATH, &request, timeout_secs)
            .await?
    };
    if !response.status().is_success() {
        return Err(upstream_error(response).await);
    }
    response
        .json::<SystemOneResponse>()
        .await
        .map_err(crate::ai::api_client::map_request_error)
}

pub fn choice_answer(response: &SystemOneResponse, question_id: &str) -> AppResult<ChoiceAnswer> {
    answer(response, question_id).and_then(|answer| {
        serde_json::from_value::<ChoiceAnswer>(answer).map_err(|error| {
            AppError::Upstream(
                format!("Jevのchoice応答を解析できません: {error}"),
                StatusCode::BAD_GATEWAY,
            )
        })
    })
}

pub fn noul_answer(response: &SystemOneResponse, question_id: &str) -> AppResult<NoulAnswer> {
    answer(response, question_id).and_then(|answer| {
        serde_json::from_value::<NoulAnswer>(answer).map_err(|error| {
            AppError::Upstream(
                format!("Jevのnoul応答を解析できません: {error}"),
                StatusCode::BAD_GATEWAY,
            )
        })
    })
}

fn answer(response: &SystemOneResponse, question_id: &str) -> AppResult<Value> {
    response.answers.get(question_id).cloned().ok_or_else(|| {
        AppError::Upstream(
            format!("Jevの応答に質問 {question_id} の回答がありません。"),
            StatusCode::BAD_GATEWAY,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_choice_and_noul_answers() {
        let response: SystemOneResponse = serde_json::from_value(json!({
            "model": "jev-latest",
            "answers": {
                "next_speaker": {
                    "type": "choice",
                    "choice": "actor-1",
                    "probabilities": {"actor-1": 0.84, "actor-2": 0.16},
                    "confidence": 0.7
                },
                "continue_naturally": {"type": "noul", "noul": 0.91}
            },
            "usage": {"input_tokens": 312, "output_tokens": 48}
        }))
        .expect("response must parse");

        let choice = choice_answer(&response, "next_speaker").expect("choice answer");
        assert_eq!(choice.choice, "actor-1");
        assert_eq!(choice.probabilities.len(), 2);
        assert_eq!(choice.confidence, Some(0.7));

        let noul = noul_answer(&response, "continue_naturally").expect("noul answer");
        assert!((noul.noul - 0.91).abs() < f64::EPSILON);

        assert_eq!(response.usage.expect("usage").input_tokens, 312);
    }

    #[test]
    fn openrouter_model_maps_bare_names_to_typesafe_slugs() {
        assert_eq!(openrouter_model("jev-latest"), "~typesafe/jev-latest");
        assert_eq!(openrouter_model("jev-1.13"), "typesafe/jev-1.13");
        assert_eq!(openrouter_model("jev-preview"), "typesafe/jev-preview");
        assert_eq!(
            openrouter_model("~typesafe/jev-latest"),
            "~typesafe/jev-latest"
        );
        assert_eq!(openrouter_model("typesafe/jev-1.13"), "typesafe/jev-1.13");
    }

    #[test]
    fn is_jev_model_matches_catalog_ids() {
        assert!(is_jev_model("jev-latest"));
        assert!(is_jev_model("jev-1.13"));
        assert!(is_jev_model("typesafe/jev-1.13"));
        assert!(is_jev_model("typesafe/jev-1.13-20260917"));
        assert!(is_jev_model("~typesafe/jev-latest"));
        assert!(!is_jev_model("deepseek/deepseek-v4-flash-0731"));
        assert!(!is_jev_model("z-ai/glm-5.2"));
        assert!(!is_jev_model(""));
    }

    #[test]
    fn missing_answer_is_rejected() {
        let response: SystemOneResponse =
            serde_json::from_value(json!({"model": "jev-latest", "answers": {}}))
                .expect("response must parse");

        assert!(choice_answer(&response, "next_speaker").is_err());
        assert!(noul_answer(&response, "continue_naturally").is_err());
    }
}
