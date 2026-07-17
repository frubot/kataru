use serde_json::{Value, json};

pub const SUMMARY_RECENT_USER_TURNS_TO_KEEP: usize = 3;
pub const DIRECTOR_TRANSCRIPT_USER_HISTORY: usize = 2;

const REPLY_INSTRUCTION_BASE: &str = r#"
ロールプレイを始めましょう。あなたはキャラクターとナレーションを演じてください。
あなたの出力フォーマットは提示されたJSONスキーマに必ず準拠してください。
- 全く同じ言い回しは使用しないでください。
- 鍵括弧は使用禁止です。
- 設定に示した情報は必ずしも返答に含める必要はありません。
"#;

const ROLEPLAY_REPLY_INSTRUCTION: &str = r#"
## 出力ポリシー
- JSONスキーマのキー名と形式に厳密に従ってください。

## message フィールド
キャラクターの発言と、外部から観察できる感情・行動の簡潔なナレーションを交互に書いてください。
ナレーションは Markdown のイタリック体で囲み、第三者視点で淡々と事実だけを書きます。
主人公側の描写やキャラクターの内面の断定は不要です。
主人公は発言だけでなく、括弧やイタリック体を使って行動を描写することがあります。
"#;

const MESSAGE_REPLY_INSTRUCTION: &str = r#"
あなたはメッセンジャーアプリで相手へ返信します。
## messages フィールド
- 返信を1〜4個の短い文章にしてください。
- 未完成の文を複数項目へ分割しないでください。
- [写真の概要] は主人公が送った写真です。
- 写真を送る場合は [送りたい写真の概要] と記述できます。
"#;

const THINK_INSTRUCTION: &str = r#"
## thinking フィールド
thinking はJSONオブジェクトの最初のキーにしてください。主人公には表示されない短い内部メモとして、
1. いつ・どこで・誰が・何をしているか
2. キャラクターの感情
3. 返答に適切な長さ
の順に状況を整理してください。
"#;

pub fn character_setting(character: &Value) -> String {
    let system = string(character, "systemPrompt");
    let protagonist = string(character, "protagonistPrompt");
    match (system.is_empty(), protagonist.is_empty()) {
        (false, false) => format!("{system}\n\n## 主人公の概要\n{protagonist}"),
        (false, true) => system,
        (true, false) => format!("## 主人公の概要\n{protagonist}"),
        (true, true) => String::new(),
    }
}

pub fn character_system_prompt(
    character: &Value,
    use_message_mode: bool,
    expression_names: &[String],
    summary: Option<&str>,
    relevant_memories: &[String],
    situation: Option<&Value>,
    participants: &[Value],
) -> String {
    let mut prompt = character_setting(character);
    prompt.push_str(REPLY_INSTRUCTION_BASE);
    prompt.push_str(if use_message_mode {
        MESSAGE_REPLY_INSTRUCTION
    } else {
        ROLEPLAY_REPLY_INSTRUCTION
    });

    if boolean(character, "thinkModeEnabled") {
        prompt.push_str(THINK_INSTRUCTION);
    }
    if !expression_names.is_empty() {
        let default = expression_names
            .iter()
            .find(|name| name.eq_ignore_ascii_case("neutral"))
            .or_else(|| expression_names.first())
            .map(String::as_str)
            .unwrap_or("neutral");
        prompt.push_str(&format!(
            "\nJSONの expression には次から1つだけ選んでください: {}。強い感情がない場合は {default} を使用してください。",
            expression_names.join(", ")
        ));
    }

    if let Some(situation) = situation {
        let names = participants
            .iter()
            .filter_map(|actor| actor.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(", ");
        prompt.push_str(&format!(
            "\n\nこのロールプレイには複数人が参加しています。あなたは「{}」としてのみ発言します。参加者: 主人公, {names}\n発言順は指揮役が決めます。他キャラクターの台詞を代弁しないでください。",
            string(character, "name")
        ));
        let situation_prompt = string(situation, "situationPrompt");
        if !situation_prompt.is_empty() {
            prompt.push_str(&format!("\n\n## シチュエーション\n{situation_prompt}"));
        }
        let role_prompt = string(character, "rolePrompt");
        if !role_prompt.is_empty() {
            prompt.push_str(&format!("\n\n# あなたについて\n{role_prompt}"));
        }
    }
    if let Some(summary) = summary.filter(|value| !value.trim().is_empty()) {
        prompt.push_str(&format!("\n\n# これまでの会話の要約\n{}", summary.trim()));
    }
    if !relevant_memories.is_empty() {
        prompt.push_str("\n\n## 関連するメモリ\n");
        for (index, memory) in relevant_memories.iter().enumerate() {
            prompt.push_str(&format!("{}. {memory}\n", index + 1));
        }
    }
    prompt
}

pub fn assistant_schema(
    expression_names: &[String],
    use_message_mode: bool,
    use_think_mode: bool,
) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    if use_think_mode {
        properties.insert("thinking".into(), json!({"type": "string"}));
        required.push("thinking");
    }
    if !expression_names.is_empty() {
        properties.insert(
            "expression".into(),
            json!({
                "type": "string",
                "description": "今現在のキャラクターの表情。",
                "enum": expression_names,
            }),
        );
        required.push("expression");
    }
    if use_message_mode {
        properties.insert(
            "messages".into(),
            json!({
                "type": "array",
                "description": "あなたの返答",
                "minItems": 1,
                "maxItems": 4,
                "items": {"type": "string"},
            }),
        );
        required.push("messages");
    } else {
        properties.insert(
            "message".into(),
            json!({"type": "string", "description": "あなたの返答"}),
        );
        required.push("message");
    }
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "roleplay",
            "strict": true,
            "schema": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            },
        },
    })
}

