use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};

use crate::{
    AppState,
    error::{AppError, AppResult},
};

use super::{
    common::{ai_api_client_for, optional_trimmed_string, resolve_model, take_chars},
    structured::{extract_message_text, plain_completion, structured_completion},
};

pub async fn summarize(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let api_client = ai_api_client_for(&state, &input)?;
    let messages = input
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::BadRequest("messages は配列である必要があります。".to_owned()))?;
    let model = resolve_model(&input, "model", "summaryModel")?;
    let is_group_chat = input
        .get("isGroupChat")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let system_prompt = if is_group_chat {
        "You are a summarization assistant for a group roleplay conversation with multiple characters. Your task is to compress conversation history into a concise summary while preserving critical roleplay context. Preserve: each character's name and who said what, character relationships, key plot events, emotional developments, world-building facts, decisions, and current scene context. Write in the same language as the conversation. Be thorough but concise. Output only summary text without commentary."
    } else {
        "You are a summarization assistant for a roleplay conversation. Your task is to compress conversation history into a concise summary while preserving critical roleplay context. Preserve: character names and relationships, key plot events, emotional developments, world-building facts, decisions, and current scene context. Write in the same language as the conversation. Be thorough but concise. Output only summary text without commentary."
    };
    let previous_summary = optional_trimmed_string(&input, "previousSummary")
        .map(|summary| format!("Existing summary to merge and deduplicate:\n{summary}\n\n"))
        .unwrap_or_default();
    let transcript = messages
        .iter()
        .filter_map(|message| {
            let record = message.as_object()?;
            let role = record.get("role")?.as_str()?;
            let content = record.get("content")?.as_str()?;
            if role == "user" {
                return Some(format!("User: {content}"));
            }
            if let Some(name) = record.get("name").and_then(Value::as_str) {
                let to_suffix = record
                    .get("to")
                    .and_then(Value::as_array)
                    .map(|to| {
                        to.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .filter(|to| !to.is_empty())
                    .map(|to| format!(" -> {to}"))
                    .unwrap_or_default();
                Some(format!("{name}{to_suffix}: {content}"))
            } else {
                Some(format!("Assistant: {content}"))
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let user_prompt = format!(
        "{previous_summary}Please summarize the following conversation history:\n\n{transcript}"
    );
    let mut request = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "stream": false,
        "max_tokens": 2048
    });
    if api_client.is_openrouter() {
        request["reasoning"] = json!({ "effort": "none" });
    }
    let data = plain_completion(&api_client, request, 60).await?;
    Ok(Json(json!({ "summary": extract_message_text(&data) })).into_response())
}

fn parse_json_object_text(content: &str) -> Option<Value> {
    let trimmed = content.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed)
        && value.is_object()
    {
        return Some(value);
    }
    if let Some(start_fence) = trimmed.find("```") {
        let after_open = &trimmed[start_fence + 3..];
        let after_language = after_open
            .strip_prefix("json")
            .or_else(|| after_open.strip_prefix("JSON"))
            .unwrap_or(after_open);
        if let Some(end_fence) = after_language.find("```")
            && let Ok(value) = serde_json::from_str::<Value>(after_language[..end_fence].trim())
            && value.is_object()
        {
            return Some(value);
        }
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&trimmed[start..=end])
        .ok()
        .filter(Value::is_object)
}

fn pick_string(source: &Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        match source.get(*key) {
            Some(Value::String(value)) if !value.trim().is_empty() => {
                return value.trim().to_owned();
            }
            Some(Value::Array(values)) => {
                let joined = values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !joined.is_empty() {
                    return joined;
                }
            }
            _ => {}
        }
    }
    String::new()
}

fn normalize_character(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let name = pick_string(source, &["name", "名前"]);
    let gender = pick_string(source, &["gender", "性別"]);
    let first_person = pick_string(source, &["firstPerson", "first_person", "一人称"]);
    let protagonist_address = pick_string(
        source,
        &[
            "protagonistAddress",
            "protagonist_address",
            "主人公への呼び方",
            "主人公の呼び方",
        ],
    );
    let relationship = pick_string(source, &["relationship", "主人公から見た関係性", "関係性"]);
    let protagonist_impression = pick_string(
        source,
        &[
            "protagonistImpression",
            "protagonist_impression",
            "主人公に対する印象",
            "主人公への印象",
        ],
    );
    let occupation = pick_string(source, &["occupation", "job", "職業"]);
    let speech_style = pick_string(source, &["speechStyle", "speech_style", "口調", "話し方"]);
    let personality = pick_string(source, &["personality", "性格"]);
    let traits = pick_string(source, &["traits", "features", "特徴"]);
    if [
        &name,
        &gender,
        &first_person,
        &protagonist_address,
        &relationship,
        &protagonist_impression,
        &occupation,
        &speech_style,
        &personality,
        &traits,
    ]
    .iter()
    .any(|value| value.is_empty())
    {
        return None;
    }
    Some(json!({
        "name": name,
        "gender": gender,
        "firstPerson": first_person,
        "protagonistAddress": protagonist_address,
        "relationship": relationship,
        "protagonistImpression": protagonist_impression,
        "occupation": occupation,
        "speechStyle": speech_style,
        "personality": personality,
        "traits": traits
    }))
}

