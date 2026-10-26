use serde_json::{Value, json};

pub const SUMMARY_RECENT_USER_TURNS_TO_KEEP: usize = 3;

/// キャラクター返答の出力形式。ベーシックだけが構造化出力を使わない。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReplyFormat {
    /// ベーシック: 平文。`response_format` を送らない。
    PlainText,
    /// メッセージ: JSONの `messages` 配列。
    Message,
    /// ゲーム: JSON。表情とモーションを含む。
    Structured,
}

impl ReplyFormat {
    /// 表示モードから決める。未設定はベーシックと同じ平文として扱う。
    pub(crate) fn from_view_mode(view_mode: &str) -> Self {
        match view_mode {
            "message" => Self::Message,
            "vn" => Self::Structured,
            _ => Self::PlainText,
        }
    }

    pub(crate) fn is_message(self) -> bool {
        matches!(self, Self::Message)
    }

    pub(crate) fn is_structured(self) -> bool {
        matches!(self, Self::Structured)
    }

    fn uses_json(self) -> bool {
        !matches!(self, Self::PlainText)
    }
}

fn reply_instruction_base(character_name: &str, format: ReplyFormat) -> String {
    let output_instruction = if format.uses_json() {
        "Please generate the output in JSON format. Strictly adhere to the structure and order of the provided JSON."
    } else {
        ""
    };
    format!(
        r#"
You are {character_name}. Please begin the roleplay.
{output_instruction}

The user's name is "{{{{user}}}}".
"#
    )
}

/// 構造化出力のときに使う、JSONで包んだ出力例。
const ROLEPLAY_JSON_OUTPUT_EXAMPLE: &str = r#"{"message": "*夕焼けの光が窓から差し込む誰もいない教室の隅で、あなたの発言を聞いて太郎は興奮した様子で話す* そうなんだよ！それでさ、寝る前に裏庭のほうを見たらUFOみたいに光る物体が止まってたんだよ。その日は全く眠れなかったぜ。 *目を輝かせてそのまま勢いで机に手を付き、顔を近づける。そして真っすぐな目で見つめる。* わかってくれる人がいて嬉しすぎるぜ！"}"#;

/// 平文出力のときに使う、包みのない出力例。
const ROLEPLAY_PLAIN_OUTPUT_EXAMPLE: &str = "*夕焼けの光が窓から差し込む誰もいない教室の隅で、あなたの発言を聞いて太郎は興奮した様子で話す* そうなんだよ！それでさ、寝る前に裏庭のほうを見たらUFOみたいに光る物体が止まってたんだよ。その日は全く眠れなかったぜ。 *目を輝かせてそのまま勢いで机に手を付き、顔を近づける。そして真っすぐな目で見つめる。* わかってくれる人がいて嬉しすぎるぜ！";

fn roleplay_reply_instruction(character_name: &str, format: ReplyFormat) -> String {
    let (heading, example) = if format.uses_json() {
        (
            "## Format within the message field",
            format!("` {ROLEPLAY_JSON_OUTPUT_EXAMPLE} `"),
        )
    } else {
        (
            "## Response format",
            ROLEPLAY_PLAIN_OUTPUT_EXAMPLE.to_owned(),
        )
    };
    format!(
        r#"
{heading}
In addition to {character_name}, you must also provide narration using stage directions (e.g., `*narration*`).

### Character's response
   - You do not necessarily need to include the information provided in the settings in your response.
   - You may fill in missing information in a natural way.

### Constraints on narration
   - Please describe elements related to emotions, movements, actions, and situations through narration. The style of the narration is independent of the characters' individual traits.
   - Please be sure to enclose your explanation in boxes like this: `*Explanation Text*`.
   - Please refer to the character as {character_name} and the user as {{{{user}}}}. If a full name is provided, use only the first name.

### Output example
  Good:
  {example}

## Regarding user input format
Users may include not only spoken lines but also stage directions—such as `*starts walking*`—to describe {{{{user}}}}’s own actions or other such details.
"#
    )
}

