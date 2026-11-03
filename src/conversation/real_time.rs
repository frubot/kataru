//! 現実の日時を会話のプロンプトへ注入するオプション。
//!
//! キャラクター（単体チャット）とシチュエーションの `realTimeMode` で有効にする。
//! 値が毎ターン変わるため、システムプロンプトには入れず最新のユーザー発言の末尾に足す。
//! こうするとプロンプトの先頭側がキャッシュから外れにくい。
//! 注記は `<real_time>` タグで囲み、タグの意味はシステムプロンプト側で説明する。

use serde_json::Value;

use super::memory_date::{DAY_MS, JST_OFFSET_MS, civil_from_days, jst_day_number};

const HOUR_MS: i64 = 60 * 60 * 1_000;
const WEEKDAYS: [&str; 7] = ["日", "月", "火", "水", "木", "金", "土"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RealTimeMode {
    Off,
    /// 日付と曜日だけ。
    Date,
    /// 日付・曜日に加えて時間帯（1時間単位）。
    DateTime,
}

impl RealTimeMode {
    /// キャラクターやシチュエーションの `realTimeMode` を読む。未設定・不正値は `Off`。
    pub(super) fn from_settings(settings: &Value) -> Self {
        match settings.get("realTimeMode").and_then(Value::as_str) {
            Some("date") => Self::Date,
            Some("datetime") => Self::DateTime,
            _ => Self::Off,
        }
    }
}

/// 注入する注記。`Off` や時刻が不正なときは `None`。
/// `history` は送信する会話履歴で、前回のやり取りからの経過時間を求めるのに使う。
pub(super) fn real_time_note(mode: RealTimeMode, now_ms: i64, history: &[Value]) -> Option<String> {
    if mode == RealTimeMode::Off || now_ms <= 0 {
        return None;
    }
    let day = jst_day_number(now_ms);
    let (year, month, date) = civil_from_days(day);
    let weekday = WEEKDAYS[(day + 4).rem_euclid(7) as usize];
    let mut now = format!("{year:04}-{month:02}-{date:02}（{weekday}）");
    if mode == RealTimeMode::DateTime {
        let hour = ((now_ms + JST_OFFSET_MS).rem_euclid(DAY_MS) / HOUR_MS) as u32;
        now.push_str(&format!("{}（{hour}時台）", time_of_day(hour)));
    }
    let gap = last_exchange_gap_ms(history)
        .and_then(gap_label)
        .map(|label| format!("／前回のやり取りから{label}"))
        .unwrap_or_default();
    Some(format!("<real_time>現在: {now}{gap}</real_time>"))
}

/// 最新のユーザー発言の末尾に注記を足す。ユーザー発言がなければ何もしない。
pub(super) fn append_to_last_user_message(messages: &mut [Value], note: &str) {
    let Some(message) = messages
        .iter_mut()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    else {
        return;
    };
    match message.get_mut("content") {
        Some(Value::String(content)) => {
            if !content.is_empty() {
                content.push_str("\n\n");
            }
            content.push_str(note);
        }
        Some(Value::Array(parts)) => {
            parts.push(serde_json::json!({ "type": "text", "text": note }));
        }
        _ => {
            message["content"] = Value::String(note.to_owned());
        }
    }
}

fn time_of_day(hour: u32) -> &'static str {
    match hour {
        0..=3 | 23 => "深夜",
        4..=5 => "明け方",
        6..=9 => "朝",
        10..=11 => "午前",
        12..=13 => "昼",
        14..=16 => "午後",
        17..=18 => "夕方",
        _ => "夜",
    }
}

/// 最新のユーザー発言と、その直前の発言との時刻の差。
fn last_exchange_gap_ms(history: &[Value]) -> Option<i64> {
    let mut stamped = history.iter().rev().filter_map(|message| {
        message
            .get("timestamp")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .map(|timestamp| (message, timestamp))
    });
    let (_, latest_user) =
        stamped.find(|(message, _)| message.get("role").and_then(Value::as_str) == Some("user"))?;
    let (_, previous) = stamped.next()?;
    Some(latest_user - previous)
}