fn character_schema() -> Value {
    json!({
        "name": "roleplay_character_profile",
        "strict": true,
        "schema": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "name",
                "gender",
                "firstPerson",
                "protagonistAddress",
                "relationship",
                "protagonistImpression",
                "occupation",
                "speechStyle",
                "personality",
                "traits"
            ],
            "properties": {
                "name": {
                    "type": "string",
                    "description": "キャラクターの名前"
                },
                "gender": {
                    "type": "string",
                    "description": "キャラクターの性別"
                },
                "firstPerson": {
                    "type": "string",
                    "description": "キャラクターの一人称"
                },
                "protagonistAddress": {
                    "type": "string",
                    "description": "主人公に対する呼び名（複数可。ユーザーからの指定がない場合、○○で代用しても良い。例: ○○くん）"
                },
                "relationship": {
                    "type": "string",
                    "description": "キャラクターとの関係性（主人公目線）"
                },
                "protagonistImpression": {
                    "type": "string",
                    "description": "キャラクターが主人公に対して抱いている印象や感情"
                },
                "occupation": {
                    "type": "string",
                    "description": "キャラクターの職業、学生の場合は立場や所属"
                },
                "speechStyle": {
                    "type": "string",
                    "description": "キャラクターの語彙、語尾、話すテンポなどの口調"
                },
                "personality": {
                    "type": "string",
                    "description": "キャラクターの内面的な性格"
                },
                "traits": {
                    "type": "string",
                    "description": "経歴、振る舞い、嗜好など、キャラクターを特徴づける要素"
                }
            }
        }
    })
}

pub async fn generate_character(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let api_client = ai_api_client_for(&state, &input)?;
    let direction = optional_trimmed_string(&input, "direction").unwrap_or_default();
    let model = resolve_model(&input, "model", "defaultAutoGenerationModel")?;
    let system_prompt = r#"
あなたは完全にオリジナルなキャラクター概要を作成するAIです。
キャラクターとして応答するのではなく、JSON形式で説明文を出力してください。
日本語で応答してください。
各項目の役割を分け、同じ内容を複数の項目に重複させないでください。
protagonistImpression には、キャラクターが主人公に対して抱いている印象や感情を記載してください。
occupation には職業を、学生の場合は立場や所属を記載してください。
speechStyle には語彙、語尾、話すテンポなど、会話で再現できる口調を記載してください。
personality には内面的な性格を記載してください。
traits には経歴、特徴的な振る舞い、嗜好など、その他の個性を記載してください。"#;
    let user_prompt = if direction.is_empty() {
        "完全におまかせで、ロールプレイに使いやすい特徴的なキャラクターを1人作成してください。"
            .to_owned()
    } else {
        format!("次の方向性でキャラクターを1人作成してください。\n\n方向性:\n{direction}")
    };
    let mut request = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "temperature": if direction.is_empty() { 1.05 } else { 0.9 },
        "max_tokens": 1200
    });
    if api_client.is_openrouter() {
        request["reasoning"] = json!({ "effort": "none" });
    }
    let data = structured_completion(&api_client, request, character_schema(), 60).await?;
    let content = extract_message_text(&data);
    if content.trim().is_empty() {
        return Err(AppError::Upstream(
            "キャラクター生成結果が空でした。".to_owned(),
            StatusCode::BAD_GATEWAY,
        ));
    }
    let character = parse_json_object_text(&content)
        .as_ref()
        .and_then(normalize_character)
        .ok_or_else(|| {
            AppError::Upstream(
                "キャラクター生成結果の形式が不正でした。".to_owned(),
                StatusCode::BAD_GATEWAY,
            )
        })?;
    Ok(Json(json!({
        "character": character,
        "usage": data.get("usage").cloned().unwrap_or(Value::Null)
    }))
    .into_response())
}

