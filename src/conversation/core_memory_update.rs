//! 常駐記憶の自動更新に使うプロンプト・スキーマ・出力の読み取り。
//!
//! 記憶のバッチ抽出の後に呼び、AI に差分の指示（add / replace / remove / demote）を出させる。
//! 適用できなかった指示があれば、会話ログは送らずに今の常駐記憶と理由だけを返してやり直させる。

use serde_json::{Value, json};

use crate::core_memory::{
    CoreMemory, CoreMemoryEntry, CoreMemoryOp, CoreMemorySection, RejectedOp,
};

/// 1回の応答で受け付ける指示の上限。
pub(super) const CORE_MEMORY_MAX_OPS: usize = 12;
/// 適用できなかった指示があったときのやり直しの上限。
pub(super) const CORE_MEMORY_MAX_RETRIES: usize = 2;

pub(super) fn core_memory_update_prompt() -> &'static str {
    r#"あなたはロールプレイチャットの「常駐記憶」を管理する編集者です。キャラクターとして返答してはいけません。

## 常駐記憶とは

- キャラクターが話題に関係なく毎回参照する、短いプロフィール帳です。
- 日記でも場面メモでもありません。出来事そのものではなく、出来事の結果として変わり、しばらく続く状態を書きます。
  - 例: 「3月に告白してOKをもらった」ではなく「{{user}}とは恋人同士。まだ照れがある」
- 見出しは3つです。
  - user: {{user}}について（名前、呼び方、NG・地雷、大事な属性、強い好み）
  - relationship: {{user}}との関係、距離感、呼び合い方、まだ果たしていない約束、{{user}}への気持ち
  - self: characterSystemPrompt の設定から変わった、キャラクター自身の続いている状態
    - 見た目の変化（髪を短く切った、眼鏡をやめた）
    - 立場・環境の変化（部活を辞めた、一人暮らしを始めた、バイトを始めた）
    - 数日以上続く体の状態（足を怪我している）
    - 新しく決めた目標や習慣（料理の練習を始めた）
    - いつも身に着けている物・大事にしている物
- 見出しの境界
  - {{user}}への気持ちや{{user}}との約束は、キャラクター自身のことでも relationship に書きます。
  - キャラクターが知った{{user}}の情報は user に書きます。

## 常駐記憶に入れるもの

次のどれかに当てはまるものだけを入れます。

- 話題に関係なく毎回効いてほしい
- 忘れると会話がおかしくなる（名前や呼び方を間違える、関係を忘れる など）
- 場面が変わっても、翌日になっても正しい状態

## 常駐記憶に入れないもの

- 今の場面の描写: いる場所、一緒にいる人、今していること、時間帯、天気、その場の服装や姿勢
  - 例: 「キャラクターの家で{{user}}と話している」「カフェでケーキを食べている」「夜、ベッドに座っている」
  - 判断の目安: 場面が変わったら正しくなくなるなら入れません。
- その場だけの気分や体調（眠い、少し怒っている、お腹が空いた）
- 細かい好み、過去のエピソード、果たし終わった約束、固有名詞の説明。これらは検索される記憶が受け持ちます。
- characterSystemPrompt にすでに書かれている内容

すでに常駐記憶に場面の描写やその場だけの気分が入っていたら remove します。

## 入力

- coreMemory: 今の常駐記憶。各行の先頭に ID（u1, r2, s3 など）があります。(locked) の行はユーザーが固定した行なので、変更・削除・移動できません。最後に今の文字数と上限があります。
- summary: それより前の会話の要約
- messages: 今回新しく読んだ会話
- newMemories: 今回の会話から抽出され、検索される記憶として保存された内容。常駐記憶に入れるべきものがあれば反映します。

## 出力

{"ops": [...]} 形式の JSON だけを出力します。Markdown や説明文を含めてはいけません。変更が不要なら ops は空配列です。

- add: section と text を指定して1行追加します。id は空文字にします。
- replace: id と text を指定して、その行を書き換えます。状態が変わったときは、新しい行を足すのではなく古い行を書き換えます。section は空文字にします。
- remove: id を指定して、もう正しくない行を消します。text と section は空文字にします。
- demote: id を指定して、常駐記憶から外し、検索される記憶へ移します。今は毎回参照するほどではないが、忘れたくはない内容に使います。text と section は空文字にします。

