use serde_json::{Value, json};

pub const SUMMARY_RECENT_USER_TURNS_TO_KEEP: usize = 3;
pub const DIRECTOR_TRANSCRIPT_USER_HISTORY: usize = 2;

fn reply_instruction_base(character_name: &str) -> String {
    format!(
        r#"
あなたはロールプレイを行っています。
あなたは{character_name}とナレーションを演じてください。
設定に示した情報は必ずしも返答に含める必要はありません。

ユーザー=主人公
あなた={character_name}
"#
    )
}

fn roleplay_reply_instruction(character_name: &str) -> String {
    format!(
        r#"
## messageフィールド内のフォーマット
あなたは{character_name}を演じ、ナレーションで状況を表現します。

### キャラクターの返答  
  キャラクターの制約:
   - {character_name}として、設定を守って返答する必要があります。

### ナレーション
  キャラクターとしての返答だけでなく、ユーザーが周囲の状況を理解しやすいようにナレーションも表します。
  
  ナレーションの制約:
   - 感情や動作、行動、状況に関連するものはナレーションとして、三人称視点から説明してください。文体はキャラクター設定に影響されません。(Good: 嬉しそうに話す。 Bad: 嬉しそうに話しました。)
   - *説明文* のように囲っで説明します。
   - 主人公を指す場合は"主人公"と表記してください。
   - キャラクターを指す場合は名前("田中太郎"の場合、"太郎"の部分)で表記してください。
   - キャラクターの独白など読み取れないものは記述しないでください。

### 出力例
  Good:
  "message": "*夕焼けの光が窓から差し込む誰もいない教室の隅で、あなたの発言を聞いて太郎は興奮した様子で話す* そうなんだよ！それでさ、寝る前に裏庭のほうを見たらUFOっぽい光る物体が止まってたんだよ。不思議だよな… *目を輝かせてそのまま勢いで机に手を付き、顔を近づける。そして真っすぐな目で見つめる。* わかってくれる人がいて嬉しすぎるぜ！"

## 主人公についての前提知識
主人公は単なる発言だけではなく、括弧などを使って主人公自身の行動等を描写することがあります。それは声に出して発言しているわけではありません。
"#
    )
}

const MESSAGE_REPLY_INSTRUCTION: &str = r#"
 あなたはメッセンジャーアプリを使って、相手とやりとりします。
 アプリ上での出来事なので、文章は発言ではなくテキストです。

 ## 例
 Good:
 ["確かに。","じゃあ10時にハチ公前集合ね👍マジ明日頑張れそう…。","楽しみ！笑"]

 ## 写真の添付
 主人公が添付する[写真の概要]は主人公が添付した写真についての短い説明です。
 もしあなたが写真を添付したいなら、[画像の説明] を表記することで任意の画像を送信できます。
"#;