fn situation_description_schema() -> Value {
    json!({
        "name": "roleplay_situation_description",
        "strict": true,
        "schema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["description"],
            "properties": {
                "description": { "type": "string" }
            }
        }
    })
}

pub async fn generate_situation_description(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let api_client = ai_api_client_for(&state, &input)?;
    let direction = optional_trimmed_string(&input, "direction").unwrap_or_default();
    let current_description =
        optional_trimmed_string(&input, "currentDescription").unwrap_or_default();
    let situation_name = optional_trimmed_string(&input, "situationName").unwrap_or_default();
    let participants = input
        .get("participants")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .take(20)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let model = resolve_model(&input, "model", "defaultAutoGenerationModel")?;
    let system_prompt = [
        "You generate concise but vivid Japanese situation descriptions for a roleplay chat app.",
        "Output JSON only. Do not wrap it in markdown.",
        "The description must be directly usable as a system-level situation prompt.",
        "Do not include UI instructions, meta commentary, or placeholder text.",
    ]
    .join("\n");
    let mut context_lines = Vec::new();
    if !situation_name.is_empty() {
        context_lines.push(format!("シチュエーション名: {situation_name}"));
    }
    if !participants.is_empty() {
        context_lines.push(format!("登場人物: {}", participants.join("、")));
    }
    if !current_description.is_empty() {
        context_lines.push(format!("現在の説明:\n{current_description}"));
    }
    if !direction.is_empty() {
        context_lines.push(format!("補完・生成の方向性:\n{direction}"));
    }
    let user_prompt = if context_lines.is_empty() {
        "完全におまかせで、ロールプレイ会話で使いやすいシチュエーション説明文を1つ作成してください。"
            .to_owned()
    } else {
        format!(
            "次の情報をもとに、ロールプレイ会話で使いやすいシチュエーション説明文を作成してください。\n\
             舞台、関係性、開始時点の状況、会話の緊張感や目的が自然に伝わるようにしてください。\n\
             既存の説明がある場合は、破綻しない範囲で補強・整理してください。\n\n{}",
            context_lines.join("\n\n")
        )
    };
    let mut request = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "temperature": if direction.is_empty() { 1.0 } else { 0.85 },
        "max_tokens": 1000
    });
    if api_client.is_openrouter() {
        request["reasoning"] = json!({ "effort": "none" });
    }
    let data =
        structured_completion(&api_client, request, situation_description_schema(), 60).await?;
    let content = extract_message_text(&data);
    if content.trim().is_empty() {
        return Err(AppError::Upstream(
            "シチュエーション説明の生成結果が空でした。".to_owned(),
            StatusCode::BAD_GATEWAY,
        ));
    }
    let description = parse_json_object_text(&content)
        .and_then(|value| {
            value
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
        .ok_or_else(|| {
            AppError::Upstream(
                "シチュエーション説明の生成結果の形式が不正でした。".to_owned(),
                StatusCode::BAD_GATEWAY,
            )
        })?;
    Ok(Json(json!({
        "description": description,
        "usage": data.get("usage").cloned().unwrap_or(Value::Null)
    }))
    .into_response())
}

fn normalize_title_messages(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let record = item.as_object()?;
            let role = match record.get("role").and_then(Value::as_str) {
                Some("assistant") => "assistant",
                Some("user") => "user",
                _ => return None,
            };
            let content = record.get("content")?.as_str()?.trim();
            if content.is_empty() {
                return None;
            }
            let mut message = json!({
                "role": role,
                "content": take_chars(content, 1600)
            });
            if let Some(name) = record
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                message["name"] = json!(name);
            }
            Some(message)
        })
        .take(12)
        .collect()
}

