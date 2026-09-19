use serde_json::{Map, Value, json};

pub const SUMMARY_RECENT_USER_TURNS_TO_KEEP: usize = 3;
pub const DIRECTOR_TRANSCRIPT_USER_HISTORY: usize = 2;

pub const JEV_PROTAGONIST_OPTION: &str = "protagonist";
pub const JEV_CONVERSATION_COMPLETE_OPTION: &str = "conversation-complete";
pub const JEV_END_OPTION: &str = "end";

fn reply_instruction_base(character_name: &str) -> String {
    format!(
        r#"
あなたは{character_name}です。
{character_name}とナレーションを演じてください。
JSON形式で生成してください。提示されたJSONの構造および順序に厳密に従ってください。
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
   - テンプレート的な返答を避け、独自性を出す。

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
  "message": "*夕焼けの光が窓から差し込む誰もいない教室の隅で、あなたの発言を聞いて太郎は興奮した様子で話す* そうなんだよ！それでさ、寝る前に裏庭のほうを見たらUFOみたいに光る物体が止まってたんだよ。その日は全く眠れなかったぜ。 *目を輝かせてそのまま勢いで机に手を付き、顔を近づける。そして真っすぐな目で見つめる。* わかってくれる人がいて嬉しすぎるぜ！"

## 主人公についての前提知識
主人公は単なる発言だけではなく、*歩き出す* のようにアスタリスクで囲って主人公自身の行動等を描写することがあります。それは発言ではなく行動です。
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
    max_characters: usize,
) -> Value {
    let max_characters = max_characters.max(1);
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    if include_thought {
        properties.insert(
            "thought".into(),
            json!({
                "type": "string",
                "description": "返答内容を考える",
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
                "description": "あなたの返信。",
                "minItems": 1,
                "maxItems": 4,
                "items": {
                    "type": "string",
                    "maxLength": max_characters,
                },
            }),
        );
        required.push("messages");
    } else {
        properties.insert(
            "message".into(),
            json!({
                "type": "string",
                "description": "あなたの返答とナレーション",
                "minLength": 1,
                "maxLength": max_characters,
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
    turn_index: usize,
    max_turns: usize,
    banned_actor_id: Option<&str>,
    continuation_generation: bool,
) -> (String, String) {
    let banned = banned_actor_id
        .map(|id| format!("\n直前の発言者 actorId={id} は candidates に含めないでください。"))
        .unwrap_or_default();
    let custom = situation
        .pointer("/director/systemPrompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let require_actor = continuation_generation && turn_index == 0;
    let candidate_rule = if require_actor {
        "場面の継続が要求されているため、candidates は必ず1件以上にしてください。"
    } else {
        "主人公が発言すべき場合や自動会話を終える場合は空配列にしてください。"
    };
    let system = format!(
        r#"あなたはロールプレイで次に発言するキャラクターを選ぶ指揮者です。
有効なJSONのみを出力し、スキーマに従ってください。
candidates は自然さ順の候補です。{candidate_rule}{banned}

{custom}"#
    );
    let actor_lines = actors
        .iter()
        .map(|actor| {
            format!(
                "- id={} / name={} / note={}",
                actor_id(actor),
                string(actor, "name"),
                truncate(&actor_note(actor), 320)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let first_policy = if require_actor {
        "主人公からの新しい発言や行動はありません。会話履歴の末尾から自然に場面を進める一人を必ず候補の先頭にしてください。"
    } else if turn_index == 0 {
        "主人公の最新発言に反応するのに最適な一人を必ず候補の先頭にしてください。"
    } else {
        "次の発言が自然なキャラクターを選ぶか、主人公に発言させるなら空配列にしてください。"
    };
    let user = format!(
        "シチュエーション名: {}\n\n## シチュエーション\n{}\n\n## 役者\n{actor_lines}\n\n## 選び方\n{first_policy}\n\n## 会話履歴\n{}\n\n自動発言ターン: {} / {max_turns}",
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

pub fn director_schema(actor_ids: &[String], require_candidate: bool) -> Value {
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
            "minItems": if require_candidate { 1 } else { 0 },
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

pub fn actor_note(actor: &Value) -> String {
    ["directorDescription", "rolePrompt", "systemPrompt"]
        .iter()
        .map(|key| string(actor, key))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn director_jev_examples() -> Value {
    json!([
        {
            "actors": [
                {"id": "aoi", "name": "葵"},
                {"id": "rin", "name": "凛"},
            ],
            "transcript": "主人公: 凛、昨日の試合見たよ。すごかったね\n\n葵: 私も見てた！最後の得点は鳥肌ものだったよ",
            "answer": {"next_speaker": "rin", "continue_naturally": 0.9},
        },
        {
            "actors": [
                {"id": "aoi", "name": "葵"},
                {"id": "rin", "name": "凛"},
            ],
            "transcript": "主人公: 週末みんなで映画見に行かない？\n\n凛: いいね！葵は何が見たい？",
            "answer": {"next_speaker": "aoi", "continue_naturally": 0.9},
        },
        {
            "actors": [
                {"id": "aoi", "name": "葵"},
                {"id": "rin", "name": "凛"},
            ],
            "transcript": "主人公: 今日は疲れたなあ\n\n葵: おつかれ～。\n\n凛: おつかれ！ねえ、三人で放課後どこか寄ってかない？",
            "answer": {"next_speaker": "protagonist", "continue_naturally": 0.15},
        },
        {
            "actors": [
                {"id": "aoi", "name": "葵"},
                {"id": "rin", "name": "凛"},
            ],
            "transcript": "主人公: じゃあまた明日ね\n\n葵: うん、また明日！\n\n凛: おつかれさまー",
            "answer": {"next_speaker": "conversation-complete", "continue_naturally": 0.8},
        },
        {
            "actors": [
                {"id": "aoi", "name": "葵"},
            ],
            "transcript": "主人公: ありがとう、もう行くね\n\n葵: うん、気をつけてね。また明日！",
            "answer": {"next_speaker": "end", "continue_naturally": 0.05},
        },
    ])
}

/// Structured state handed to Jev for director decisions. Jev evaluates
/// questions in parallel against this single state, so it carries the same
/// context the LLM director prompt would. `examples` holds few-shot
/// reference decisions; see `director_jev_examples`.
pub fn director_jev_state(
    situation: &Value,
    actors: &[Value],
    transcript: &str,
    turn_index: usize,
    max_turns: usize,
) -> Value {
    let actor_entries = actors
        .iter()
        .map(|actor| {
            json!({
                "id": actor_id(actor),
                "name": string(actor, "name"),
                "note": truncate(&actor_note(actor), 320),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "situationName": string(situation, "name"),
        "situationPrompt": string(situation, "situationPrompt"),
        "actors": actor_entries,
        "transcript": if transcript.trim().is_empty() {
            "まだ会話はありません。"
        } else {
            transcript
        },
        "autoTurn": format!("{}/{}", turn_index + 1, max_turns),
        "examples": director_jev_examples(),
    })
}

fn actor_criteria(actors: &[Value], eligible_ids: &[String]) -> Map<String, Value> {
    let mut criteria = Map::new();
    for actor in actors {
        let id = actor_id(actor);
        if !eligible_ids.contains(&id) {
            continue;
        }
        criteria.insert(
            id,
            Value::String(format!(
                "{}: {}",
                string(actor, "name"),
                truncate(&actor_note(actor), 320)
            )),
        );
    }
    criteria
}

pub fn director_jev_first_questions(
    actors: &[Value],
    eligible_ids: &[String],
    include_stop_options: bool,
) -> Value {
    let mut criteria = actor_criteria(actors, eligible_ids);
    if !include_stop_options {
        return json!({
            "next_speaker": {
                "type": "choice",
                "instructions": "この会話で次に発言するのが最も自然なキャラクターを選んでください。",
                "criteria": criteria,
            },
        });
    }
    criteria.insert(
        JEV_PROTAGONIST_OPTION.to_owned(),
        Value::String(
            "主人公（ユーザー）が次に発言すべき。"
                .to_owned(),
        ),
    );
    criteria.insert(
        JEV_CONVERSATION_COMPLETE_OPTION.to_owned(),
        Value::String(
            "会話を終了するが、キャラクター同士が会話を続けても違和感がない"
                .to_owned(),
        ),
    );
    criteria.insert(
        JEV_END_OPTION.to_owned(),
        Value::String("会話を終える。これ以上会話が続くと違和感がある".to_owned()),
    );
    json!({
        "next_speaker": {
            "type": "choice",
            "instructions": "この会話で次に発言するのが最も自然なキャラクターを選んでください。",
            "criteria": criteria,
        },
        "continue_naturally": {
            "type": "noul",
            "instructions": "仮に会話が自然な終了点に達しているとしても、キャラクター同士の会話を続けて違和感がない。",
        },
    })
}

/// Second Jev call, used when the scene reached its natural end but the
/// continuation probability cleared the threshold: pick an actor whose
/// entrance would not break the scene. No stop options in this call.
pub fn director_jev_safe_question(actors: &[Value], eligible_ids: &[String]) -> Value {
    json!({
        "safe_speaker": {
            "type": "choice",
            "instructions": "会話は自然な終了点に達していますが、続けることにしました。今登場してもシチュエーションが崩壊しないキャラクターを選んでください。",
            "criteria": actor_criteria(actors, eligible_ids),
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
        assert!(prompt.contains("*歩き出す* のようにアスタリスクで囲って"));
        assert!(!prompt.contains("括弧などを使って"));
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
            prompt.ends_with("# 葵の設定\n葵として振る舞う\n\n# 口調\n以下はキャラクターの口調例です。ただし、特徴のみを真似てください。そのままこれらの言葉を写さないでください。\n\n丁寧語で話し、語尾は柔らかくする\n\n# 主人公の概要\n主人公は幼なじみ\n\n# 追加の制約\n このセクションの指示を最優先に従ってください。他の設定と矛盾する場合もこちらに従ってください。\n\n返答は三文以内にする")
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
            "# 追加の制約\n このセクションの指示を最優先に従ってください。他の設定と矛盾する場合もこちらに従ってください。\n\n一人称は私にする"
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
        let schema = assistant_schema(&["neutral".into()], false, true, 512);
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
        assert_eq!(
            schema["json_schema"]["schema"]["properties"]["message"]["maxLength"],
            512
        );
        assert!(
            schema["json_schema"]["schema"]["properties"]["thought"]
                .get("maxLength")
                .is_none()
        );
    }

    #[test]
    fn assistant_schema_omits_thought_when_disabled() {
        let schema = assistant_schema(&[], true, false, 256);
        let properties = schema["json_schema"]["schema"]["properties"]
            .as_object()
            .expect("schema properties");

        assert!(!properties.contains_key("thought"));
        assert_eq!(
            schema["json_schema"]["schema"]["required"],
            json!(["messages"])
        );
        assert_eq!(
            schema["json_schema"]["schema"]["properties"]["messages"]["items"]["maxLength"],
            256
        );
    }

    #[test]
    fn continuation_director_prompt_requires_a_candidate_and_drops_latest_message() {
        let situation = json!({
            "name": "放課後",
            "situationPrompt": "教室で話している"
        });
        let actors = vec![json!({"actorId": "actor-aoi", "name": "葵"})];

        let (system, prompt) = director_prompts(
            &situation,
            &actors,
            "主人公: 今日は寒いね\n葵: 雪になるかも",
            0,
            1,
            None,
            true,
        );

        assert!(system.contains("candidates は必ず1件以上にしてください"));
        assert!(!system.contains("空配列にしてください"));
        assert!(prompt.contains("主人公からの新しい発言や行動はありません"));
        assert!(prompt.contains("会話履歴の末尾から自然に場面を進める"));
        assert!(!prompt.contains("## 最新のメッセージ"));
    }

    #[test]
    fn director_prompt_allows_empty_candidates_outside_continuation() {
        let (system, _) = director_prompts(&json!({}), &[], "", 0, 1, None, false);

        assert!(system.contains("空配列にしてください"));
    }

    #[test]
    fn jev_first_questions_include_actors_and_stop_options() {
        let actors = vec![
            json!({"actorId": "actor-aoi", "name": "葵", "rolePrompt": "幼なじみ"}),
            json!({"actorId": "actor-rin", "name": "凛", "rolePrompt": "後輩"}),
            json!({"actorId": "actor-banned", "name": "直前の発言者"}),
        ];
        let eligible = vec!["actor-aoi".to_owned(), "actor-rin".to_owned()];

        let questions = director_jev_first_questions(&actors, &eligible, true);

        let criteria = &questions["next_speaker"]["criteria"];
        assert_eq!(criteria.as_object().unwrap().len(), 5);
        assert!(criteria.get("actor-aoi").is_some());
        assert!(criteria.get("actor-rin").is_some());
        assert!(criteria.get("actor-banned").is_none());
        assert!(criteria.get(JEV_PROTAGONIST_OPTION).is_some());
        assert!(criteria.get(JEV_CONVERSATION_COMPLETE_OPTION).is_some());
        assert!(criteria.get(JEV_END_OPTION).is_some());
        assert!(criteria["actor-aoi"].as_str().unwrap().contains("葵"));

        assert_eq!(questions["next_speaker"]["type"], "choice");
        assert_eq!(questions["continue_naturally"]["type"], "noul");
    }

    #[test]
    fn jev_first_questions_without_stop_options_only_offer_actors() {
        let actors = vec![
            json!({"actorId": "actor-aoi", "name": "葵"}),
            json!({"actorId": "actor-rin", "name": "凛"}),
        ];
        let eligible = vec!["actor-aoi".to_owned(), "actor-rin".to_owned()];

        let questions = director_jev_first_questions(&actors, &eligible, false);

        let criteria = &questions["next_speaker"]["criteria"];
        assert_eq!(criteria.as_object().unwrap().len(), 2);
        assert!(criteria.get("actor-aoi").is_some());
        assert!(criteria.get("actor-rin").is_some());
        assert!(criteria.get(JEV_PROTAGONIST_OPTION).is_none());
        assert!(criteria.get(JEV_CONVERSATION_COMPLETE_OPTION).is_none());
        assert!(criteria.get(JEV_END_OPTION).is_none());
        assert!(questions.get("continue_naturally").is_none());
    }

    #[test]
    fn jev_safe_question_has_no_stop_options() {
        let actors = vec![
            json!({"actorId": "actor-aoi", "name": "葵"}),
            json!({"actorId": "actor-banned", "name": "直前の発言者"}),
        ];
        let eligible = vec!["actor-aoi".to_owned()];

        let questions = director_jev_safe_question(&actors, &eligible);

        let criteria = &questions["safe_speaker"]["criteria"];
        assert_eq!(criteria.as_object().unwrap().len(), 1);
        assert!(criteria.get("actor-aoi").is_some());
        assert!(criteria.get("actor-banned").is_none());
        assert!(criteria.get(JEV_PROTAGONIST_OPTION).is_none());
        assert!(criteria.get(JEV_CONVERSATION_COMPLETE_OPTION).is_none());
        assert!(criteria.get(JEV_END_OPTION).is_none());
    }

    #[test]
    fn jev_state_carries_director_context() {
        let situation = json!({
            "name": "放課後",
            "situationPrompt": "教室で話している"
        });
        let actors = vec![json!({"actorId": "actor-aoi", "name": "葵", "rolePrompt": "幼なじみ"})];

        let state = director_jev_state(
            &situation,
            &actors,
            "主人公: 今日は寒いね\n葵: 雪になるかも",
            1,
            3,
        );

        assert_eq!(state["situationName"], "放課後");
        assert_eq!(state["autoTurn"], "2/3");
        assert_eq!(state["actors"][0]["id"], "actor-aoi");
        assert_eq!(state["actors"][0]["note"], "幼なじみ");
        assert!(state.get("latestUserMessage").is_none());
        assert!(state.get("lastSpeakerId").is_none());
    }

    #[test]
    fn jev_state_examples_label_existing_options() {
        let state = director_jev_state(&json!({}), &[], "", 0, 1);
        let examples = state["examples"].as_array().expect("examples array");

        assert!(examples.len() >= 3);
        for example in examples {
            let actor_ids = example["actors"]
                .as_array()
                .expect("example actors")
                .iter()
                .map(|actor| actor["id"].as_str().unwrap())
                .collect::<Vec<_>>();
            let choice = example["answer"]["next_speaker"]
                .as_str()
                .expect("example next_speaker");
            assert!(
                actor_ids.contains(&choice)
                    || [
                        JEV_PROTAGONIST_OPTION,
                        JEV_CONVERSATION_COMPLETE_OPTION,
                        JEV_END_OPTION,
                    ]
                    .contains(&choice),
                "example answer {choice} must be one of its actors or a special option"
            );
            assert!(example["answer"]["continue_naturally"].as_f64().is_some());
        }
    }
}
