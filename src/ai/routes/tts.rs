use std::time::Duration;

use axum::{
    Json,
    body::Body,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::{
    AppState,
    error::{AppError, AppResult},
};

use super::{
    super::api_client::{AiApiClient, map_request_error},
    common::{
        ai_api_client_for_connection, model_selection_parts, optional_trimmed_string,
        read_upstream_json, required_string, take_chars, upstream_error,
    },
};

const TTS_TEXT_LIMIT: usize = 4000;
const IRODORI_DEFAULT_MODEL: &str = "irodori-tts";
// Irodori serializes synthesis behind a queue whose wait timeout defaults to
// 300 s; allow headroom beyond that for the synthesis itself.
const IRODORI_TIMEOUT_SECS: u64 = 420;

pub async fn synthesize_speech(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let text = take_chars(
        &required_string(&input, "text", "text は必須です。")?,
        TTS_TEXT_LIMIT,
    );
    let voice = required_string(&input, "voice", "voice は必須です。")?;
    let speed = input
        .get("speed")
        .and_then(Value::as_f64)
        .unwrap_or(1.0)
        .clamp(0.25, 4.0);
    let (model, model_connection) = input
        .get("model")
        .and_then(model_selection_parts)
        .map(|(model, connection)| (Some(model), connection))
        .unwrap_or((None, None));
    let connection_id = optional_trimmed_string(&input, "connectionId").or(model_connection);
    let api_client = ai_api_client_for_connection(&state, &input, connection_id.as_deref())?;

    if api_client.is_voicevox() {
        return synthesize_voicevox(&api_client, &text, &voice, speed).await;
    }
    if api_client.is_irodori() {
        return synthesize_irodori(&api_client, &text, &voice, speed, model).await;
    }
    if !api_client.tts_enabled() {
        return Err(AppError::BadRequest(if api_client.is_openai_compatible() {
            "OpenAI互換APIでの音声合成は設定で無効化されています。".to_owned()
        } else {
            "この接続先では音声合成を利用できません。".to_owned()
        }));
    }
    let model = model.ok_or_else(|| {
        AppError::BadRequest("model は必須です。".to_owned())
    })?;
    let upstream = api_client
        .send_json(
            "audio/speech",
            &json!({
                "model": model,
                "input": text,
                "voice": voice,
                "response_format": "mp3",
                "speed": speed,
            }),
            120,
        )
        .await?;
    audio_response(upstream, "audio/mpeg").await
}

async fn synthesize_voicevox(
    api_client: &AiApiClient,
    text: &str,
    voice: &str,
    speed: f64,
) -> AppResult<Response> {
    if voice.parse::<u64>().is_err() {
        return Err(AppError::BadRequest(
            "VOICEVOXの話者IDは数値で指定してください。".to_owned(),
        ));
    }
    let audio_query = api_client
        .post("audio_query", Duration::from_secs(120))
        .query(&[("text", text), ("speaker", voice)])
        .send()
        .await
        .map_err(map_request_error)?;
    if !audio_query.status().is_success() {
        return Err(upstream_error(audio_query).await);
    }
    let mut query = audio_query
        .json::<Value>()
        .await
        .map_err(map_request_error)?;
    let Some(query_object) = query.as_object_mut() else {
        return Err(AppError::Upstream(
            "VOICEVOXからの応答が不正です。".to_owned(),
            StatusCode::BAD_GATEWAY,
        ));
    };
    query_object.insert("speedScale".to_owned(), json!(speed));
    let synthesis = api_client
        .post("synthesis", Duration::from_secs(120))
        .query(&[("speaker", voice)])
        .json(&query)
        .send()
        .await
        .map_err(map_request_error)?;
    audio_response(synthesis, "audio/wav").await
}

async fn synthesize_irodori(
    api_client: &AiApiClient,
    text: &str,
    voice: &str,
    speed: f64,
    model: Option<String>,
) -> AppResult<Response> {
    let upstream = api_client
        .send_json(
            "v1/audio/speech",
            &json!({
                "model": model.unwrap_or_else(|| IRODORI_DEFAULT_MODEL.to_owned()),
                "input": text,
                "voice": voice,
                "response_format": "wav",
                "speed": speed,
            }),
            IRODORI_TIMEOUT_SECS,
        )
        .await?;
    audio_response(upstream, "audio/wav").await
}

async fn audio_response(
    response: reqwest::Response,
    fallback_content_type: &'static str,
) -> AppResult<Response> {
    if !response.status().is_success() {
        return Err(upstream_error(response).await);
    }
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static(fallback_content_type));
    let bytes = response.bytes().await.map_err(map_request_error)?;
    let mut output = Response::new(Body::from(bytes));
    *output.status_mut() = status;
    output
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    Ok(output)
}

pub async fn list_tts_speakers(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let connection_id = optional_trimmed_string(&input, "connectionId");
    let api_client = ai_api_client_for_connection(&state, &input, connection_id.as_deref())?;
    if api_client.is_irodori() {
        return list_irodori_voices(&api_client).await;
    }
    if !api_client.is_voicevox() {
        return Err(AppError::BadRequest(
            "この接続先はVOICEVOXではありません。".to_owned(),
        ));
    }
    let data = read_upstream_json(
        &api_client,
        api_client.send_get("speakers", Duration::from_secs(15)).await?,
    )
    .await?;
    let speakers = data
        .as_array()
        .into_iter()
        .flatten()
        .map(|speaker| {
            json!({
                "name": speaker.get("name").cloned().unwrap_or(Value::Null),
                "styles": speaker
                    .get("styles")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|style| json!({
                        "id": style.get("id").cloned().unwrap_or(Value::Null),
                        "name": style.get("name").cloned().unwrap_or(Value::Null),
                    }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "speakers": speakers })).into_response())
}

/// Irodori exposes a voice registry at `GET /v1/audio/voices`; translate its
/// `{object: "list", data: [{id, ...}]}` payload into the speaker shape the
/// UI already understands. Voice ids are strings, kept as-is in `styles[].id`.
async fn list_irodori_voices(api_client: &AiApiClient) -> AppResult<Response> {
    let data = read_upstream_json(
        api_client,
        api_client
            .send_get("v1/audio/voices", Duration::from_secs(15))
            .await?,
    )
    .await?;
    let mut ids = data
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|voice| voice.get("id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    // "none" (参照音声なしの自動生成) は特殊なので末尾に回し、表示名を
    // 空の「なし」選択肢と紛らわしくないものに変える。
    ids.sort_by_key(|id| *id == "none");
    let speakers = ids
        .iter()
        .map(|id| {
            let label = if *id == "none" { "参照なし（自動生成）" } else { id };
            json!({ "name": label, "styles": [{ "id": id, "name": label }] })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "speakers": speakers })).into_response())
}