fn normalize_generated_title(content: &str) -> Option<String> {
    let without_fence = content
        .replace("```json", "")
        .replace("```JSON", "")
        .replace("```", "");
    let first_line = without_fence
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let mut title = first_line.to_owned();
    let lower = title.to_ascii_lowercase();
    if lower.starts_with("title:") {
        title = title["title:".len()..].trim().to_owned();
    } else if let Some(value) = title
        .strip_prefix("タイトル:")
        .or_else(|| title.strip_prefix("タイトル："))
    {
        title = value.trim().to_owned();
    }
    title = title
        .trim_start_matches(|character: char| {
            character.is_whitespace()
                || matches!(character, '-' | '*' | '#' | '.' | '．')
                || character.is_ascii_digit()
        })
        .trim()
        .to_owned();
    title = title
        .trim_start_matches(|character| {
            matches!(
                character,
                '`' | '"' | '\'' | '“' | '”' | '‘' | '’' | '「' | '『' | '【' | '（' | '('
            )
        })
        .trim_end_matches(|character: char| {
            matches!(
                character,
                '`' | '"'
                    | '\''
                    | '“'
                    | '”'
                    | '‘'
                    | '’'
                    | '」'
                    | '』'
                    | '】'
                    | '）'
                    | ')'
                    | '。'
                    | '.'
                    | '!'
                    | '！'
                    | '?'
                    | '？'
            )
        })
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        None
    } else {
        Some(take_chars(&title, 40).trim().to_owned())
    }
}

fn normalize_reply_suggestion_messages(value: Option<&Value>) -> Vec<Value> {
    let messages = value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let record = item.as_object()?;
            let role = match record.get("role").and_then(Value::as_str) {
                Some("assistant") => "assistant",
                Some("user") => "user",
                _ => return None,
            };
            let content = record.get("content")?.as_str()?.trim();
            if content.is_empty() {
                return None;
            }
            let name = record
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| take_chars(value, 80));
            Some(json!({
                "role": role,
                "content": take_chars(content, 2400),
                "name": name,
            }))
        })
        .collect::<Vec<_>>();
    let skip_count = messages.len().saturating_sub(20);
    messages.into_iter().skip(skip_count).collect()
}

fn reply_suggestion_schema() -> Value {
    json!({
        "name": "protagonist_reply_suggestions",
        "strict": true,
        "schema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["suggestions"],
            "properties": {
                "suggestions": {
                    "type": "array",
                    "minItems": 3,
                    "maxItems": 3,
                    "items": { "type": "string" }
                }
            }
        }
    })
}

fn normalize_reply_suggestions(content: &str) -> Option<Vec<String>> {
    let parsed = parse_json_object_text(content)?;
    let suggestions = parsed.get("suggestions")?.as_array()?;
    let mut normalized = Vec::with_capacity(3);
    for value in suggestions {
        let suggestion = value.as_str()?.trim();
        let suggestion = take_chars(suggestion, 240);
        if suggestion.is_empty() || normalized.contains(&suggestion) {
            continue;
        }
        normalized.push(suggestion);
    }
    (normalized.len() == 3).then_some(normalized)
}

