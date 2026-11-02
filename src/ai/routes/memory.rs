use axum::{
    Json,
    extract::State,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::{AppState, error::AppResult};

use super::{
    common::{ai_api_client_for_selection, resolve_role_selection, take_chars},
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

- {{user}}が明示的に「覚えて」「記憶して」「今後も守って」と依頼した内容
- characterSystemPrompt, existingMemories に含まれない設定
 - 呼び方
 - 好み
 - 苦手
 - NG
 - キャラクター自身の情報
 - 世界観の固有名詞
 など
- {{user}}とキャラクターの関係性、約束、距離感の変化

### scope

- character: 対象キャラクターが覚えている{{user}}情報、好み、指示
- relationship: {{user}}と対象キャラクターの関係性、距離感の変化、約束
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
0.90-1.00 {{user}}が明確に依頼または断定した
0.70-0.89 会話から明確に読み取れる
0.40-0.69 推測を含むため保存しない
0.00-0.39 保存しない"#
}

pub(crate) fn memory_extraction_guided_prompt() -> &'static str {
    r#"あなたはロールプレイチャットの長期記憶を保存する判定器です。キャラクターとして返答してはいけません。

## 目的

- 事前に実行された判定器によって、最新のターンに新しく保存すべき情報があると判断されています。
- saveReasons は、その判定で新しい情報があるとされた観点の一覧です。
- saveReasons の観点に当てはまる情報だけを抽出します。それ以外の情報は保存しません。
- saveReasons の観点に当てはまる具体的な情報が実際には見つからない場合は updates を空配列にします。
- usedMemories は、最新のターンの返答が既に参照している保存済みメモリです。usedMemories と同じ意味の内容は保存しません。
- existingMemories と同じ意味の内容も保存しません。
- characterSystemPrompt に含まれるキャラクター設定、人格、口調、世界観、既定の関係性は保存しません。
- 最新のターンのみが対象です。それ以前の履歴は文脈の確認用です。
- 出力は {"updates": [...]} 形式の JSON のみです。Markdown や説明文を含めてはいけません。

## ルール

### 抽出する内容

- saveReasons の各観点について、最新のターンに現れた新しい情報を抽出します。
- saveReasons の各項目には対応する scope や kind の指針が含まれています。その指針に従ってください。
- 似た内容は1つのアイテムにまとめて保存します。正確な内容を簡単に、短く記述してください。

### scope

- character: 対象キャラクターが覚えている{{user}}情報、好み、指示
- relationship: {{user}}と対象キャラクターの関係性、距離感の変化、約束
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
0.90-1.00 {{user}}が明確に依頼または断定した
0.70-0.89 会話から明確に読み取れる
0.40-0.69 推測を含むため保存しない
0.00-0.39 保存しない"#
}

pub(crate) fn memory_extraction_batch_prompt() -> &'static str {
    r#"あなたはロールプレイチャットの長期記憶を保存する判定器です。キャラクターとして返答してはいけません。

## 目的

- messages は、まだ長期記憶に反映していない会話のまとまりです。各発言には ref（m1, m2, ...）が付いています。
- contextMessages は、その直前の会話です。文脈の確認だけに使い、ここから記憶を作ってはいけません。
- summary は、それより前の会話の要約です。文脈の確認だけに使います。
- messages 全体を最後まで読み、後の会話でキャラクターが覚えていてほしい情報を漏れなく抽出します。
- 話題ごとに別の項目にします。複数の話題を1項目に詰め込んだり、代表的な1件だけを選んだりしてはいけません。
- 何ターンかにまたがって形になった同じ話題の変化（関係の進展、約束のまとまり、設定の判明など）は、途中経過ではなく最終的な内容を1件にまとめます。
- 会話の中で起きた出来事（どこへ行った、何をした、何をもらった・あげた、何を打ち明けた、何を決めた、誰と会った）は、後で話題になりうるので event として保存します。
- 後で撤回・訂正された内容は、訂正後の内容だけを保存します。保存しないのは、言い直す前の内容、明らかな冗談、その場の動作や表情の描写だけです。
- existingMemories と同じ意味の内容は保存しません。
- characterSystemPrompt に含まれるキャラクター設定、人格、口調、世界観、既定の関係性は保存しません。
- 各項目の sourceRefs には、その内容の根拠となった messages の ref を1つ以上入れます。contextMessages は根拠にできません。
- 該当する情報がない場合は updates を空配列にします。
- 出力は {"updates": [...]} 形式の JSON のみです。Markdown や説明文を含めてはいけません。

## ルール

### 保存する内容

似た内容は1つのアイテムにまとめて保存します。正確な内容を簡単に、短く記述してください。

- {{user}}が明示的に「覚えて」「記憶して」「今後も守って」と依頼した内容
- characterSystemPrompt, existingMemories に含まれない設定
 - 呼び方
 - 好み
 - 苦手
 - NG
 - キャラクター自身の情報
 - 世界観の固有名詞
 など
