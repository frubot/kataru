use serde_json::{Map, Value, json};

use crate::{
    ai::typesafe::{ChoiceAnswer, SystemOneResponse, choice_answer, noul_answer},
    error::AppResult,
};

use super::prompts::{character_setting, string};

pub(super) const MEMORY_GATE_TIMEOUT_SECS: u64 = 15;
const REASON_THRESHOLD: f64 = 0.5;
const USED_THRESHOLD: f64 = 0.6;
const SETTING_MAX_CHARS: usize = 4000;
const MESSAGE_MAX_CHARS: usize = 1500;
const REPLY_MAX_CHARS: usize = 2400;
const PREVIOUS_MESSAGE_LIMIT: usize = 4;
const NONE_OPTION: &str = "none";
const KNOWN_OPTION: &str = "known";
const NEW_OPTION: &str = "new";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum MemoryGateReason {
    World,
    Character,
    Relationship,
    Protagonist,
    Instruction,
}

impl MemoryGateReason {
    const ALL: [Self; 5] = [
        Self::World,
        Self::Character,
        Self::Relationship,
        Self::Protagonist,
        Self::Instruction,
    ];

    fn id(self) -> &'static str {
        match self {
            Self::World => "world",
            Self::Character => "character",
            Self::Relationship => "relationship",
            Self::Protagonist => "protagonist",
            Self::Instruction => "instruction",
        }
    }

    fn question_id(self) -> String {
        format!("reason_{}", self.id())
    }

    fn subject(self, character_name: &str) -> String {
        match self {
            Self::World => "世界設定（場所・組織・固有名詞・世界のルールなど）".to_owned(),
            Self::Character => {
                format!("{character_name}自身についての情報（経歴・家族・好み・習慣など）")
            }
            Self::Relationship => {
                format!("主人公と{character_name}の関係性・約束・距離感の変化")
            }
            Self::Protagonist => {
                "主人公についての情報（呼び方・好み・苦手・NG・経歴など）".to_owned()
            }
            Self::Instruction => "主人公からの明示的な依頼（「覚えて」「今後は〜して」など、記憶や今後の振る舞いについての依頼）".to_owned(),
        }
    }

    pub(super) fn save_reason(self) -> &'static str {
        match self {
            Self::World => {
                "世界設定（場所・組織・固有名詞・世界のルール）の新しい情報。scope は world"
            }
            Self::Character => {
                "対象キャラクター自身（経歴・家族・好み・習慣）の新しい情報。scope は character"
            }
            Self::Relationship => {
                "主人公と対象キャラクターの関係性・約束・距離感の変化。scope は relationship"
            }
            Self::Protagonist => {
                "主人公（呼び方・好み・苦手・NG・経歴）の新しい情報。scope は character"
            }
            Self::Instruction => {
                "主人公から明示的に依頼された、覚えておくことや今後守ること。kind は instruction"
            }
        }
    }
}

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
                    "主人公"
                } else {
                    character_name.as_str()
                },
                "text": truncate(&string(message, "content"), MESSAGE_MAX_CHARS),
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