pub async fn generate_reply_suggestions(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let api_client = ai_api_client_for(&state, &input)?;
    let messages = normalize_reply_suggestion_messages(input.get("messages"));
    if messages.is_empty()
        || messages
            .last()
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
            != Some("assistant")
    {
        return Err(AppError::BadRequest(
            "返答の提案には、相手の返答で終わる会話が必要です。".to_owned(),
        ));
    }
    let model = resolve_model(&input, "model", "replySuggestionModel")?;
    let transcript = messages
        .iter()
        .filter_map(|message| {
            let role = message.get("role")?.as_str()?;
            let content = message.get("content")?.as_str()?;
            let label = message
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(if role == "user" {
                    "主人公"
                } else {
                    "相手"
                });
            Some(format!("{label}: {content}"))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let protagonist_prompt = optional_trimmed_string(&input, "protagonistPrompt")
        .map(|value| take_chars(&value, 2400))
        .unwrap_or_default();
    let situation_prompt = optional_trimmed_string(&input, "situationPrompt")
        .map(|value| take_chars(&value, 2400))
        .unwrap_or_default();
    let context = [
        (!protagonist_prompt.is_empty()).then(|| format!("# 主人公の設定\n{protagonist_prompt}")),
        (!situation_prompt.is_empty()).then(|| format!("# シチュエーション\n{situation_prompt}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    let system_prompt = r#"あなたはロールプレイ会話で、ユーザーが操作する主人公の次の返答候補を作る提案役です。
会話の続きを自然に進められる、主人公自身の返答を3種類提案してください。
3つは反応、態度、会話の進め方が互いに異なるものにしてください。ただし、主人公の設定と直前の文脈に従ってください。
各候補は、そのまま主人公の発言として送信できる本文だけにしてください。番号、見出し、引用符、解説、Markdownは含めないでください。
会話と同じ言語を使用してください。"#;
    let user_prompt = if context.is_empty() {
        format!("# 会話\n{transcript}\n\n主人公の次の返答候補を3つ作成してください。")
    } else {
        format!("{context}\n\n# 会話\n{transcript}\n\n主人公の次の返答候補を3つ作成してください。")
    };
    let mut request = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "temperature": 0.85,
        "max_tokens": 480
    });
    if api_client.is_openrouter() {
        request["reasoning"] = json!({ "effort": "none" });
    }
    let data = structured_completion(&api_client, request, reply_suggestion_schema(), 60).await?;
    let suggestions =
        normalize_reply_suggestions(&extract_message_text(&data)).ok_or_else(|| {
            AppError::Upstream(
                "返答の提案結果の形式が不正でした。".to_owned(),
                StatusCode::BAD_GATEWAY,
            )
        })?;
    Ok(Json(json!({
        "suggestions": suggestions,
        "usage": data.get("usage").cloned().unwrap_or(Value::Null)
    }))
    .into_response())
}

pub async fn generate_title(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let api_client = ai_api_client_for(&state, &input)?;
    let messages = normalize_title_messages(input.get("messages"));
    if messages.is_empty() {
        return Err(AppError::BadRequest(
            "タイトル生成に必要な会話がありません。".to_owned(),
        ));
    }
    let model = resolve_model(&input, "model", "titleGenerationModel")?;
    let transcript = messages
        .iter()
        .filter_map(|message| {
            let record = message.as_object()?;
            let role = record.get("role")?.as_str()?;
            let content = record.get("content")?.as_str()?;
            let label = record
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(if role == "user" {
                    "主人公"
                } else {
                    "相手"
                });
            Some(format!("{label}: {content}"))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let system_prompt = r#"あなたはロールプレイチャットアプリのタイトル自動生成器です。
        最初のユーザー発言と最初の返答から、内容が自然に伝わる短いタイトルを1つ作成してください。
        会話が日本語なら日本語で、その他の言語なら会話と同じ言語で書いてください。
        出力はタイトル文字列だけにしてください。説明、引用符、Markdown、句点は出力しないでください。"#;

    let user_prompt = format!(
        "次の最初のやり取りから、チャットルームのタイトルを1つ作成してください。\n\
         目安は日本語なら12〜24文字程度です。\n\n{transcript}"
    );
    let mut request = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "stream": false,
        "temperature": 0.3,
        "max_tokens": 48
    });
    if api_client.is_openrouter() {
        request["reasoning"] = json!({ "effort": "none" });
    }
    let data = plain_completion(&api_client, request, 60).await?;
    let title = normalize_generated_title(&extract_message_text(&data)).ok_or_else(|| {
        AppError::Upstream(
            "タイトル生成結果が空でした。".to_owned(),
            StatusCode::BAD_GATEWAY,
        )
    })?;
    Ok(Json(json!({
        "title": title,
        "usage": data.get("usage").cloned().unwrap_or(Value::Null)
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn character_profile_uses_explicit_fields_instead_of_details() {
        let normalized = normalize_character(&json!({
            "name": "ミナ",
            "gender": "女性",
            "firstPerson": "私",
            "protagonistAddress": "先輩",
            "relationship": "同じ部活の後輩",
            "protagonistImpression": "頼りになるが、少し無理をしすぎる人",
            "occupation": "高校生・天文部員",
            "speechStyle": "明るくテンポが速い",
            "personality": "好奇心旺盛で世話焼き",
            "traits": "星座に詳しい"
        }))
        .expect("explicit profile fields should normalize");

        assert_eq!(normalized["occupation"], "高校生・天文部員");
        assert_eq!(
            normalized["protagonistImpression"],
            "頼りになるが、少し無理をしすぎる人"
        );
        assert!(normalized.get("details").is_none());

        let schema = character_schema();
        let required = schema["schema"]["required"]
            .as_array()
            .expect("schema required fields");
        assert!(required.contains(&json!("traits")));
        assert!(!required.contains(&json!("details")));
        assert!(schema["schema"]["properties"].get("details").is_none());
    }

    #[test]
    fn reply_suggestions_require_three_distinct_values() {
        assert_eq!(
            normalize_reply_suggestions(
                r#"{"suggestions":["そうだね","詳しく教えて","今はやめておく"]}"#
            ),
            Some(vec![
                "そうだね".to_owned(),
                "詳しく教えて".to_owned(),
                "今はやめておく".to_owned(),
            ])
        );
        assert!(
            normalize_reply_suggestions(
                r#"{"suggestions":["そうだね","そうだね","今はやめておく"]}"#
            )
            .is_none()
        );
    }
}