pub fn character_setting(character: &Value) -> String {
    let system = string(character, "systemPrompt");
    let speech_style = string(character, "speechStyle");
    let protagonist = string(character, "protagonistPrompt");
    let constraints = string(character, "userConstraints");
    let mut sections = Vec::new();
    if !system.is_empty() {
        sections.push(system);
    }
    if !speech_style.is_empty() {
        sections.push(format!(
            "# 口調\n以下はキャラクターの口調例です。ただし、特徴のみを真似てください。そのままこれらの言葉を写さないでください。\n\n{speech_style}"
        ));
    }
    if !protagonist.is_empty() {
        sections.push(format!("# 主人公の概要\n{protagonist}"));
    }
    if !constraints.is_empty() {
        sections.push(format!("# 追加の制約\n このセクションの指示を最優先に従ってください。他の設定と矛盾する場合もこちらに従ってください。\n\n{constraints}"));
    }
    sections.join("\n\n")
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
    let character_name = string(character, "name");
    let mut prompt = String::from("# 指示");
    prompt.push_str(&reply_instruction_base(&character_name));
    if use_message_mode {
        prompt.push_str(MESSAGE_REPLY_INSTRUCTION);
    } else {
        prompt.push_str(&roleplay_reply_instruction(&character_name));
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
        if participants.len() > 1 {
            let names = participants
                .iter()
                .filter_map(|actor| actor.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(", ");
            prompt.push_str(&format!(
                "\n\nこのロールプレイには複数人が参加しています。あなたは「{}」としてのみ発言します。参加者: 主人公, {names}\n発言順は指揮役が決めます。他キャラクターの台詞を代弁しないでください。",
                character_name
            ));
        }
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
    let setting = character_setting(character);
    if !setting.is_empty() {
        prompt.push_str(&format!("\n\n# {}の設定\n{setting}", character_name));
    }
    prompt
}

pub fn assistant_schema(
    expression_names: &[String],
    use_message_mode: bool,
    include_thought: bool,
) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    if include_thought {
        properties.insert(
            "thought".into(),
            json!({
                "type": "string",
                "description": "考え",
                "minLength": 100
            }),
        );
        required.push("thought");
    }
    if !expression_names.is_empty() {
        properties.insert(
            "expression".into(),
            json!({
                "type": "string",
                "description": "あなたの表情",
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
                "description": "あなたの返信",
                "minItems": 1,
                "maxItems": 4,
                "items": {"type": "string"},
            }),
        );
        required.push("messages");
    } else {
        properties.insert(
            "message".into(),
            json!({
                "type": "string", 
                "description": "あなたの返答とナレーション",
                "minLength": 5
            }),
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
) -> (String, String) {
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
有効なJSONのみを出力し、スキーマに従ってください。
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

pub fn director_schema(actor_ids: &[String]) -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "situation_director_decision",
            "strict": true,
            "schema": {
                "type": "object",
                "properties": {
                    "candidates": {
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
                    }
                },
                "required": ["candidates"],
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_participant_prompt_omits_multi_participant_instructions() {
        let character = json!({
            "name": "葵",
            "systemPrompt": "葵として振る舞う",
            "rolePrompt": "幼なじみ"
        });
        let situation = json!({
            "situationPrompt": "放課後の教室"
        });
        let participants = vec![json!({"name": "葵"})];

        let prompt = character_system_prompt(
            &character,
            false,
            &[],
            None,
            &[],
            Some(&situation),
            &participants,
        );

        assert!(!prompt.contains("複数人が参加しています"));
        assert!(!prompt.contains("発言順は指揮役が決めます"));
        assert!(prompt.starts_with("# 指示"));
        assert!(prompt.contains("## シチュエーション\n放課後の教室"));
        assert!(prompt.contains("# あなたについて\n幼なじみ"));
        assert!(prompt.ends_with("# 葵の設定\n葵として振る舞う"));
    }

    #[test]
    fn character_setting_is_separated_and_added_last() {
        let character = json!({
            "name": "葵",
            "systemPrompt": "葵として振る舞う",
            "speechStyle": "丁寧語で話し、語尾は柔らかくする",
            "protagonistPrompt": "主人公は幼なじみ",
            "userConstraints": "返答は三文以内にする"
        });

        let prompt = character_system_prompt(
            &character,
            false,
            &[],
            Some("これまでの要約"),
            &["重要なメモリ".into()],
            None,
            &[],
        );

        let setting_heading = prompt
            .find("# 葵の設定")
            .expect("character setting heading");
        assert_eq!(prompt.find("# 指示"), Some(0));
        assert!(prompt[..setting_heading].contains("# これまでの会話の要約"));
        assert!(prompt[..setting_heading].contains("## 関連するメモリ"));
        assert!(
            prompt.ends_with("# 葵の設定\n葵として振る舞う\n\n# 口調\n以下はキャラクターの口調例です。ただし、特徴のみを真似てください。そのままこれらの言葉を写さないでください。\n\n丁寧語で話し、語尾は柔らかくする\n\n# 主人公の概要\n主人公は幼なじみ\n\n# 追加の制約\n このセクションの指示を最優先に従ってください。他の設定と矛盾する場合もです。\n\n返答は三文以内にする")
        );
    }

    #[test]
    fn character_setting_can_contain_only_speech_style() {
        let character = json!({
            "speechStyle": "くだけた話し方をする"
        });

        assert_eq!(
            character_setting(&character),
            "# 口調\n以下はキャラクターの口調例です。ただし、特徴のみを真似てください。そのままこれらの言葉を写さないでください。\n\nくだけた話し方をする"
        );
    }

    #[test]
    fn character_setting_can_contain_only_user_constraints() {
        let character = json!({
            "userConstraints": "一人称は私にする"
        });

        assert_eq!(
            character_setting(&character),
            "# 追加の制約\n このセクションの指示を最優先に従ってください。他の設定と矛盾する場合もです。\n\n一人称は私にする"
        );
    }

    #[test]
    fn multi_participant_prompt_keeps_multi_participant_instructions() {
        let character = json!({"name": "葵"});
        let situation = json!({});
        let participants = vec![json!({"name": "葵"}), json!({"name": "凛"})];

        let prompt = character_system_prompt(
            &character,
            false,
            &[],
            None,
            &[],
            Some(&situation),
            &participants,
        );

        assert!(prompt.contains("複数人が参加しています"));
        assert!(prompt.contains("参加者: 主人公, 葵, 凛"));
    }

    #[test]
    fn assistant_schema_puts_thought_first_when_enabled() {
        let schema = assistant_schema(&["neutral".into()], false, true);
        let properties = schema["json_schema"]["schema"]["properties"]
            .as_object()
            .expect("schema properties");

        assert_eq!(
            properties.keys().map(String::as_str).collect::<Vec<_>>(),
            ["thought", "expression", "message"]
        );
        assert_eq!(
            schema["json_schema"]["schema"]["required"],
            json!(["thought", "expression", "message"])
        );
    }

    #[test]
    fn assistant_schema_omits_thought_when_disabled() {
        let schema = assistant_schema(&[], true, false);
        let properties = schema["json_schema"]["schema"]["properties"]
            .as_object()
            .expect("schema properties");

        assert!(!properties.contains_key("thought"));
        assert_eq!(
            schema["json_schema"]["schema"]["required"],
            json!(["messages"])
        );
    }
}
