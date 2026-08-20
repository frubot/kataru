use axum::{
    Json,
    extract::State,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::{AppState, error::AppResult};

use super::{
    common::{ai_api_client_for, resolve_model, take_chars},
    structured::{extract_message_text, structured_completion},
};

pub(crate) fn memory_extraction_prompt() -> &'static str {
    r#"あなたはロールプレイチャットの長期記憶を保存する判定器です。キャラクターとして返答してはいけません。

## 目的

- 直近会話から、次のルールに適合した情報を抽出します。
- 会話履歴がルールに該当しない場合は updates を空配列にします。
- existingMemories と同じ意味の内容は保存しません。
- characterSystemPrompt に含まれるキャラクター設定、人格、口調、世界観、既定の関係性は保存しません。
- 最新のターンのみが対象です。それ以前の履歴はは文脈の確認用です。
- 出力は {"updates": [...]} 形式の JSON のみです。Markdown や説明文を含めてはいけません。

## ルール

### 保存する内容

似た内容は1つのアイテムにまとめて保存します。正確な内容を簡単に、短く記述してください。

- 主人公が明示的に「覚えて」「記憶して」「今後も守って」と依頼した内容
- characterSystemPrompt, existingMemories に含まれない設定
 - 呼び方
 - 好み
 - 苦手
 - NG
 - キャラクター自身の情報
 - 世界観の固有名詞
 など
- 主人公とキャラクターの関係性、約束、距離感の変化

### scope

- character: 対象キャラクターが覚えている主人公情報、好み、指示
- relationship: 主人公と対象キャラクターの関係性、距離感の変化、約束
- world: 継続シナリオ、世界観、事件、固有名詞、場所

### kind

- preference: 好き嫌い、呼ばれ方、話し方の好み、NG
- relationship: 関係性、信頼、約束、距離感
- instruction: 今後の応答で守るべき明示指示
- event: 会話内で起きた出来事、シナリオ進行、過去のエピソード
- fact: 上記以外の安定した事実

### importance
0.85-1.00 呼び方、NG、強い好み、永続設定、大きな関係変化
0.65-0.84 よく参照されそうな好み、約束、継続中のシナリオ事実
0.40-0.64 ときどき役立つ背景情報、軽い好み、最近の出来事
0.00-0.39 保存しない

### confidence
0.90-1.00 主人公が明確に依頼または断定した
0.70-0.89 会話から明確に読み取れる
0.40-0.69 推測を含むため保存しない
0.00-0.39 保存しない"#
}

pub(crate) fn memory_schema() -> Value {
    json!({
        "name": "memory_save_updates",
        "strict": true,
        "schema": {
            "type": "object",
            "properties": {
                "updates": {
                    "type": "array",
                    "maxItems": 5,
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "A concise, stable memory written in Japanese."
                            },
                            "kind": {
                                "type": "string",
                                "enum": [
                                    "fact",
                                    "preference",
                                    "event",
                                    "relationship",
                                    "instruction"
                                ]
                            },
                            "scope": {
                                "type": "string",
                                "enum": ["character", "relationship", "world"]
                            },
                            "importance": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                            },
                            "confidence": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                            }
                        },
                        "required": [
                            "content",
                            "kind",
                            "scope",
                            "importance",
                            "confidence"
                        ],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["updates"],
            "additionalProperties": false
        }
    })
}

fn strip_json_code_fence(content: &str) -> &str {
    let trimmed = content.trim();
    let Some(after_open) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let after_language = after_open
        .strip_prefix("json")
        .or_else(|| after_open.strip_prefix("JSON"))
        .unwrap_or(after_open)
        .trim_start();
    after_language
        .strip_suffix("```")
        .map(str::trim)
        .unwrap_or(trimmed)
}

pub(crate) fn parse_memory_updates(content: &str) -> Vec<Value> {
    let Ok(parsed) = serde_json::from_str::<Value>(strip_json_code_fence(content)) else {
        return Vec::new();
    };
    let Some(updates) = parsed.get("updates").and_then(Value::as_array) else {
        return Vec::new();
    };
    updates
        .iter()
        .filter_map(|update| {
            let record = update.as_object()?;
            let content = record
                .get("content")?
                .as_str()?
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if content.is_empty() {
                return None;
            }
            let kind = record.get("kind")?.as_str()?;
            if !["fact", "preference", "event", "relationship", "instruction"].contains(&kind) {
                return None;
            }
            let scope = record.get("scope")?.as_str()?;
            if !["character", "relationship", "world"].contains(&scope) {
                return None;
            }
            let importance = record.get("importance")?.as_f64()?;
            let confidence = record.get("confidence")?.as_f64()?;
            if !importance.is_finite() || !confidence.is_finite() {
                return None;
            }
            Some(json!({
                "content": content,
                "kind": kind,
                "scope": scope,
                "importance": importance.clamp(0.0, 1.0),
                "confidence": confidence.clamp(0.0, 1.0)
            }))
        })
        .take(5)
        .collect()
}

fn normalize_recent_messages(input: &Value) -> Vec<Value> {
    let mut messages = input
        .get("recentMessages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|message| {
            let record = message.as_object()?;
            let role = record.get("role")?.as_str()?;
            let content = record.get("content")?.as_str()?;
            let mut normalized = json!({
                "role": role,
                "content": content
            });
            if let Some(name) = record.get("name").and_then(Value::as_str) {
                normalized["name"] = json!(name);
            }
            Some(normalized)
        })
        .collect::<Vec<_>>();
    let start = messages.len().saturating_sub(8);
    messages.drain(..start);
    messages
}

fn normalize_existing_memories(input: &Value) -> Vec<Value> {
    input
        .get("existingMemories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|memory| {
            let record = memory.as_object()?;
            let content = record.get("content")?.as_str()?;
            let mut normalized = json!({ "content": content });
            if let Some(kind) = record.get("kind").and_then(Value::as_str) {
                normalized["kind"] = json!(kind);
            }
            if let Some(scope) = record.get("scope").and_then(Value::as_str) {
                normalized["scope"] = json!(scope);
            }
            Some(normalized)
        })
        .take(30)
        .collect()
}

pub async fn extract_memories(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let api_client = ai_api_client_for(&state, &input)?;
    let recent_messages = normalize_recent_messages(&input);
    if recent_messages.is_empty() {
        return Ok(Json(json!({ "updates": [] })).into_response());
    }
    let model = resolve_model(&input, "model", "memoryExtractionModel")?;
    let character_system_prompt = input
        .get("characterSystemPrompt")
        .and_then(Value::as_str)
        .map(|value| take_chars(value, 8000))
        .unwrap_or_default();
    let user_payload = json!({
        "targetCharacter": input.get("characterName").and_then(Value::as_str),
        "characterSystemPrompt": character_system_prompt,
        "groupName": input.get("groupName").and_then(Value::as_str),
        "recentMessages": recent_messages,
        "existingMemories": normalize_existing_memories(&input)
    });
    let mut request = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": memory_extraction_prompt() },
            { "role": "user", "content": user_payload.to_string() }
        ],
        "temperature": 0.1
    });
    if api_client.is_openrouter() {
        request["reasoning"] = json!({ "effort": "medium" });
        request["provider"] = json!({ "data_collection": "deny" });
    }
    let data = structured_completion(&api_client, request, memory_schema(), 60).await?;
    let updates = parse_memory_updates(&extract_message_text(&data));
    Ok(Json(json!({
        "updates": updates,
        "usage": data.get("usage").cloned().unwrap_or(Value::Null)
    }))
    .into_response())
}