## 守ること

- 1行には1つの事柄だけを、短く書きます（200文字まで）。
- 全体の文字数が上限を超えないようにします。空きが足りないときは、重要度の低い行を demote してから追加します。
- 同じ内容の行を重複させません。
- {{user}} はそのまま {{user}} と書きます。"#
}

pub(super) fn core_memory_ops_schema() -> Value {
    json!({
        "name": "core_memory_ops",
        "strict": true,
        "schema": {
            "type": "object",
            "properties": {
                "ops": {
                    "type": "array",
                    "maxItems": CORE_MEMORY_MAX_OPS,
                    "items": {
                        "type": "object",
                        "properties": {
                            "op": {
                                "type": "string",
                                "enum": ["add", "replace", "remove", "demote"]
                            },
                            "id": {
                                "type": "string",
                                "description": "Target line ID for replace/remove/demote. Empty for add."
                            },
                            "section": {
                                "type": "string",
                                "enum": ["user", "relationship", "self", ""],
                                "description": "Section for add. Empty otherwise."
                            },
                            "text": {
                                "type": "string",
                                "description": "New line text in Japanese for add/replace. Empty otherwise."
                            }
                        },
                        "required": ["op", "id", "section", "text"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["ops"],
            "additionalProperties": false
        }
    })
}

/// 最初の依頼の本文。
pub(super) fn core_memory_update_request(
    character_name: &str,
    character_setting: &str,
    memory: &CoreMemory,
    max_chars: usize,
    summary: &str,
    messages: &[Value],
    new_memories: &[String],
) -> Value {
    json!({
        "targetCharacter": character_name,
        "characterSystemPrompt": character_setting,
        "coreMemory": memory.render_for_update(max_chars),
        "summary": summary,
        "messages": messages,
        "newMemories": new_memories,
    })
}

/// やり直しの依頼の本文。会話ログは送らず、今の常駐記憶と適用できなかった理由だけを渡す。
pub(super) fn core_memory_retry_request(
    memory: &CoreMemory,
    max_chars: usize,
    rejected: &[RejectedOp],
) -> Value {
    json!({
        "coreMemory": memory.render_for_update(max_chars),
        "rejectedOps": rejected
            .iter()
            .map(|rejected| {
                let mut op = op_to_json(&rejected.op);
                op["reason"] = Value::String(rejected.reason.clone());
                op
            })
            .collect::<Vec<_>>(),
        "instruction": "前回の指示のうち、上の rejectedOps は適用できませんでした（ほかの指示は coreMemory に適用済みです）。理由を読み、必要なものだけを直した指示を出してください。適用済みの指示を繰り返してはいけません。諦めてよいものは出さなくてかまいません。",
    })
}

fn op_to_json(op: &CoreMemoryOp) -> Value {
    match op {
        CoreMemoryOp::Add { section, text } => {
            json!({"op": "add", "id": "", "section": section.as_str(), "text": text})
        }
        CoreMemoryOp::Replace { id, text } => {
            json!({"op": "replace", "id": id, "section": "", "text": text})
        }
        CoreMemoryOp::Remove { id } => json!({"op": "remove", "id": id, "section": "", "text": ""}),
        CoreMemoryOp::Demote { id } => json!({"op": "demote", "id": id, "section": "", "text": ""}),
    }
}

/// AI の出力を読む。形が合わない指示は捨てる。
pub(super) fn parse_core_memory_ops(content: &str) -> Vec<CoreMemoryOp> {
    let Ok(parsed) = serde_json::from_str::<Value>(strip_json_code_fence(content)) else {
        return Vec::new();
    };
    parsed
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_op)
        .take(CORE_MEMORY_MAX_OPS)
        .collect()
}

fn parse_op(value: &Value) -> Option<CoreMemoryOp> {
    let field = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned()
    };
    let id = field("id");
    let text = field("text");
    match field("op").as_str() {
        "add" => Some(CoreMemoryOp::Add {
            section: CoreMemorySection::parse(&field("section"))?,
            text: non_empty(text)?,
        }),
        "replace" => Some(CoreMemoryOp::Replace {
            id: non_empty(id)?,
            text: non_empty(text)?,
        }),
        "remove" => Some(CoreMemoryOp::Remove { id: non_empty(id)? }),
        "demote" => Some(CoreMemoryOp::Demote { id: non_empty(id)? }),
        _ => None,
    }
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
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

/// 常駐記憶から外した行を、検索される記憶の候補にする。
pub(super) fn demoted_memory_candidate(entry: &CoreMemoryEntry) -> Value {
    let (scope, kind) = match entry.section {
        CoreMemorySection::Relationship => ("relationship", "relationship"),
        CoreMemorySection::User | CoreMemorySection::SelfState => ("character", "fact"),
    };
    json!({
        "content": entry.text,
        "scope": scope,
        "kind": kind,
        "importance": 0.75,
        "confidence": 0.9,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_memory::{CoreMemoryAuthor, DEFAULT_CORE_MEMORY_MAX_CHARS, apply_ops};

    #[test]
    fn ops_are_parsed_leniently() {
        let content = r#"```json
{"ops": [
  {"op": "add", "id": "", "section": "relationship", "text": " 週末に水族館へ行く約束 "},
  {"op": "replace", "id": "r2", "section": "", "text": "{{user}}とは恋人同士"},
  {"op": "remove", "id": "u1", "section": "", "text": ""},
  {"op": "demote", "id": "s3", "section": "", "text": ""},
  {"op": "add", "id": "", "section": "", "text": "見出しがない"},
  {"op": "replace", "id": "r2", "section": "", "text": ""},
  {"op": "rename", "id": "r2", "section": "", "text": "x"}
]}
```"#;
        assert_eq!(
            parse_core_memory_ops(content),
            [
                CoreMemoryOp::Add {
                    section: CoreMemorySection::Relationship,
                    text: "週末に水族館へ行く約束".to_owned(),
                },
                CoreMemoryOp::Replace {
                    id: "r2".to_owned(),
                    text: "{{user}}とは恋人同士".to_owned(),
                },
                CoreMemoryOp::Remove {
                    id: "u1".to_owned()
                },
                CoreMemoryOp::Demote {
                    id: "s3".to_owned()
                },
            ]
        );
        assert!(parse_core_memory_ops("not json").is_empty());
        assert!(parse_core_memory_ops(r#"{"ops": []}"#).is_empty());
    }

    #[test]
    fn retry_request_carries_the_current_state_and_reasons() {
        let mut memory = CoreMemory::empty("c1");
        memory.entries.push(CoreMemoryEntry {
            id: "u1".to_owned(),
            section: CoreMemorySection::User,
            text: "呼び名はミナト".to_owned(),
            locked: true,
            author: CoreMemoryAuthor::User,
            updated_at: 0,
        });
        let outcome = apply_ops(
            &memory,
            vec![CoreMemoryOp::Remove {
                id: "u1".to_owned(),
            }],
            1,
            DEFAULT_CORE_MEMORY_MAX_CHARS,
        );
        let request = core_memory_retry_request(
            &outcome.memory,
            DEFAULT_CORE_MEMORY_MAX_CHARS,
            &outcome.rejected,
        );
        assert!(
            request["coreMemory"]
                .as_str()
                .expect("rendered")
                .contains("u1 (locked): 呼び名はミナト")
        );
        assert_eq!(request["rejectedOps"][0]["op"], "remove");
        assert!(
            request["rejectedOps"][0]["reason"]
                .as_str()
                .expect("reason")
                .contains("固定")
        );
        assert!(request.get("messages").is_none());
    }

    #[test]
    fn demoted_relationship_lines_keep_their_scope() {
        let entry = CoreMemoryEntry {
            id: "r2".to_owned(),
            section: CoreMemorySection::Relationship,
            text: "{{user}}とは幼なじみ".to_owned(),
            locked: false,
            author: CoreMemoryAuthor::Ai,
            updated_at: 0,
        };
        let candidate = demoted_memory_candidate(&entry);
        assert_eq!(candidate["scope"], "relationship");
        assert_eq!(candidate["kind"], "relationship");
        assert_eq!(candidate["content"], "{{user}}とは幼なじみ");
    }
}