- {{user}}とキャラクターの関係性、約束、距離感の変化
- 後の会話で参照されそうな出来事

### scope

- character: 対象キャラクターが覚えている{{user}}情報、好み、指示
- relationship: {{user}}と対象キャラクターの関係性、距離感の変化、約束
- world: 継続シナリオ、世界観、事件、固有名詞、場所

### kind

- preference: 好き嫌い、呼ばれ方、話し方の好み、NG
- relationship: 関係性、信頼、約束、距離感
- instruction: 今後の応答で守るべき明示指示
- event: 会話内で起きた出来事、シナリオ進行、過去のエピソード
- fact: 上記以外の安定した事実

### importance
0.85-1.00 呼び方、NG、強い好み、永続設定、大きな関係変化
0.65-0.84 よく参照されそうな好み、約束、継続中のシナリオ事実、印象に残る出来事
0.40-0.64 ときどき役立つ背景情報、軽い好み、ちょっとした出来事
0.00-0.39 保存しない

### confidence
0.90-1.00 {{user}}が明確に依頼または断定した、または会話の中で実際に起きた
0.70-0.89 会話から明確に読み取れる
0.40-0.69 推測を含むため保存しない
0.00-0.39 保存しない"#
}

pub(crate) const MEMORY_BATCH_MAX_UPDATES: usize = 12;

pub(crate) fn memory_batch_schema() -> Value {
    let mut schema = memory_schema();
    schema["name"] = Value::String("memory_batch_updates".to_owned());
    let updates = &mut schema["schema"]["properties"]["updates"];
    updates["maxItems"] = json!(MEMORY_BATCH_MAX_UPDATES);
    let items = &mut updates["items"];
    items["properties"]["sourceRefs"] = json!({
        "type": "array",
        "minItems": 1,
        "items": {"type": "string"},
        "description": "Refs (m1, m2, ...) of the messages this memory is based on."
    });
    if let Some(required) = items["required"].as_array_mut() {
        required.push(Value::String("sourceRefs".to_owned()));
    }
    schema
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

fn parsed_updates(content: &str) -> Vec<Value> {
    let Ok(parsed) = serde_json::from_str::<Value>(strip_json_code_fence(content)) else {
        return Vec::new();
    };
    parsed
        .get("updates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn parse_memory_update(update: &Value) -> Option<Value> {
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
}

pub(crate) fn parse_memory_updates(content: &str) -> Vec<Value> {
    parsed_updates(content)
        .iter()
        .filter_map(parse_memory_update)
        .take(5)
        .collect()
}

/// バッチ抽出の結果を読む。sourceRefs は文字列だけを残し、空なら項目ごと捨てる。
pub(crate) fn parse_batch_memory_updates(content: &str) -> Vec<Value> {
    parsed_updates(content)
        .iter()
        .filter_map(|update| {
            let source_refs = update
                .get("sourceRefs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|reference| !reference.is_empty())
                .map(|reference| Value::String(reference.to_owned()))
                .collect::<Vec<_>>();
            if source_refs.is_empty() {
                return None;
            }
            let mut parsed = parse_memory_update(update)?;
            parsed["sourceRefs"] = Value::Array(source_refs);
            Some(parsed)
        })
        .take(MEMORY_BATCH_MAX_UPDATES)
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
    let recent_messages = normalize_recent_messages(&input);
    if recent_messages.is_empty() {
        return Ok(Json(json!({ "updates": [] })).into_response());
    }
    let selection = resolve_role_selection(&input, "model", "memoryExtractionModel")?;
    let api_client = ai_api_client_for_selection(&state, &input, &selection)?;
    let model = selection.model;
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
        request["reasoning"] = json!({ "effort": "low" });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_updates_keep_source_refs_and_drop_items_without_them() {
        let content = json!({
            "updates": [
                {
                    "content": "ユーザーは猫が好き",
                    "kind": "preference",
                    "scope": "character",
                    "importance": 0.8,
                    "confidence": 0.9,
                    "sourceRefs": ["m2", " ", 3]
                },
                {
                    "content": "根拠のない記憶",
                    "kind": "fact",
                    "scope": "world",
                    "importance": 0.8,
                    "confidence": 0.9,
                    "sourceRefs": []
                }
            ]
        })
        .to_string();
        let updates = parse_batch_memory_updates(&content);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0]["content"], "ユーザーは猫が好き");
        assert_eq!(updates[0]["sourceRefs"], json!(["m2"]));
    }

    #[test]
    fn batch_schema_requires_source_refs() {
        let schema = memory_batch_schema();
        let items = &schema["schema"]["properties"]["updates"]["items"];
        assert!(items["properties"]["sourceRefs"].is_object());
        assert!(
            items["required"]
                .as_array()
                .expect("required")
                .contains(&json!("sourceRefs"))
        );
        assert_eq!(
            schema["schema"]["properties"]["updates"]["maxItems"],
            json!(MEMORY_BATCH_MAX_UPDATES)
        );
    }
}
