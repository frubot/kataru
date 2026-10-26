use serde_json::{Map, Value, json};

pub const SUMMARY_RECENT_USER_TURNS_TO_KEEP: usize = 3;
pub const DIRECTOR_TRANSCRIPT_USER_HISTORY: usize = 2;

pub const JEV_PROTAGONIST_OPTION: &str = "protagonist";
pub const JEV_CONVERSATION_COMPLETE_OPTION: &str = "conversation-complete";
pub const JEV_END_OPTION: &str = "end";

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
    situation: Option<&Value>,
    participants: &[Value],
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

    if let Some(situation) = situation {
        if participants.len() > 1 {
            let names = participants
                .iter()
                .filter_map(|actor| actor.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(", ");
            prompt.push_str(&format!(
                "\n\nYou shall speak only as \"{}\" and must not portray any other characters. Characters other than you: {{{{user}}}}, {names}",
                character_name
            ));
        }
        let situation_prompt = string(situation, "situationPrompt");
        if !situation_prompt.is_empty() {
            prompt.push_str(&format!("\n\n## Situation\n{situation_prompt}"));
        }
        // 参加キャラクター全員に共通で適用するルール。指揮役の判断材料にはしない。
        let common_rules = string(situation, "characterCommonRules");
        if !common_rules.is_empty() {
            prompt.push_str(&format!(
                "\n\n## General Rules for Characters\nThe following rules apply to all participating characters. Please ensure you follow them.\n\n{common_rules}"
            ));
        }
        let role_prompt = string(character, "rolePrompt");
        if !role_prompt.is_empty() {
            prompt.push_str(&format!("\n\n# About You\n{role_prompt}"));
        }
    }
    if let Some(summary) = summary.filter(|value| !value.trim().is_empty()) {
        prompt.push_str(&format!("\n\n# Summary of the conversation so far\n{}", summary.trim()));
    }
    if !relevant_memories.is_empty() {
        prompt.push_str("\n\n## List of Related Memories\n");
        prompt.push_str(
            "The [Date/Elapsed Time] entry in each row indicates the date on which the event was recorded.\n",
        );
        for (index, memory) in relevant_memories.iter().enumerate() {
            let number = index + 1;
            match memory.date_label.as_deref() {
                Some(label) if !label.is_empty() => {
                    prompt.push_str(&format!("{number}. [{label}] {}\n", memory.content));
                }
                _ => prompt.push_str(&format!("{number}. {}\n", memory.content)),
            }
        }
    }
    let setting = character_setting(character);
    if !setting.is_empty() {
        prompt.push_str(&format!("\n\n# {}'s Profile'\n{setting}", character_name));
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
        "{{user}}が発言すべき場合や自動会話を終える場合は空配列にしてください。"
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
        "{{user}}からの新しい発言や行動はありません。会話履歴の末尾から自然に場面を進める一人を必ず候補の先頭にしてください。"
    } else if turn_index == 0 {
        "{{user}}の最新発言に反応するのに最適な一人を必ず候補の先頭にしてください。"
    } else {
        "次の発言が自然なキャラクターを選ぶか、{{user}}に発言させるなら空配列にしてください。"
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
            "transcript": "{{user}}: 凛、昨日の試合見たよ。すごかったね\n\n葵: 私も見てた！最後の得点は鳥肌ものだったよ",
            "answer": {"next_speaker": "rin", "continue_naturally": 0.8},
        },
        {
            "actors": [
                {"id": "aoi", "name": "葵"},
                {"id": "rin", "name": "凛"},
            ],
            "transcript": "{{user}}: 週末みんなで映画見に行かない？\n\n凛: いいね！葵は何が見たい？",
            "answer": {"next_speaker": "aoi", "continue_naturally": 0.9},
        },
        {
            "actors": [
                {"id": "aoi", "name": "葵"},
                {"id": "rin", "name": "凛"},
            ],
            "transcript": "{{user}}: 今日は疲れたなあ\n\n葵: おつかれ～。\n\n凛: おつかれ！ねえ、三人で放課後どこか寄ってかない？",
            "answer": {"next_speaker": "protagonist", "continue_naturally": 0.15},
        },
        {
            "actors": [
                {"id": "aoi", "name": "葵"},
                {"id": "rin", "name": "凛"},
            ],
            "transcript": "{{user}}: じゃあまた明日ね。\n\n葵: うん、また明日！\n\n凛: おつかれさまー",
            "answer": {"next_speaker": "conversation-complete", "continue_naturally": 0.7},
        },
        {
            "actors": [
                {"id": "aoi", "name": "葵"},
            ],
            "transcript": "{{user}}: ありがとう、もう行くね\n\n葵: うん、気をつけてね。また明日！",
            "answer": {"next_speaker": "end", "continue_naturally": 0.05},
        },
        {
            "actors": [
                {"id": "aoi", "name": "葵"},
                {"id": "rin", "name": "凛"},
            ],
            "transcript": "葵: はい、私の手作り料理を召し上がれ。\n\n{{user}}: おお、やっぱり葵は料理が上手いなぁ、凛そう思わない？\n\n",
            "answer": {"next_speaker": "rin", "continue_naturally": 0.9},
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
        criteria.insert(id, Value::String(string(actor, "name")));
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
        Value::String("{{user}}が次に発言すべき。".to_owned()),
    );
    criteria.insert(
        JEV_CONVERSATION_COMPLETE_OPTION.to_owned(),
        Value::String("会話を終了するが、キャラクター同士が会話を続けても違和感がない".to_owned()),
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
            ReplyFormat::Structured,
            &[],
            &[],
            None,
            &[],
            Some(&situation),
            &participants,
            None,
        );

        assert!(!prompt.contains("複数人が参加しています"));
        assert!(!prompt.contains("発言順は指揮役が決めます"));
        assert!(prompt.starts_with("# 指示"));
        assert!(prompt.contains("## シチュエーション\n放課後の教室"));
        assert!(prompt.contains("# あなたについて\n幼なじみ"));
        assert!(
            prompt.contains("Users may include not only spoken lines but also stage directions")
        );
        assert!(!prompt.contains("括弧などを使って"));
        assert!(prompt.ends_with("# 葵の設定\n葵として振る舞う"));
    }

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
            &[],
            None,
        );

        let setting_heading = prompt
            .find("# 葵の設定")
            .expect("character setting heading");
        assert_eq!(prompt.find("# 指示"), Some(0));
        assert!(prompt[..setting_heading].contains("# これまでの会話の要約"));
        assert!(prompt[..setting_heading].contains("## 関連するメモリ"));
        assert!(
            prompt.ends_with("# 葵の設定\n葵として振る舞う\n\n# Tone example\nThe following are examples of a character's tone of voice. Please use them only as a reference for the character's traits; do not copy these specific phrases directly into your responses.\n\n丁寧語で話し、語尾は柔らかくする\n\n# Details related to {{user}}\n{{user}}は幼なじみ\n\n# Additional constraints\n The instructions in this section take top priority. Please follow them even if they conflict with other settings.\n\n返答は三文以内にする")
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
            &[],
            None,
        );

        assert!(prompt.contains("## 関連するメモリ\n"));
        assert!(prompt.contains("はその記憶を知った時期です"));
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
            &[],
            None,
        );

        assert!(!prompt.contains("## 関連するメモリ"));
        assert!(!prompt.contains("はその記憶を知った時期です"));
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
    fn multi_participant_prompt_keeps_multi_participant_instructions() {
        let character = json!({"name": "葵"});
        let situation = json!({});
        let participants = vec![json!({"name": "葵"}), json!({"name": "凛"})];

        let prompt = character_system_prompt(
            &character,
            ReplyFormat::Structured,
            &[],
            &[],
            None,
            &[],
            Some(&situation),
            &participants,
            None,
        );

        assert!(prompt.contains("複数人が参加しています"));
        assert!(prompt.contains("参加者: {{user}}, 葵, 凛"));
    }

    #[test]
    fn character_prompt_includes_common_rules_after_the_situation() {
        let character = json!({"name": "葵", "rolePrompt": "幼なじみ"});
        let situation = json!({
            "situationPrompt": "放課後の教室",
            "characterCommonRules": "全員、敬語で話す"
        });

        let prompt = character_system_prompt(
            &character,
            ReplyFormat::Structured,
            &[],
            &[],
            None,
            &[],
            Some(&situation),
            &[json!({"name": "葵"})],
            None,
        );

        let situation_index = prompt
            .find("## シチュエーション\n放課後の教室")
            .expect("situation section");
        let rules_index = prompt
            .find("## キャラクターの共通ルール")
            .expect("common rules section");
        assert!(rules_index > situation_index);
        assert!(prompt.contains("全員、敬語で話す"));
        assert!(rules_index < prompt.find("# あなたについて").expect("role section"));
    }

    #[test]
    fn character_prompt_omits_common_rules_when_unset() {
        let prompt = character_system_prompt(
            &json!({"name": "葵"}),
            ReplyFormat::Structured,
            &[],
            &[],
            None,
            &[],
            Some(&json!({"situationPrompt": "放課後の教室"})),
            &[json!({"name": "葵"})],
            None,
        );

        assert!(!prompt.contains("キャラクターの共通ルール"));
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
            None,
            &[],
            Some(&costume),
        );

        assert!(prompt.contains("# 現在の衣装"));
        assert!(prompt.contains("あなたの現在の外観は次のとおりです: 「uniform」"));
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
                None,
                &[],
                Some(&costume),
            );

            assert!(!prompt.contains("現在の衣装"));
        }
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
            "{{user}}: 今日は寒いね\n葵: 雪になるかも",
            0,
            1,
            None,
            true,
        );

        assert!(system.contains("candidates は必ず1件以上にしてください"));
        assert!(!system.contains("空配列にしてください"));
        assert!(prompt.contains("{{user}}からの新しい発言や行動はありません"));
        assert!(prompt.contains("会話履歴の末尾から自然に場面を進める"));
        assert!(!prompt.contains("## 最新のメッセージ"));
    }

    #[test]
    fn director_prompt_allows_empty_candidates_outside_continuation() {
        let (system, _) = director_prompts(&json!({}), &[], "", 0, 1, None, false);

        assert!(system.contains("空配列にしてください"));
    }

    #[test]
    fn director_prompts_never_receive_character_common_rules() {
        let situation = json!({
            "name": "放課後",
            "situationPrompt": "教室で話している",
            "characterCommonRules": "全員、敬語で話す"
        });
        let actors = vec![json!({"actorId": "actor-aoi", "name": "葵"})];

        let (system, prompt) = director_prompts(
            &situation,
            &actors,
            "{{user}}: 今日は寒いね",
            0,
            1,
            None,
            false,
        );
        let state = director_jev_state(&situation, &actors, "{{user}}: 今日は寒いね", 0, 1);

        for text in [system, prompt, state.to_string()] {
            assert!(!text.contains("全員、敬語で話す"));
            assert!(!text.contains("キャラクターの共通ルール"));
        }
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
        assert_eq!(criteria["actor-aoi"], "葵");
        assert_eq!(criteria["actor-rin"], "凛");
        assert!(!questions.to_string().contains("幼なじみ"));

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
            "{{user}}: 今日は寒いね\n葵: 雪になるかも",
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
