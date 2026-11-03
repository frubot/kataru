use serde_json::{Map, Value, json};

use crate::{
    ai::typesafe::{SystemOneResponse, noul_answer},
    error::AppResult,
};

use super::prompts::{character_setting, message_text_with_attachments, string};

pub(super) const MEMORY_GATE_TIMEOUT_SECS: u64 = 15;
const USED_THRESHOLD: f64 = 0.6;
const SETTING_MAX_CHARS: usize = 4000;
const MESSAGE_MAX_CHARS: usize = 1500;
const REPLY_MAX_CHARS: usize = 2400;
const PREVIOUS_MESSAGE_LIMIT: usize = 4;

pub(super) struct MemoryGateTurn<'a> {
    pub(super) character: &'a Value,
    pub(super) history: &'a [Value],
    pub(super) reply: &'a [Value],
    pub(super) memories: &'a [String],
    pub(super) continuation: bool,
}

pub(super) fn memory_gate_state(turn: &MemoryGateTurn<'_>) -> Value {
    let character_name = string(turn.character, "name");
    let (previous, protagonist) = split_latest_turn(turn.history, turn.continuation);
    let previous = previous[previous.len().saturating_sub(PREVIOUS_MESSAGE_LIMIT)..]
        .iter()
        .map(|message| {
            json!({
                "speaker": if string(message, "role") == "user" {
                    "{{user}}"
                } else {
                    character_name.as_str()
                },
                "text": truncate(&message_text_with_attachments(message, true), MESSAGE_MAX_CHARS),
            })
        })
        .collect::<Vec<_>>();
    let reply = turn
        .reply
        .iter()
        .map(|message| string(message, "content"))
        .filter(|content| !content.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let mut latest_turn = Map::new();
    if let Some(protagonist) = protagonist {
        latest_turn.insert(
            "protagonist".to_owned(),
            Value::String(truncate(&protagonist, MESSAGE_MAX_CHARS)),
        );
    }
    latest_turn.insert(
        "characterReply".to_owned(),
        Value::String(truncate(&reply, REPLY_MAX_CHARS)),
    );
    json!({
        "targetCharacter": character_name,
        "characterSetting": truncate(&character_setting(turn.character), SETTING_MAX_CHARS),
        "savedMemories": turn.memories,
        "previousMessages": previous,
        "latestTurn": latest_turn,
    })
}

/// 返答が保存済みの記憶を使ったかどうかを、記憶ごとに Decision へ問う。
pub(super) fn memory_gate_questions(memories: &[String]) -> Value {
    let questions = memories
        .iter()
        .enumerate()
        .map(|(index, memory)| {
            (
                used_question_id(index),
                json!({
                    "type": "noul",
                    "instructions": {
                        "memory": memory,
                        "question": "`latestTurn.characterReply` は `memory` の内容に言及している、または `memory` の内容を前提にしている。",
                    },
                }),
            )
        })
        .collect::<Map<_, _>>();
    Value::Object(questions)
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct MemoryGateDecision {
    pub(super) used_memory_ids: Vec<String>,
}

impl MemoryGateDecision {
    pub(super) fn summary(&self) -> Value {
        json!({ "usedMemoryIds": self.used_memory_ids })
    }
}

pub(super) fn evaluate_memory_gate(
    response: &SystemOneResponse,
    memory_ids: &[String],
) -> AppResult<MemoryGateDecision> {
    let mut used_memory_ids = Vec::new();
    for (index, memory_id) in memory_ids.iter().enumerate() {
        if noul_answer(response, &used_question_id(index))?.noul >= USED_THRESHOLD {
            used_memory_ids.push(memory_id.clone());
        }
    }
    Ok(MemoryGateDecision { used_memory_ids })
}

fn split_latest_turn(history: &[Value], continuation: bool) -> (&[Value], Option<String>) {
    match history.split_last() {
        Some((last, previous)) if !continuation && string(last, "role") == "user" => {
            (previous, Some(message_text_with_attachments(last, true)))
        }
        _ => (history, None),
    }
}

fn used_question_id(index: usize) -> String {
    format!("used_{index}")
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(answers: Value) -> SystemOneResponse {
        serde_json::from_value(json!({"model": "jev-latest", "answers": answers}))
            .expect("response must parse")
    }

    #[test]
    fn state_separates_the_latest_turn_from_previous_context() {
        let character = json!({"name": "葵", "systemPrompt": "明るい高校生"});
        let history = (0..6)
            .map(|index| {
                json!({
                    "role": if index % 2 == 0 { "user" } else { "assistant" },
                    "content": format!("message-{index}"),
                })
            })
            .chain([json!({"role": "user", "content": "猫が苦手なんだ"})])
            .collect::<Vec<_>>();
        let reply = vec![
            json!({"role": "assistant", "content": "そうなんだ"}),
            json!({"role": "assistant", "content": "覚えておくね"}),
        ];
        let memories = vec!["{{user}}は紅茶が好き".to_owned()];

        let state = memory_gate_state(&MemoryGateTurn {
            character: &character,
            history: &history,
            reply: &reply,
            memories: &memories,
            continuation: false,
        });

        assert_eq!(state["targetCharacter"], "葵");
        assert_eq!(state["characterSetting"], "明るい高校生");
        assert_eq!(state["savedMemories"], json!(["{{user}}は紅茶が好き"]));
        assert_eq!(state["latestTurn"]["protagonist"], "猫が苦手なんだ");
        assert_eq!(
            state["latestTurn"]["characterReply"],
            "そうなんだ\n覚えておくね"
        );
        let previous = state["previousMessages"].as_array().expect("previous");
        assert_eq!(previous.len(), PREVIOUS_MESSAGE_LIMIT);
        assert_eq!(previous[0]["text"], "message-2");
        assert_eq!(previous[0]["speaker"], "{{user}}");
        assert_eq!(previous[1]["speaker"], "葵");
    }

    #[test]
    fn continuation_turn_has_no_protagonist_message() {
        let character = json!({"name": "葵"});
        let history = vec![
            json!({"role": "user", "content": "こんにちは"}),
            json!({"role": "assistant", "content": "やあ"}),
        ];
        let reply = vec![json!({"role": "assistant", "content": "続きだよ"})];

        let state = memory_gate_state(&MemoryGateTurn {
            character: &character,
            history: &history,
            reply: &reply,
            memories: &[],
            continuation: true,
        });

        assert!(state["latestTurn"].get("protagonist").is_none());
        assert_eq!(state["previousMessages"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn questions_ask_about_each_memory() {
        let memories = vec!["{{user}}は猫が苦手".to_owned(), "葵は弓道部".to_owned()];
        let questions = memory_gate_questions(&memories);
        let questions = questions.as_object().expect("questions");

        assert_eq!(questions.len(), memories.len());
        assert_eq!(questions["used_1"]["type"], "noul");
        assert_eq!(questions["used_1"]["instructions"]["memory"], "葵は弓道部");
    }

    #[test]
    fn decision_keeps_memories_above_the_threshold() {
        let answers = json!({
            "used_0": {"type": "noul", "noul": 0.91},
            "used_1": {"type": "noul", "noul": 0.59},
        });
        let memory_ids = vec!["memory-a".to_owned(), "memory-b".to_owned()];

        let decision = evaluate_memory_gate(&response(answers), &memory_ids).expect("decision");

        assert_eq!(decision.used_memory_ids, vec!["memory-a"]);
        assert_eq!(decision.summary()["usedMemoryIds"], json!(["memory-a"]));
    }

    #[test]
    fn missing_answers_fail_the_gate() {
        assert!(evaluate_memory_gate(&response(json!({})), &["memory-a".to_owned()]).is_err());
    }
}
