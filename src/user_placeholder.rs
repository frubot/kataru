//! `{{user}}` placeholder expansion for prompts.
//!
//! Prompts and character settings keep the generic `{{user}}` tag. The tag is
//! expanded to the configured user name immediately before an AI request is
//! sent, so stored templates stay reusable when the user renames themselves.
//! An escaped tag (`\{{user}}`) survives expansion and is sent literally; the
//! character generator uses that to teach models the placeholder syntax.

use serde_json::Value;

pub const USER_PLACEHOLDER: &str = "{{user}}";
pub const DEFAULT_USER_NAME: &str = "ユーザー";

const ESCAPED_USER_PLACEHOLDER: &str = "\\{{user}}";
// U+E000 is a private-use character, so it cannot collide with prompt text.
const PLACEHOLDER_SENTINEL: &str = "\u{e000}kataru-user-placeholder\u{e000}";

/// Returns the trimmed user name, or the generic fallback when unset/blank.
pub fn normalized_user_name(value: Option<&str>) -> &str {
    value
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(DEFAULT_USER_NAME)
}

/// Expands every `{{user}}` (case-insensitive) and unescapes `\{{user}}`.
pub fn resolve_user_placeholders(value: &str, user_name: &str) -> String {
    let name = normalized_user_name(Some(user_name));
    let protected = value.replace(ESCAPED_USER_PLACEHOLDER, PLACEHOLDER_SENTINEL);
    let replaced = replace_ascii_case_insensitive(&protected, USER_PLACEHOLDER, name);
    replaced.replace(PLACEHOLDER_SENTINEL, USER_PLACEHOLDER)
}

/// Expands `{{user}}` in every string contained in a JSON value.
pub fn resolve_json_user_placeholders(value: &mut Value, user_name: &str) {
    match value {
        Value::String(text) => {
            if text.contains(USER_PLACEHOLDER) || text.contains(ESCAPED_USER_PLACEHOLDER) {
                *text = resolve_user_placeholders(text, user_name);
            }
        }
        Value::Array(items) => {
            for item in items {
                resolve_json_user_placeholders(item, user_name);
            }
        }
        Value::Object(entries) => {
            for entry in entries.values_mut() {
                resolve_json_user_placeholders(entry, user_name);
            }
        }
        _ => {}
    }
}

fn replace_ascii_case_insensitive(value: &str, needle: &str, replacement: &str) -> String {
    let haystack = value.to_ascii_lowercase();
    let lowercase_needle = needle.to_ascii_lowercase();
    let mut result = String::with_capacity(value.len());
    let mut copied_until = 0;
    let mut search_from = 0;
    while let Some(relative) = haystack[search_from..].find(&lowercase_needle) {
        let start = search_from + relative;
        let end = start + lowercase_needle.len();
        result.push_str(&value[copied_until..start]);
        result.push_str(replacement);
        copied_until = end;
        search_from = end;
    }
    result.push_str(&value[copied_until..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_the_placeholder_with_the_configured_name() {
        assert_eq!(
            resolve_user_placeholders("{{user}}と話す。{{user}}は嬉しそうだ。", "アリス"),
            "アリスと話す。アリスは嬉しそうだ。"
        );
    }

    #[test]
    fn blank_or_missing_names_fall_back_to_the_generic_label() {
        assert_eq!(resolve_user_placeholders("{{user}}", ""), "ユーザー");
        assert_eq!(resolve_user_placeholders("{{user}}", "   "), "ユーザー");
        assert_eq!(normalized_user_name(None), "ユーザー");
    }

    #[test]
    fn placeholder_matching_ignores_ascii_case() {
        assert_eq!(
            resolve_user_placeholders("{{User}} / {{USER}}", "アリス"),
            "アリス / アリス"
        );
    }

    #[test]
    fn escaped_placeholders_are_sent_literally() {
        assert_eq!(
            resolve_user_placeholders(r"実名は{{user}}、タグは\{{user}}です。", "アリス"),
            "実名はアリス、タグは{{user}}です。"
        );
    }

    #[test]
    fn resolves_placeholders_in_nested_json_strings() {
        let mut value = json!({
            "system": "あなたは{{user}}の友人です。",
            "messages": [
                {"role": "user", "content": "{{user}}は紅茶が好き"},
                {"role": "assistant", "content": "紅茶だね"},
            ],
            "count": 3,
        });

        resolve_json_user_placeholders(&mut value, "アリス");

        assert_eq!(value["system"], "あなたはアリスの友人です。");
        assert_eq!(value["messages"][0]["content"], "アリスは紅茶が好き");
        assert_eq!(value["messages"][1]["content"], "紅茶だね");
        assert_eq!(value["count"], 3);
    }

    #[test]
    fn json_resolution_preserves_escaped_tags() {
        let mut value = json!({
            "schema": {"description": r"例: \{{user}}くん"},
            "prompt": "{{user}}と話す",
        });

        resolve_json_user_placeholders(&mut value, "アリス");

        assert_eq!(value["schema"]["description"], "例: {{user}}くん");
        assert_eq!(value["prompt"], "アリスと話す");
    }
}