const MESSAGE_REPLY_INSTRUCTION: &str = r#"
 You are currently interacting with {{user}} on **social media**.
 The conversation here takes place via text.

 ## Output example
 Good:
 `["確かに。","じゃあ10時にハチ公前集合ね👍マジ明日頑張れそう…。","楽しみ！笑"]`

 ## Attach a photo
 The `[photo description]` provided by a user is a brief explanation of the photo that {{user}} has attached.
 If you would like to include a photo, you can send an image by using the format `[Image: <description of the image>]`. However, this is optional.
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
            "# Tone example\nThe following are examples of a character's tone of voice. Please use them only as a reference for the character's traits; do not copy these specific phrases directly into your responses.\n\n{speech_style}"
        ));
    }
    if !protagonist.is_empty() {
        sections.push(format!("# Details related to {{{{user}}}}\n{protagonist}"));
    }
    if !constraints.is_empty() {
        sections.push(format!("# Additional constraints\n The instructions in this section take top priority. Please follow them even if they conflict with other settings.\n\n{constraints}"));
    }
    sections.join("\n\n")
}

/// キャラクター応答プロンプトへ注入する記憶1件。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InjectedMemory {
    pub content: String,
    /// 「いつの出来事か」のラベル（例: `2026-02-14・約3日前`）。時刻が不明なら `None`。
    pub date_label: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub fn character_system_prompt(
    character: &Value,
    format: ReplyFormat,
    expression_names: &[String],
    motion_names: &[String],
    summary: Option<&str>,
    relevant_memories: &[InjectedMemory],
    active_costume: Option<&Value>,
) -> String {
    let character_name = string(character, "name");
    let mut prompt = String::from("# 指示");
    prompt.push_str(&reply_instruction_base(&character_name, format));
    if format.is_message() {
        prompt.push_str(MESSAGE_REPLY_INSTRUCTION);
    } else {
        prompt.push_str(&roleplay_reply_instruction(&character_name, format));
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

    if !motion_names.is_empty() {
        prompt.push_str(&format!(
            "\nJSONの motion には体の動きを加えたい場合だけ次から1つ選んでください: {}。不要な場合は none を使用してください。",
            motion_names.join(", ")
        ));
    }

    if let Some(summary) = summary.filter(|value| !value.trim().is_empty()) {
        prompt.push_str(&format!(
            "\n\n# Summary of the conversation so far\n{}",
            summary.trim()
        ));
    }
    if !relevant_memories.is_empty() {
        prompt.push_str("\n\n## List of Related Memories\n");
        push_memory_lines(&mut prompt, relevant_memories);
    }
    let setting = character_setting(character);
    if !setting.is_empty() {
        prompt.push_str(&format!("\n\n# {character_name}'s Profile\n{setting}"));
    }
    if let Some(costume) = active_costume {
        let description = string(costume, "description");
        if !description.is_empty() {
            prompt.push_str(&format!(
                "\n\n# Current outfit\nYour current appearance is as follows: 「{}」\n{description}",
                string(costume, "name"),
            ));
        }
    }
    prompt
}

fn push_memory_lines(prompt: &mut String, memories: &[InjectedMemory]) {
    prompt.push_str(
        "The [Date/Elapsed Time] entry in each row indicates the date on which the event was recorded.\n",
    );
    for (index, memory) in memories.iter().enumerate() {
        let number = index + 1;
        match memory.date_label.as_deref() {
            Some(label) if !label.is_empty() => {
                prompt.push_str(&format!("{number}. [{label}] {}\n", memory.content));
            }
            _ => prompt.push_str(&format!("{number}. {}\n", memory.content)),
        }
    }
}

/// シチュエーションの一括生成で、1人の登場キャラクターについてプロンプトへ渡す情報。
pub(crate) struct EnsembleCast<'a> {
    pub actor: &'a Value,
    pub expression_names: Vec<String>,
    pub motion_names: Vec<String>,
    pub memories: Vec<InjectedMemory>,
    pub costume: Option<&'a Value>,
}

const ENSEMBLE_ROLEPLAY_JSON_EXAMPLE: &str = r#"{"turns": [{"speaker": "taro", "message": "*夕焼けの光が差し込む教室で、太郎は身を乗り出す* そうなんだよ！昨日の夜、裏庭にUFOみたいな光が止まってたんだ！*花子を見つめて、なにかひらめいたように*そうだ花子…今晩、俺の裏庭に来ないか！？今日ならまた現れるかも。"}, {"speaker": "hanako", "message": "*花子は呆れたように肩をすくめる* また始まった…。それ、どうせ街灯でしょ？絶対、絶対行かないから。*心底呆れたように太郎を見ながら、髪をいじる*"}]}"#;

