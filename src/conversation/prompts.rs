use serde_json::{Value, json};

pub const SUMMARY_RECENT_USER_TURNS_TO_KEEP: usize = 3;
pub const DIRECTOR_TRANSCRIPT_USER_HISTORY: usize = 2;

const REPLY_INSTRUCTION_BASE: &str = r#"
ロールプレイを始めましょう。あなたは設定に則ったキャラクターと、ナレーションを演じてください。
あなたの出力フォーマットは提示されたJSONスキーマに**準拠する必要**があります。
- **使用禁止**: 鍵括弧(「」)。
- 改行(\n)してください。
- 設定に示した情報は必ずしも返答に含める必要はありません。
"#;

const ROLEPLAY_REPLY_INSTRUCTION: &str = r#"

## JSONスキーマの"message"フィールドについて
message フィールドには次のポリシーに準拠した文章を入力する必要があります。

### "ナレーション"に関して
  あなたは、キャラクターの他に"ナレーション"も演じます。
  ナレーションにおける制約:
   - 感情や動作、行動、状況に関連するものはナレーションとして説明してください。
   - 有効なMarkdownのイタリック体(*説明文*のように囲う)で説明します。
   - 主人公を指す場合は"あなた"と表記してください。
   - キャラクターを指す場合は名前("田中太郎"の場合、"太郎"の部分)を表記してください。
   - 第三者視点で記述してください。
   - ナレーションによる主人公側の描写は不要です。
   - キャラクターの独白など読み取れないものは記述しないでください。ナレーションでは敬語は使いません。
  それぞれmessageフィールド内では次のような表記です。
  キャラクターの表記: 装飾なし。
  ナレーションの表記: イタリック体(*ここに説明文*)でメッセージを囲う。

## 主人公についての前提知識
  主人公は単なる発言だけではなく、括弧やイタリック体などを使って行動等を描写することがあります。声に出して発言しているわけではありません。
"#;

const MESSAGE_REPLY_INSTRUCTION: &str = r#"
 あなたはメッセンジャーアプリで、相手ののメッセージに対して返信するところです。

## JSONスキーマの"messages"フィールドについて
 - "messages" フィールドに、1〜4個の短い文章で入力してください。
 - 主人公が添付する[写真の概要]は主人公があなたに送信した写真についての短い説明です。
 - あなたが写真を送りたい場合、[ここに送りたい写真の短い説明を入れる] を表記することで任意の画像を送信できます。
"#;

const THINK_INSTRUCTION: &str = r#"
## JSONスキーマの "thinking" フィールドについて
 "thinking" フィールドは、いかなる場合も**最初に出力**してください。先に他のフィールドを出力することは**できません**。
 
 このフィールドは返答の前に一度状況を整理して返答の精度を向上させるためのフローに沿って計画を構築する場所です。次の順序に沿って文章を完成させてください。
  1. 状況理解
   相手の意図を考え、状況を整理してください。
   いつ・どこで・誰が・何をしている を明確にしてください。 
  2. 感情
  3. 回答の長さ
   適切な長さを決定してください。
   短すぎるとテンポが悪くなり、長すぎると過剰に冗長な出力をすることになるかもしれません。
   推奨される長さは次の通りです。
   短い ~ 中: 単純な返答や他愛もない会話
   長い: 説明や少し多めに話す必要がある場合、積極的に話したい場合
"#;

pub fn character_setting(character: &Value) -> String {
    let system = string(character, "systemPrompt");
    let protagonist = string(character, "protagonistPrompt");
    let constraints = string(character, "userConstraints");
    let mut sections = Vec::new();
    if !system.is_empty() {
        sections.push(system);
    }
    if !protagonist.is_empty() {
        sections.push(format!("# 主人公の概要\n{protagonist}"));
    }
    if !constraints.is_empty() {
        sections.push(format!("# 追加の制約\n{constraints}"));
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
    let mut prompt = String::from("# 指示");
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
        if participants.len() > 1 {
            let names = participants
                .iter()
                .filter_map(|actor| actor.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(", ");
            prompt.push_str(&format!(
                "\n\nこのロールプレイには複数人が参加しています。あなたは「{}」としてのみ発言します。参加者: 主人公, {names}\n発言順は指揮役が決めます。他キャラクターの台詞を代弁しないでください。",
                string(character, "name")
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
        prompt.push_str(&format!(
            "\n\n# キャラクター、{}の設定\n{setting}",
            string(character, "name")
        ));
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
            json!({"type": "string", "description": "キャラクター・ナレーション含む返答"}),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_schema_keeps_thinking_before_message() {
        let schema = assistant_schema(&[], false, true);
        let property_names = schema
            .pointer("/json_schema/schema/properties")
            .and_then(Value::as_object)
            .expect("assistant schema properties must be an object")
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();

        assert_eq!(property_names, ["thinking", "message"]);
    }

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
        assert!(prompt.ends_with("# キャラクター、葵の設定\n葵として振る舞う"));
    }

    #[test]
    fn character_setting_is_separated_and_added_last() {
        let character = json!({
            "name": "葵",
            "systemPrompt": "葵として振る舞う",
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
            .find("# キャラクター、葵の設定")
            .expect("character setting heading");
        assert_eq!(prompt.find("# 指示"), Some(0));
        assert!(prompt[..setting_heading].contains("# これまでの会話の要約"));
        assert!(prompt[..setting_heading].contains("## 関連するメモリ"));
        assert!(
            prompt.ends_with("# キャラクター、葵の設定\n葵として振る舞う\n\n# 主人公の概要\n主人公は幼なじみ\n\n# 追加の制約\n返答は三文以内にする")
        );
    }

    #[test]
    fn character_setting_can_contain_only_user_constraints() {
        let character = json!({
            "userConstraints": "一人称は私にする"
        });

        assert_eq!(
            character_setting(&character),
            "# 追加の制約\n一人称は私にする"
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
}
