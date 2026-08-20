use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};

use crate::{
    AppState,
    error::{AppError, AppResult},
};

use super::common::{
    ai_api_client_for, optional_trimmed_string, read_upstream_json, required_string, resolve_model,
};

fn image_size(aspect_ratio: Option<&str>) -> &'static str {
    match aspect_ratio {
        Some("2:3") => "1024x1536",
        Some("3:2") => "1536x1024",
        _ => "1024x1024",
    }
}

pub async fn generate_image(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let api_client = ai_api_client_for(&state, &input)?;
    let prompt = required_string(&input, "prompt", "prompt は必須です。")?;
    let model = resolve_model(&input, "model", "defaultImageModel")?;
    let inline_base_image = optional_trimmed_string(&input, "baseImage");
    let base_image_asset_id = optional_trimmed_string(&input, "baseImageAssetId");
    if inline_base_image.is_some() && base_image_asset_id.is_some() {
        return Err(AppError::BadRequest(
            "baseImage と baseImageAssetId は同時に指定できません。".to_owned(),
        ));
    }
    let base_image = if let Some(asset_id) = base_image_asset_id {
        if asset_id.len() != 64 || !asset_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AppError::BadRequest(
                "baseImageAssetId が不正です。".to_owned(),
            ));
        }
        let asset = state
            .database
            .get_image_asset(asset_id)
            .await?
            .ok_or_else(|| AppError::NotFound("元画像が見つかりません。".to_owned()))?;
        Some(format!(
            "data:{};base64,{}",
            asset.mime_type,
            BASE64.encode(asset.data)
        ))
    } else {
        inline_base_image
    };
    let aspect_ratio = input.get("aspectRatio").and_then(Value::as_str);

    if !api_client.is_openrouter() {
        if !api_client.image_generation_enabled() {
            return Err(AppError::BadRequest(if api_client.is_anthropic() {
                "Anthropic APIでは画像生成を利用できません。".to_owned()
            } else {
                "OpenAI互換APIでの画像生成は設定で無効化されています。".to_owned()
            }));
        }
        if base_image.is_some() {
            return Err(AppError::Upstream(
                "OpenAI互換APIでの画像生成は、元画像を使う差分生成には対応していません。"
                    .to_owned(),
                StatusCode::NOT_IMPLEMENTED,
            ));
        }
        let upstream = api_client
            .send_json(
                "images/generations",
                &json!({
                    "model": model,
                    "prompt": prompt,
                    "size": image_size(aspect_ratio),
                    "response_format": "b64_json",
                    "n": 1
                }),
                180,
            )
            .await?;
        let data = read_upstream_json(&api_client, upstream).await?;
        let item = data.pointer("/data/0");
        let image = item
            .and_then(|value| value.get("b64_json"))
            .and_then(Value::as_str)
            .map(|base64| {
                if base64.starts_with("data:image") {
                    base64.to_owned()
                } else {
                    format!("data:image/png;base64,{base64}")
                }
            })
            .or_else(|| {
                item.and_then(|value| value.get("url"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .ok_or_else(|| {
                AppError::Upstream(
                    "画像が生成されませんでした。".to_owned(),
                    StatusCode::BAD_GATEWAY,
                )
            })?;
        return Ok(Json(json!({
            "image": image,
            "usage": data.get("usage").cloned().unwrap_or(Value::Null)
        }))
        .into_response());
    }

    let mut user_content = vec![json!({ "type": "text", "text": prompt })];
    if let Some(base_image) = base_image {
        user_content.insert(
            0,
            json!({ "type": "image_url", "image_url": { "url": base_image } }),
        );
    }
    let mut body = json!({
        "model": model,
        "modalities": ["image"],
        "messages": [{ "role": "user", "content": user_content }]
    });
    if let Some(aspect_ratio) = aspect_ratio {
        body["image_config"] = json!({ "aspect_ratio": aspect_ratio });
    }
    let data = read_upstream_json(
        &api_client,
        api_client.send_json("chat/completions", &body, 180).await?,
    )
    .await?;
    let message = data.pointer("/choices/0/message");
    let image = message
        .and_then(|value| value.pointer("/images/0/image_url/url"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            message
                .and_then(|value| value.get("content"))
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("data:image"))
                .map(ToOwned::to_owned)
        });
    let Some(image) = image else {
        return Ok((
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": "画像が生成されませんでした。",
                "raw": data
            })),
        )
            .into_response());
    };
    Ok(Json(json!({
        "image": image,
        "usage": data.get("usage").cloned().unwrap_or(Value::Null)
    }))
    .into_response())
}
