//! 全体設定の禁止ワードを、生成された返答とストリーミングプレビューから置き換える。
//! プロンプトには入れず、出力側だけで処理する。

use serde_json::Value;

use super::response::{AssistantEnvelope, EnsembleTurnPreview};

/// 1件あたりの長さと件数の上限。フロントエンドの正規化と同じ値。
const MAX_RULES: usize = 200;
const MAX_FROM_CHARS: usize = 100;
const MAX_TO_CHARS: usize = 200;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct WordFilter {
    /// 置き換え前の語が長い順。同じ位置では最長一致を優先する。
    rules: Vec<(String, String)>,
}

impl WordFilter {
    /// payload の `wordReplacements: [{ from, to }]` から作る。不正な項目は捨てる。
    pub(crate) fn from_payload(payload: &Value) -> Self {
        let rules = payload
            .get("wordReplacements")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let from = item.get("from")?.as_str()?.trim();
                        let to = item.get("to").and_then(Value::as_str).unwrap_or("");
                        let from_chars = from.chars().count();
                        (from_chars > 0
                            && from_chars <= MAX_FROM_CHARS
                            && to.chars().count() <= MAX_TO_CHARS)
                            .then(|| (from.to_owned(), to.to_owned()))
                    })
                    .take(MAX_RULES)
                    .collect()
            })
            .unwrap_or_default();
        Self::new(rules)
    }

    fn new(mut rules: Vec<(String, String)>) -> Self {
        let mut seen = std::collections::HashSet::new();
        rules.retain(|(from, _)| seen.insert(from.clone()));
        rules.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
        Self { rules }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// 確定した文章を置き換える。1回の走査で置き換えるので、置き換え後の語が
    /// さらに別の規則に引っかかることはない。
    pub(crate) fn apply(&self, text: &str) -> String {
        self.replace(text, false)
    }

    /// 受信途中の文章を置き換える。末尾が禁止ワードの書きかけに見える部分は
    /// 確定するまで表示せず、一瞬だけ禁止ワードが見えるのを防ぐ。
    pub(crate) fn apply_partial(&self, text: &str) -> String {
        self.replace(text, true)
    }

    fn replace(&self, text: &str, hold_back_prefix: bool) -> String {
        if self.is_empty() {
            return text.to_owned();
        }
        let mut output = String::with_capacity(text.len());
        let mut index = 0;
        while index < text.len() {
            let rest = &text[index..];
            if let Some((from, to)) = self.rules.iter().find(|(from, _)| rest.starts_with(from)) {
                output.push_str(to);
                index += from.len();
                continue;
            }
            if hold_back_prefix
                && self
                    .rules
                    .iter()
                    .any(|(from, _)| from.len() > rest.len() && from.starts_with(rest))
            {
                break;
            }
            let ch = rest.chars().next().expect("index stays on a char boundary");
            output.push(ch);
            index += ch.len_utf8();
        }
        output
    }

    /// 返答の吹き出しを置き換える。空になった吹き出しは消し、全部消えたら `...` にする。
    pub(crate) fn apply_envelope(&self, mut envelope: AssistantEnvelope) -> AssistantEnvelope {
        if self.is_empty() {
            return envelope;
        }
        let source = if envelope.messages.is_empty() {
            vec![std::mem::take(&mut envelope.message)]
        } else {
            std::mem::take(&mut envelope.messages)
        };
        let mut messages: Vec<String> = source
            .iter()
            .map(|message| self.apply(message).trim().to_owned())
            .filter(|message| !message.is_empty())
            .collect();
        if messages.is_empty() {
            messages.push("...".into());
        }
        envelope.message = messages.join("\n\n");
        envelope.messages = messages;
        envelope
    }

    /// 確定済みの吹き出しの列を置き換える。空になったものは消す。
    pub(crate) fn apply_messages(&self, messages: &[String]) -> Vec<String> {
        messages
            .iter()
            .map(|message| self.apply(message).trim().to_owned())
            .filter(|message| !message.is_empty())
            .collect()
    }

    /// 一括生成のプレビュー。閉じた発言は確定版と同じ置き換えにそろえる。
    pub(crate) fn apply_ensemble_previews(&self, previews: &mut [EnsembleTurnPreview]) {
        if self.is_empty() {
            return;
        }
        for preview in previews {
            if preview.complete {
                let messages = if preview.messages.is_empty() {
                    vec![preview.content.clone()]
                } else {
                    preview.messages.clone()
                };
                let mut filtered = self.apply_messages(&messages);
                if filtered.is_empty() {
                    filtered.push("...".into());
                }
                preview.content = filtered.join("\n\n");
                preview.messages = filtered;
            } else {
                preview.content = self.apply_partial(&preview.content);
                preview.messages = self.apply_messages(&preview.messages);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn filter(rules: &[(&str, &str)]) -> WordFilter {
        WordFilter::new(
            rules
                .iter()
                .map(|(from, to)| ((*from).to_owned(), (*to).to_owned()))
                .collect(),
        )
    }

    #[test]
    fn reads_rules_from_payload_and_skips_invalid_entries() {
        let payload = json!({
            "wordReplacements": [
                { "from": " 思わず ", "to": "" },
                { "from": "", "to": "x" },
                { "to": "x" },
                { "from": "ふふっ", "to": "えへへ" },
                { "from": "ふふっ", "to": "重複" },
            ]
        });
        let filter = WordFilter::from_payload(&payload);
        assert_eq!(filter.apply("思わずふふっと笑う"), "えへへと笑う");
        assert!(WordFilter::from_payload(&json!({})).is_empty());
    }

    #[test]
    fn prefers_the_longest_match_and_does_not_cascade() {
        let filter = filter(&[("ふふ", "A"), ("ふふっ", "B"), ("B", "C")]);
        assert_eq!(filter.apply("ふふっ、ふふ"), "B、A");
    }

    #[test]
    fn holds_back_a_trailing_partial_match_only_while_streaming() {
        let filter = filter(&[("思わず", "")]);
        assert_eq!(filter.apply_partial("彼は思わ"), "彼は");
        assert_eq!(filter.apply("彼は思わ"), "彼は思わ");
        assert_eq!(filter.apply_partial("彼は思わず笑"), "彼は笑");
        assert_eq!(filter.apply_partial("思い出す"), "思い出す");
    }

    #[test]
    fn drops_bubbles_that_become_empty() {
        let filter = filter(&[("ふふっ", "")]);
        let envelope = AssistantEnvelope {
            message: "ふふっ\n\nこんにちは".into(),
            messages: vec!["ふふっ".into(), "こんにちは".into()],
            to: Vec::new(),
            expression: None,
            motion: None,
        };
        let filtered = filter.apply_envelope(envelope);
        assert_eq!(filtered.messages, vec!["こんにちは"]);
        assert_eq!(filtered.message, "こんにちは");

        let only = AssistantEnvelope {
            message: "ふふっ".into(),
            messages: vec!["ふふっ".into()],
            to: Vec::new(),
            expression: None,
            motion: None,
        };
        assert_eq!(filter.apply_envelope(only).message, "...");
    }
}