const ENSEMBLE_MESSAGE_JSON_EXAMPLE: &str = r#"{"turns": [{"speaker": "taro", "messages": ["確かに。", "じゃあ10時にハチ公前集合ね👍"]}, {"speaker": "hanako", "messages": ["了解！楽しみ笑"]}]}"#;

/// シチュエーション会話を1回の呼び出しでまとめて書かせるためのシステムプロンプト。
pub(crate) fn ensemble_system_prompt(
    situation: &Value,
    cast: &[EnsembleCast<'_>],
    format: ReplyFormat,
    max_turns: usize,
    first_speaker: Option<&Value>,
    summary: Option<&str>,
) -> String {
    let max_turns = max_turns.max(1);
    let mut prompt = String::from(
        r##"# Instructions
You are the narrator of a roleplay and play every character listed under "# Characters".
{{user}} is played by the user. Never write {{user}}'s lines, actions, or thoughts.
Please generate the output in JSON format. Strictly adhere to the structure and order of the provided JSON.

## How the scene flows
- Write the characters' turns in speaking order in the `turns` array. Each turn has exactly one `speaker` (the character's id) and that character's reply.
- Start with the character who would most naturally react to {{user}}'s latest line or action.
"##,
    );
    prompt.push_str(&format!("- Write at most {max_turns} turn(s).\n"));
    if let Some(actor) = first_speaker {
        prompt.push_str(&format!(
            "- {{{{user}}}} is addressing {} (id: {}). The first turn must be {}'s.\n",
            string(actor, "name"),
            actor_id(actor),
            string(actor, "name"),
        ));
    }
    prompt.push_str(
        r#"- Each character knows only what is written in their own section below and what they have seen or heard in this conversation.
- Keep every character's voice distinct. Follow each character's profile and tone example, and do not let their speech styles blend together.
"#,
    );
    if format.is_message() {
        prompt.push_str(&format!(
            r#"
## Reply format
The characters are chatting with {{{{user}}}} on **social media**, so every reply is text messages.
Put each turn's messages in its `messages` array.
If a character wants to send a photo, they can write `[Image: <description of the image>]`. This is optional.
The `[photo description]` provided by {{{{user}}}} is a brief explanation of the photo that {{{{user}}}} has attached.

### Output example
`{ENSEMBLE_MESSAGE_JSON_EXAMPLE}`
"#
        ));
    } else {
        prompt.push_str(&format!(
            r#"
## Reply format
The output should include character dialogue and stage directions (e.g., `*narration*`).
  - Use stage directions (narration) to describe emotions, movements, actions, situations, and the like. The writing style is independent of the character's specific profile.
  - Always format stage directions as `*descriptive text*`.
  - Refer to each character by name, and use `{{{{user}}}}` to refer to the user. If a full name is provided, use only the first name.
  - You do not need to include every detail from the character profile; feel free to naturally fill in any missing information based on the context.

### Output example
`{ENSEMBLE_ROLEPLAY_JSON_EXAMPLE}`

## Regarding user input format
Users may include not only spoken lines but also stage directions—such as `*starts walking*`—to describe {{{{user}}}}'s own actions or other such details.
"#
        ));
    }
    if format.is_structured() {
        prompt.push_str(
            "\nFor `expression`, choose one of the expressions listed in the speaker's own section. For `motion`, choose one of the speaker's motions only when you want to add a body movement, otherwise use none.\n",
        );
    }

    let situation_prompt = string(situation, "situationPrompt");
    if !situation_prompt.is_empty() {
        prompt.push_str(&format!("\n## Situation\n{situation_prompt}\n"));
    }
    let common_rules = string(situation, "characterCommonRules");
    if !common_rules.is_empty() {
        prompt.push_str(&format!(
            "\n## General Rules for Characters\nThe following rules apply to all characters. Please ensure you follow them.\n\n{common_rules}\n"
        ));
    }
    if let Some(summary) = summary.filter(|value| !value.trim().is_empty()) {
        prompt.push_str(&format!(
            "\n# Summary of the conversation so far\n{}\n",
            summary.trim()
        ));
    }

    prompt.push_str("\n# Characters");
    for member in cast {
        let actor = member.actor;
        let name = string(actor, "name");
        prompt.push_str(&format!("\n\n## {name} (id: {})", actor_id(actor)));
        let role_prompt = string(actor, "rolePrompt");
        if !role_prompt.is_empty() {
            prompt.push_str(&format!("\n### Role in this situation\n{role_prompt}"));
        }
        let setting = character_setting(actor);
        if !setting.is_empty() {
            // character_setting の見出しは1段深くして、キャラクターの節に収める。
            let nested = setting.replace("\n# ", "\n#### ");
            let nested = nested
                .strip_prefix("# ")
                .map(|rest| format!("#### {rest}"))
                .unwrap_or(nested);
            prompt.push_str(&format!("\n### Profile\n{nested}"));
        }
        if let Some(costume) = member.costume {
            let description = string(costume, "description");
            if !description.is_empty() {
                prompt.push_str(&format!(
                    "\n### Current outfit\n{name}'s current appearance: 「{}」\n{description}",
                    string(costume, "name"),
                ));
            }
        }
        if !member.expression_names.is_empty() {
            prompt.push_str(&format!(
                "\n### Expressions\n{}",
                member.expression_names.join(", ")
            ));
        }
        if !member.motion_names.is_empty() {
            prompt.push_str(&format!(
                "\n### Motions\n{}",
                member.motion_names.join(", ")
            ));
        }
        if !member.memories.is_empty() {
            prompt.push_str(&format!("\n### {name}'s related memories\n"));
            push_memory_lines(&mut prompt, &member.memories);
        }
    }
    prompt
}