pub(super) fn memory_gate_questions(character_name: &str, memories: &[String]) -> Value {
    let mut questions = Map::new();
    for reason in MemoryGateReason::ALL {
        let subject = reason.subject(character_name);
        questions.insert(
            reason.question_id(),
            json!({
                "type": "choice",
                "instructions": format!("`latestTurn` に含まれる{subject}は、`characterSetting` と `savedMemories` に対してどれに当たりますか。"),
                "criteria": {
                    NONE_OPTION: format!("`latestTurn` に{subject}がない。その場限りの動作・感情・相づちだけである"),
                    KNOWN_OPTION: format!("{subject}はあるが、すべて `characterSetting` か `savedMemories` に既に書かれている"),
                    NEW_OPTION: format!("`characterSetting` にも `savedMemories` にも書かれていない{subject}が1つ以上ある"),
                },
            }),
        );
    }
    for (index, memory) in memories.iter().enumerate() {
        questions.insert(
            used_question_id(index),
            json!({
                "type": "noul",
                "instructions": {
                    "memory": memory,
                    "question": "`latestTurn.characterReply` は `memory` の内容に言及している、または `memory` の内容を前提にしている。",
                },
            }),
        );
    }
    Value::Object(questions)
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct MemoryGateDecision {
    pub(super) reasons: Vec<MemoryGateReason>,
    pub(super) used_memory_ids: Vec<String>,
    new_probabilities: Vec<(MemoryGateReason, f64)>,
}

impl MemoryGateDecision {
    pub(super) fn should_extract(&self) -> bool {
        !self.reasons.is_empty()
    }

    pub(super) fn summary(&self) -> Value {
        json!({
            "shouldExtract": self.should_extract(),
            "saveReasons": self.reasons.iter().map(|reason| reason.id()).collect::<Vec<_>>(),
            "newProbabilities": self
                .new_probabilities
                .iter()
                .map(|(reason, probability)| (reason.id().to_owned(), json!(probability)))
                .collect::<Map<_, _>>(),
            "usedMemoryIds": self.used_memory_ids,
        })
    }
}

pub(super) fn evaluate_memory_gate(
    response: &SystemOneResponse,
    memory_ids: &[String],
) -> AppResult<MemoryGateDecision> {
    let mut reasons = Vec::new();
    let mut new_probabilities = Vec::new();
    for reason in MemoryGateReason::ALL {
        let probability = new_probability(&choice_answer(response, &reason.question_id())?);
        new_probabilities.push((reason, probability));
        if probability >= REASON_THRESHOLD {
            reasons.push(reason);
        }
    }
    let mut used_memory_ids = Vec::new();
    for (index, memory_id) in memory_ids.iter().enumerate() {
        if noul_answer(response, &used_question_id(index))?.noul >= USED_THRESHOLD {
            used_memory_ids.push(memory_id.clone());
        }
    }
    Ok(MemoryGateDecision {
        reasons,
        used_memory_ids,
        new_probabilities,
    })
}

fn new_probability(answer: &ChoiceAnswer) -> f64 {
    answer
        .probabilities
        .get(NEW_OPTION)
        .copied()
        .unwrap_or(if answer.choice == NEW_OPTION {
            1.0
        } else {
            0.0
        })
}

fn split_latest_turn(history: &[Value], continuation: bool) -> (&[Value], Option<String>) {
    match history.split_last() {
        Some((last, previous)) if !continuation && string(last, "role") == "user" => {
            (previous, Some(string(last, "content")))
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

    fn reason_answers(new_probabilities: &[(&str, f64)]) -> Map<String, Value> {
        MemoryGateReason::ALL
            .iter()
            .map(|reason| {
                let probability = new_probabilities
                    .iter()
                    .find(|(id, _)| *id == reason.id())
                    .map_or(0.05, |(_, probability)| *probability);
                (
                    reason.question_id(),
                    json!({
                        "type": "choice",
                        "choice": if probability >= 0.5 { NEW_OPTION } else { NONE_OPTION },
                        "probabilities": {
                            NONE_OPTION: 1.0 - probability,
                            KNOWN_OPTION: 0.0,
                            NEW_OPTION: probability,
                        },
                        "confidence": 0.8,
                    }),
                )
            })
            .collect()
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
        let memories = vec!["主人公は紅茶が好き".to_owned()];

        let state = memory_gate_state(&MemoryGateTurn {
            character: &character,
            history: &history,
            reply: &reply,
            memories: &memories,
            continuation: false,
        });

        assert_eq!(state["targetCharacter"], "葵");
        assert_eq!(state["characterSetting"], "明るい高校生");
        assert_eq!(state["savedMemories"], json!(["主人公は紅茶が好き"]));
        assert_eq!(state["latestTurn"]["protagonist"], "猫が苦手なんだ");
        assert_eq!(
            state["latestTurn"]["characterReply"],
            "そうなんだ\n覚えておくね"
        );
        let previous = state["previousMessages"].as_array().expect("previous");
        assert_eq!(previous.len(), PREVIOUS_MESSAGE_LIMIT);
        assert_eq!(previous[0]["text"], "message-2");
        assert_eq!(previous[0]["speaker"], "主人公");
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
    fn questions_cover_every_reason_and_each_memory() {
        let memories = vec!["主人公は猫が苦手".to_owned(), "葵は弓道部".to_owned()];
        let questions = memory_gate_questions("葵", &memories);
        let questions = questions.as_object().expect("questions");

        assert_eq!(
            questions.len(),
            MemoryGateReason::ALL.len() + memories.len()
        );
        let relationship = &questions["reason_relationship"];
        assert_eq!(relationship["type"], "choice");
        let criteria = relationship["criteria"].as_object().expect("criteria");
        assert_eq!(
            criteria.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![NONE_OPTION, KNOWN_OPTION, NEW_OPTION]
        );
        assert!(
            relationship["instructions"]
                .as_str()
                .is_some_and(|instructions| instructions.contains("主人公と葵の関係性"))
        );
        assert_eq!(questions["used_1"]["type"], "noul");
        assert_eq!(questions["used_1"]["instructions"]["memory"], "葵は弓道部");
    }

    #[test]
    fn decision_keeps_reasons_and_memories_above_thresholds() {
        let mut answers = reason_answers(&[("world", 0.72), ("protagonist", 0.49)]);
        answers.insert("used_0".to_owned(), json!({"type": "noul", "noul": 0.91}));
        answers.insert("used_1".to_owned(), json!({"type": "noul", "noul": 0.59}));
        let memory_ids = vec!["memory-a".to_owned(), "memory-b".to_owned()];

        let decision =
            evaluate_memory_gate(&response(Value::Object(answers)), &memory_ids).expect("decision");

        assert!(decision.should_extract());
        assert_eq!(decision.reasons, vec![MemoryGateReason::World]);
        assert_eq!(decision.used_memory_ids, vec!["memory-a"]);
        assert_eq!(decision.summary()["saveReasons"], json!(["world"]));
        assert_eq!(decision.summary()["newProbabilities"]["protagonist"], 0.49);
    }

    #[test]
    fn decision_without_new_information_skips_extraction() {
        let decision = evaluate_memory_gate(&response(Value::Object(reason_answers(&[]))), &[])
            .expect("decision");

        assert!(!decision.should_extract());
        assert!(decision.used_memory_ids.is_empty());
    }

    #[test]
    fn choice_without_probabilities_uses_the_selected_option() {
        let mut answers = reason_answers(&[]);
        answers.insert(
            "reason_instruction".to_owned(),
            json!({"type": "choice", "choice": NEW_OPTION}),
        );

        let decision =
            evaluate_memory_gate(&response(Value::Object(answers)), &[]).expect("decision");

        assert_eq!(decision.reasons, vec![MemoryGateReason::Instruction]);
    }

    #[test]
    fn missing_answers_fail_the_gate() {
        let answers = reason_answers(&[]);
        assert!(
            evaluate_memory_gate(&response(Value::Object(answers)), &["memory-a".to_owned()])
                .is_err()
        );
        assert!(evaluate_memory_gate(&response(json!({})), &[]).is_err());
    }
}