pub fn summary_prompts(
    messages: &[Value],
    previous_summary: Option<&str>,
    group: bool,
) -> (String, String) {
    let system = if group {
        "You summarize a group roleplay conversation. Preserve each speaker, relationships, key plot events, emotional developments, world facts, decisions, and the current scene. Write in the conversation's language. Return the concise but thorough summary in the requested JSON field."
    } else {
        "You summarize a roleplay conversation. Preserve names, relationships, key plot events, emotional developments, world facts, decisions, and the current scene. Write in the conversation's language. Return the concise but thorough summary in the requested JSON field."
    };
    let mut transcript = String::new();
    if let Some(previous) = previous_summary.filter(|value| !value.trim().is_empty()) {
        transcript.push_str("Existing summary to merge and deduplicate:\n");
        transcript.push_str(previous.trim());
        transcript.push_str("\n\n");
    }
    transcript.push_str("Please summarize the following conversation history:\n\n");
    for message in messages {
        let role = string(message, "role");
        let content = string(message, "content");
        if role == "user" {
            transcript.push_str(&format!("User: {content}\n\n"));
        } else {
            let name = string(message, "name");
            let label = if name.is_empty() { "Assistant" } else { &name };
            transcript.push_str(&format!("{label}: {content}\n\n"));
        }
    }
    (system.into(), transcript)
}

pub fn summary_schema() -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "conversation_summary",
            "strict": true,
            "schema": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                },
                "required": ["summary"],
                "additionalProperties": false,
            },
        },
    })
}

#[allow(clippy::too_many_arguments)]
pub fn director_prompts(
    situation: &Value,
    actors: &[Value],
    transcript: &str,
    latest_user_message: &str,
    turn_index: usize,
    max_turns: usize,
    banned_actor_id: Option<&str>,
    use_thinking: bool,
) -> (String, String) {
    let thinking = if use_thinking {
        r#"
thinking をJSONの最初のキーにし、誰が反応すべきか、参加者の立場と禁止条件、候補順の結論を簡潔に整理してください。"#
    } else {
        ""
    };
    let banned = banned_actor_id
        .map(|id| format!("\n直前の発言者 actorId={id} は candidates に含めないでください。"))
        .unwrap_or_default();
    let custom = situation
        .pointer("/director/systemPrompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let system = format!(
        r#"あなたはロールプレイで次に発言するキャラクターを選ぶ指揮者です。
有効なJSONのみを出力し、スキーマに従ってください。{thinking}
candidates は自然さ順の候補です。主人公が発言すべき場合や自動会話を終える場合は空配列にしてください。{banned}

{custom}"#
    );
    let actor_lines = actors
        .iter()
        .map(|actor| {
            let id = actor_id(actor);
            let name = string(actor, "name");
            let note = ["directorDescription", "rolePrompt", "systemPrompt"]
                .iter()
                .map(|key| string(actor, key))
                .find(|value| !value.is_empty())
                .unwrap_or_default();
            format!("- id={id} / name={name} / note={}", truncate(&note, 320))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let first_policy = if turn_index == 0 {
        "主人公の最新発言に反応するのに最適な一人を必ず候補の先頭にしてください。"
    } else {
        "次の発言が自然なキャラクターを選ぶか、主人公に発言させるなら空配列にしてください。"
    };
    let user = format!(
        "シチュエーション名: {}\n\n## シチュエーション\n{}\n\n## 役者\n{actor_lines}\n\n## 最新のメッセージ\n{latest_user_message}\n\n## 選び方\n{first_policy}\n\n## 会話履歴\n{}\n\n自動発言ターン: {} / {max_turns}",
        string(situation, "name"),
        string(situation, "situationPrompt"),
        if transcript.trim().is_empty() {
            "まだ会話はありません。"
        } else {
            transcript
        },
        turn_index + 1,
    );
    (system, user)
}

pub fn director_schema(actor_ids: &[String], use_thinking: bool) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    if use_thinking {
        properties.insert("thinking".into(), json!({"type": "string"}));
        required.push("thinking");
    }
    properties.insert(
        "candidates".into(),
        json!({
            "type": "array",
            "minItems": 0,
            "maxItems": actor_ids.len().clamp(1, 3),
            "items": {
                "type": "object",
                "properties": {
                    "actorId": {"type": "string", "enum": actor_ids},
                    "reason": {"type": "string"},
                },
                "required": ["actorId", "reason"],
                "additionalProperties": false,
            },
        }),
    );
    required.push("candidates");
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": if use_thinking { "situation_director_decision_with_thinking" } else { "situation_director_decision" },
            "strict": true,
            "schema": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            },
        },
    })
}

pub fn actor_id(actor: &Value) -> String {
    actor
        .get("actorId")
        .or_else(|| actor.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned()
}

pub fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned()
}

pub fn boolean(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}