/// 一括生成の出力スキーマ。キャラクターごとに異なる制約（表情の候補・文字数上限）は
/// strictなスキーマでは要素ごとに変えられないため、和集合・最大値で緩めておき、
/// 受け取った後にキャラクター単位で検証する。
pub(crate) fn ensemble_schema(
    speaker_ids: &[String],
    expression_names: &[String],
    motion_names: &[String],
    format: ReplyFormat,
    max_characters: usize,
    max_turns: usize,
) -> Value {
    let max_characters = max_characters.max(1);
    let mut properties = serde_json::Map::new();
    let mut required = vec!["speaker"];
    properties.insert(
        "speaker".into(),
        json!({
            "type": "string",
            "description": "発言するキャラクターのid",
            "enum": speaker_ids,
        }),
    );
    if format.is_structured() && !expression_names.is_empty() {
        properties.insert(
            "expression".into(),
            json!({
                "type": "string",
                "description": "発言者の表情",
                "enum": expression_names,
            }),
        );
        required.push("expression");
    }
    if format.is_structured() && !motion_names.is_empty() {
        let mut motion_enum = Vec::with_capacity(motion_names.len() + 1);
        motion_enum.push("none".to_owned());
        motion_enum.extend(motion_names.iter().cloned());
        properties.insert(
            "motion".into(),
            json!({
                "type": "string",
                "description": "発言者の体の動き(ワンショットモーション)",
                "enum": motion_enum,
            }),
        );
        required.push("motion");
    }
    if format.is_message() {
        properties.insert(
            "messages".into(),
            json!({
                "type": "array",
                "description": "発言者の返信。",
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
                "description": "発言者の返答とナレーション",
                "minLength": 1,
                "maxLength": max_characters,
            }),
        );
        required.push("message");
    }
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "roleplay_ensemble",
            "strict": true,
            "schema": {
                "type": "object",
                "properties": {
                    "turns": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": max_turns.max(1),
                        "items": {
                            "type": "object",
                            "properties": properties,
                            "required": required,
                            "additionalProperties": false,
                        },
                    },
                },
                "required": ["turns"],
                "additionalProperties": false,
            },
        },
    })
}