/// 1時間未満は会話が続いているとみなして何も言わない。
fn gap_label(gap_ms: i64) -> Option<String> {
    match gap_ms {
        ..HOUR_MS => None,
        _ if gap_ms < DAY_MS => Some(format!("約{}時間", gap_ms / HOUR_MS)),
        _ if gap_ms < 30 * DAY_MS => Some(format!("約{}日", gap_ms / DAY_MS)),
        _ if gap_ms < 365 * DAY_MS => Some(format!("約{}か月", gap_ms / (30 * DAY_MS))),
        _ => Some(format!("約{}年", gap_ms / (365 * DAY_MS))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 2026-02-14（土）17:30 JST
    const FEB_14_2026_1730_JST: i64 = 1_770_994_800_000 + 17 * HOUR_MS + 30 * 60 * 1_000;

    #[test]
    fn mode_defaults_to_off() {
        assert_eq!(RealTimeMode::from_settings(&json!({})), RealTimeMode::Off);
        assert_eq!(
            RealTimeMode::from_settings(&json!({"realTimeMode": "x"})),
            RealTimeMode::Off
        );
        assert_eq!(
            RealTimeMode::from_settings(&json!({"realTimeMode": "date"})),
            RealTimeMode::Date
        );
        assert_eq!(
            RealTimeMode::from_settings(&json!({"realTimeMode": "datetime"})),
            RealTimeMode::DateTime
        );
    }

    #[test]
    fn off_has_no_note() {
        assert_eq!(
            real_time_note(RealTimeMode::Off, FEB_14_2026_1730_JST, &[]),
            None
        );
    }

    #[test]
    fn date_mode_has_date_and_weekday_only() {
        let note = real_time_note(RealTimeMode::Date, FEB_14_2026_1730_JST, &[]).unwrap();
        assert_eq!(note, "<real_time>現在: 2026-02-14（土）</real_time>");
    }

    #[test]
    fn datetime_mode_rounds_to_hour_in_jst() {
        let note = real_time_note(RealTimeMode::DateTime, FEB_14_2026_1730_JST, &[]).unwrap();
        assert_eq!(
            note,
            "<real_time>現在: 2026-02-14（土）夕方（17時台）</real_time>"
        );
    }

    #[test]
    fn note_mentions_gap_since_previous_message() {
        let history = vec![
            json!({"role": "assistant", "content": "またね", "timestamp": FEB_14_2026_1730_JST - 3 * DAY_MS}),
            json!({"role": "user", "content": "ただいま", "timestamp": FEB_14_2026_1730_JST}),
        ];
        let note = real_time_note(RealTimeMode::Date, FEB_14_2026_1730_JST, &history).unwrap();
        assert_eq!(
            note,
            "<real_time>現在: 2026-02-14（土）／前回のやり取りから約3日</real_time>"
        );
    }

    #[test]
    fn short_gap_is_not_mentioned() {
        let history = vec![
            json!({"role": "assistant", "content": "a", "timestamp": FEB_14_2026_1730_JST - 10 * 60 * 1_000}),
            json!({"role": "user", "content": "b", "timestamp": FEB_14_2026_1730_JST}),
        ];
        let note = real_time_note(RealTimeMode::Date, FEB_14_2026_1730_JST, &history).unwrap();
        assert!(!note.contains("前回"));
    }

    #[test]
    fn gap_ignores_messages_without_timestamps() {
        // 冒頭の会話（シチュエーションの事前メッセージ）には時刻がない。
        let history = vec![
            json!({"role": "assistant", "content": "prior"}),
            json!({"role": "user", "content": "b", "timestamp": FEB_14_2026_1730_JST}),
        ];
        assert_eq!(last_exchange_gap_ms(&history), None);
    }

    #[test]
    fn gap_labels() {
        assert_eq!(gap_label(HOUR_MS - 1), None);
        assert_eq!(gap_label(5 * HOUR_MS).as_deref(), Some("約5時間"));
        assert_eq!(gap_label(2 * DAY_MS).as_deref(), Some("約2日"));
        assert_eq!(gap_label(70 * DAY_MS).as_deref(), Some("約2か月"));
        assert_eq!(gap_label(800 * DAY_MS).as_deref(), Some("約2年"));
    }

    #[test]
    fn appends_note_to_last_user_message() {
        let mut messages = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "first"}),
            json!({"role": "assistant", "content": "reply"}),
            json!({"role": "user", "content": "second"}),
        ];
        append_to_last_user_message(&mut messages, "NOTE");
        assert_eq!(messages[1]["content"], "first");
        assert_eq!(messages[3]["content"], "second\n\nNOTE");
    }

    #[test]
    fn appends_note_as_text_part_for_multimodal_content() {
        let mut messages = vec![json!({
            "role": "user",
            "content": [{"type": "text", "text": "見て"}],
        })];
        append_to_last_user_message(&mut messages, "NOTE");
        assert_eq!(
            messages[0]["content"][1],
            json!({"type": "text", "text": "NOTE"})
        );
    }
}