pub fn assistant_schema(
    expression_names: &[String],
    motion_names: &[String],
    use_message_mode: bool,
    max_characters: usize,
) -> Value {
    let max_characters = max_characters.max(1);
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
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
    if !motion_names.is_empty() {
        let mut motion_enum = Vec::with_capacity(motion_names.len() + 1);
        motion_enum.push("none".to_owned());
        motion_enum.extend(motion_names.iter().cloned());
        properties.insert(
            "motion".into(),
            json!({
                "type": "string",
                "description": "あなたの体の動き(ワンショットモーション)",
                "enum": motion_enum,
            }),
        );
        required.push("motion");
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
        let content = message_text_with_attachments(message, true);
        if role == "user" {
            transcript.push_str(&format!("{{{{user}}}}: {content}\n\n"));
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

pub fn message_text_with_attachments(message: &Value, include_image_placeholders: bool) -> String {
    let mut sections = Vec::new();
    let content = string(message, "content");
    if !content.is_empty() {
        sections.push(content);
    }
    if let Some(attachments) = message.get("attachments").and_then(Value::as_array) {
        for attachment in attachments {
            let kind = string(attachment, "kind");
            let name = string(attachment, "name");
            let data = attachment
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if kind == "file" {
                let label = if name.is_empty() {
                    "ファイル"
                } else {
                    &name
                };
                // data を削られた添付は内容なしのマーカーだけ残す。
                if data.is_empty() {
                    sections.push(format!("[添付ファイル: {label}]"));
                } else {
                    sections.push(format!("[添付ファイル: {label}]\n{data}"));
                }
            } else if include_image_placeholders && kind == "image" {
                let label = if name.is_empty() { "画像" } else { &name };
                sections.push(format!("[添付画像: {label}]"));
            }
        }
    }
    sections.join("\n\n")
}

pub fn message_image_attachment_urls(message: &Value) -> Vec<String> {
    message
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|attachment| string(attachment, "kind") == "image")
        .filter_map(|attachment| attachment.get("data").and_then(Value::as_str))
        .map(str::trim)
        .filter(|data| !data.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn character_setting_is_separated_and_added_last() {
        let character = json!({
            "name": "葵",
            "systemPrompt": "葵として振る舞う",
            "speechStyle": "丁寧語で話し、語尾は柔らかくする",
            "protagonistPrompt": "{{user}}は幼なじみ",
            "userConstraints": "返答は三文以内にする"
        });

        let prompt = character_system_prompt(
            &character,
            ReplyFormat::Structured,
            &[],
            &[],
            Some("これまでの要約"),
            &[InjectedMemory {
                content: "重要なメモリ".into(),
                date_label: None,
            }],
            None,
        );

        let setting_heading = prompt
            .find("# 葵's Profile")
            .expect("character setting heading");
        assert_eq!(prompt.find("# 指示"), Some(0));
        assert!(prompt[..setting_heading].contains("# Summary of the conversation so far"));
        assert!(prompt[..setting_heading].contains("## List of Related Memories"));
        assert!(
            prompt.ends_with("# 葵's Profile\n葵として振る舞う\n\n# Tone example\nThe following are examples of a character's tone of voice. Please use them only as a reference for the character's traits; do not copy these specific phrases directly into your responses.\n\n丁寧語で話し、語尾は柔らかくする\n\n# Details related to {{user}}\n{{user}}は幼なじみ\n\n# Additional constraints\n The instructions in this section take top priority. Please follow them even if they conflict with other settings.\n\n返答は三文以内にする")
        );
    }

    #[test]
    fn related_memories_carry_the_recorded_date() {
        let character = json!({"name": "葵"});

        let prompt = character_system_prompt(
            &character,
            ReplyFormat::Structured,
            &[],
            &[],
            None,
            &[
                InjectedMemory {
                    content: "{{user}}は紅茶を毎朝飲む".into(),
                    date_label: Some("2026-02-14・約3日前".into()),
                },
                InjectedMemory {
                    content: "王都で祭りが起きた".into(),
                    date_label: None,
                },
            ],
            None,
        );

        assert!(prompt.contains("## List of Related Memories\n"));
        assert!(prompt.contains("The [Date/Elapsed Time] entry"));
        assert!(prompt.contains("1. [2026-02-14・約3日前] {{user}}は紅茶を毎朝飲む\n"));
        assert!(prompt.contains("2. 王都で祭りが起きた\n"));
    }

    #[test]
    fn related_memories_are_omitted_when_empty() {
        let character = json!({"name": "葵"});

        let prompt = character_system_prompt(
            &character,
            ReplyFormat::Structured,
            &[],
            &[],
            None,
            &[],
            None,
        );

        assert!(!prompt.contains("## List of Related Memories"));
        assert!(!prompt.contains("The [Date/Elapsed Time] entry"));
    }

    #[test]
    fn character_setting_can_contain_only_speech_style() {
        let character = json!({
            "speechStyle": "くだけた話し方をする"
        });

        assert_eq!(
            character_setting(&character),
            "# Tone example\nThe following are examples of a character's tone of voice. Please use them only as a reference for the character's traits; do not copy these specific phrases directly into your responses.\n\nくだけた話し方をする"
        );
    }

    #[test]
    fn character_setting_can_contain_only_user_constraints() {
        let character = json!({
            "userConstraints": "一人称は私にする"
        });

        assert_eq!(
            character_setting(&character),
            "# Additional constraints\n The instructions in this section take top priority. Please follow them even if they conflict with other settings.\n\n一人称は私にする"
        );
    }

    #[test]
    fn basic_mode_prompt_asks_for_plain_text_without_json() {
        let prompt = character_system_prompt(
            &json!({"name": "葵"}),
            ReplyFormat::PlainText,
            &[],
            &[],
            None,
            &[],
            None,
        );

        assert!(prompt.contains("You are 葵. Please begin the roleplay."));
        assert!(!prompt.contains("Please generate the output in JSON format"));
        assert!(!prompt.contains("Format within the message field"));
        assert!(prompt.contains("## Response format"));
        assert!(prompt.contains("### Output example\n  Good:\n  *夕焼けの光が"));
        assert!(!prompt.contains("{\"message\""));
    }

    #[test]
    fn structured_mode_prompt_keeps_the_json_output_example() {
        let prompt = character_system_prompt(
            &json!({"name": "葵"}),
            ReplyFormat::Structured,
            &[],
            &[],
            None,
            &[],
            None,
        );

        assert!(prompt.contains("Please generate the output in JSON format"));
        assert!(prompt.contains("## Format within the message field"));
        assert!(prompt.contains("### Output example\n  Good:\n  ` {\"message\": \"*夕焼けの光が"));
    }

    #[test]
    fn message_mode_prompt_keeps_the_messenger_instructions() {
        let prompt = character_system_prompt(
            &json!({"name": "葵"}),
            ReplyFormat::Message,
            &[],
            &[],
            None,
            &[],
            None,
        );

        assert!(prompt.contains("Please generate the output in JSON format"));
        assert!(
            prompt.contains("You are currently interacting with {{user}} on **social media**.")
        );
        assert!(prompt.contains("However, this is optional."));
    }

    #[test]
    fn reply_format_follows_the_room_view_mode() {
        assert_eq!(ReplyFormat::from_view_mode("chat"), ReplyFormat::PlainText);
        assert_eq!(ReplyFormat::from_view_mode(""), ReplyFormat::PlainText);
        assert_eq!(ReplyFormat::from_view_mode("message"), ReplyFormat::Message);
        assert_eq!(ReplyFormat::from_view_mode("vn"), ReplyFormat::Structured);
        assert!(ReplyFormat::Message.is_message());
        assert!(ReplyFormat::Structured.is_structured());
        assert!(!ReplyFormat::PlainText.is_message());
        assert!(!ReplyFormat::PlainText.is_structured());
    }

    #[test]
    fn assistant_schema_puts_expression_first() {
        let schema = assistant_schema(&["neutral".into()], &[], false, 512);
        let properties = schema["json_schema"]["schema"]["properties"]
            .as_object()
            .expect("schema properties");

        assert_eq!(
            properties.keys().map(String::as_str).collect::<Vec<_>>(),
            ["expression", "message"]
        );
        assert_eq!(
            schema["json_schema"]["schema"]["required"],
            json!(["expression", "message"])
        );
        assert_eq!(
            schema["json_schema"]["schema"]["properties"]["message"]["maxLength"],
            512
        );
    }

    #[test]
    fn assistant_schema_message_mode_uses_messages_array() {
        let schema = assistant_schema(&[], &[], true, 256);
        let properties = schema["json_schema"]["schema"]["properties"]
            .as_object()
            .expect("schema properties");

        assert_eq!(
            properties.keys().map(String::as_str).collect::<Vec<_>>(),
            ["messages"]
        );
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
    fn assistant_schema_adds_motion_enum_with_none_option() {
        let schema = assistant_schema(
            &["neutral".into()],
            &["wave".into(), "jump".into()],
            false,
            512,
        );
        let properties = schema["json_schema"]["schema"]["properties"]
            .as_object()
            .expect("schema properties");

        assert_eq!(
            properties.keys().map(String::as_str).collect::<Vec<_>>(),
            ["expression", "motion", "message"]
        );
        assert_eq!(
            schema["json_schema"]["schema"]["required"],
            json!(["expression", "motion", "message"])
        );
        assert_eq!(
            schema["json_schema"]["schema"]["properties"]["motion"]["enum"],
            json!(["none", "wave", "jump"])
        );
        assert_eq!(
            schema["json_schema"]["schema"]["properties"]["motion"]["description"],
            "あなたの体の動き(ワンショットモーション)"
        );
    }

    #[test]
    fn assistant_schema_omits_motion_when_no_motions_registered() {
        let schema = assistant_schema(&["neutral".into()], &[], false, 512);
        let properties = schema["json_schema"]["schema"]["properties"]
            .as_object()
            .expect("schema properties");

        assert!(!properties.contains_key("motion"));
        assert_eq!(
            schema["json_schema"]["schema"]["required"],
            json!(["expression", "message"])
        );
    }

    #[test]
    fn character_prompt_lists_motions_after_expression_instruction() {
        let prompt = character_system_prompt(
            &json!({"name": "葵"}),
            ReplyFormat::Structured,
            &["neutral".into(), "happy".into()],
            &["wave".into(), "jump".into()],
            None,
            &[],
            None,
        );

        let expression_index = prompt
            .find("JSONの expression には次から1つだけ選んでください: neutral, happy")
            .expect("expression instruction");
        let motion_index = prompt
            .find(
                "JSONの motion には体の動きを加えたい場合だけ次から1つ選んでください: wave, jump。不要な場合は none を使用してください。",
            )
            .expect("motion instruction");
        assert!(motion_index > expression_index);
    }

    #[test]
    fn character_prompt_omits_motion_instruction_when_no_motions_registered() {
        let prompt = character_system_prompt(
            &json!({"name": "葵"}),
            ReplyFormat::Structured,
            &["neutral".into()],
            &[],
            None,
            &[],
            None,
        );

        assert!(!prompt.contains("JSONの motion"));
    }

    #[test]
    fn character_prompt_includes_active_costume_description() {
        let costume = json!({"name": "uniform", "description": "紺のブレザーと赤いリボン"});

        let prompt = character_system_prompt(
            &json!({"name": "葵"}),
            ReplyFormat::Structured,
            &[],
            &[],
            None,
            &[],
            Some(&costume),
        );

        assert!(prompt.contains("# Current outfit"));
        assert!(prompt.contains("Your current appearance is as follows: 「uniform」"));
        assert!(prompt.contains("紺のブレザーと赤いリボン"));
    }

    #[test]
    fn character_prompt_omits_costume_section_without_description() {
        for costume in [
            json!({"name": "uniform"}),
            json!({"name": "uniform", "description": "  "}),
        ] {
            let prompt = character_system_prompt(
                &json!({"name": "葵"}),
                ReplyFormat::Structured,
                &[],
                &[],
                None,
                &[],
                Some(&costume),
            );

            assert!(!prompt.contains("Current outfit"));
        }
    }

    fn ensemble_cast<'a>(aoi: &'a Value, rin: &'a Value) -> Vec<EnsembleCast<'a>> {
        vec![
            EnsembleCast {
                actor: aoi,
                expression_names: vec!["neutral".into(), "smile".into()],
                motion_names: vec!["wave".into()],
                memories: vec![InjectedMemory {
                    content: "{{user}}は紅茶が好き".into(),
                    date_label: None,
                }],
                costume: None,
            },
            EnsembleCast {
                actor: rin,
                expression_names: Vec::new(),
                motion_names: Vec::new(),
                memories: Vec::new(),
                costume: None,
            },
        ]
    }

    #[test]
    fn ensemble_prompt_lists_every_character_with_their_own_details() {
        let aoi = json!({
            "actorId": "aoi",
            "name": "葵",
            "systemPrompt": "明るい幼なじみ",
            "speechStyle": "〜だよね！",
            "rolePrompt": "クラス委員"
        });
        let rin = json!({"actorId": "rin", "name": "凛", "systemPrompt": "クールな転校生"});
        let situation = json!({
            "situationPrompt": "放課後の教室",
            "characterCommonRules": "全員、敬語で話す"
        });
        let prompt = ensemble_system_prompt(
            &situation,
            &ensemble_cast(&aoi, &rin),
            ReplyFormat::Structured,
            3,
            Some(&rin),
            Some("これまでの要約"),
        );

        assert!(prompt.starts_with("# Instructions"));
        assert!(prompt.contains("Write at most 3 turn(s)."));
        assert!(
            prompt.contains("{{user}} is addressing 凛 (id: rin). The first turn must be 凛's.")
        );
        assert!(prompt.contains("## Situation\n放課後の教室"));
        assert!(prompt.contains("全員、敬語で話す"));
        assert!(prompt.contains("# Summary of the conversation so far\nこれまでの要約"));
        let aoi_section = prompt.find("## 葵 (id: aoi)").expect("aoi section");
        let rin_section = prompt.find("## 凛 (id: rin)").expect("rin section");
        assert!(aoi_section < rin_section);
        let aoi_part = &prompt[aoi_section..rin_section];
        assert!(aoi_part.contains("### Role in this situation\nクラス委員"));
        assert!(aoi_part.contains("### Profile\n明るい幼なじみ"));
        assert!(aoi_part.contains("#### Tone example"));
        assert!(aoi_part.contains("### Expressions\nneutral, smile"));
        assert!(aoi_part.contains("### Motions\nwave"));
        assert!(aoi_part.contains("1. {{user}}は紅茶が好き"));
        let rin_part = &prompt[rin_section..];
        assert!(!rin_part.contains("### Expressions"));
        assert!(!rin_part.contains("related memories"));
    }

    #[test]
    fn ensemble_prompt_omits_speaker_hint_and_expressions_outside_game_mode() {
        let aoi = json!({"actorId": "aoi", "name": "葵"});
        let rin = json!({"actorId": "rin", "name": "凛"});
        let prompt = ensemble_system_prompt(
            &json!({}),
            &ensemble_cast(&aoi, &rin),
            ReplyFormat::Message,
            2,
            None,
            None,
        );
        assert!(!prompt.contains("is addressing"));
        assert!(!prompt.contains("For `expression`"));
        assert!(prompt.contains("**social media**"));
        assert!(prompt.contains(r#""messages": ["確かに。""#));
    }

    #[test]
    fn ensemble_schema_constrains_speakers_and_turn_count() {
        let schema = ensemble_schema(
            &["aoi".into(), "rin".into()],
            &["neutral".into(), "smile".into()],
            &["wave".into()],
            ReplyFormat::Structured,
            300,
            3,
        );
        let turns = &schema["json_schema"]["schema"]["properties"]["turns"];
        assert_eq!(turns["maxItems"], 3);
        let item = &turns["items"];
        assert_eq!(item["properties"]["speaker"]["enum"], json!(["aoi", "rin"]));
        assert_eq!(
            item["properties"]["motion"]["enum"],
            json!(["none", "wave"])
        );
        assert_eq!(item["properties"]["message"]["maxLength"], 300);
        assert_eq!(
            item["required"],
            json!(["speaker", "expression", "motion", "message"])
        );
        let keys = item["properties"]
            .as_object()
            .expect("properties")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(keys.first().map(String::as_str), Some("speaker"));
    }

    #[test]
    fn ensemble_schema_for_basic_and_message_modes_has_no_visual_fields() {
        for (format, field) in [
            (ReplyFormat::PlainText, "message"),
            (ReplyFormat::Message, "messages"),
        ] {
            let schema = ensemble_schema(
                &["aoi".into()],
                &["neutral".into()],
                &["wave".into()],
                format,
                100,
                2,
            );
            let item = &schema["json_schema"]["schema"]["properties"]["turns"]["items"];
            assert_eq!(item["required"], json!(["speaker", field]));
        }
    }
}
