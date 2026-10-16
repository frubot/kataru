//! 記憶を「いつの出来事か」として注入するための日付ラベル。
//!
//! 会話内の日付表現ではなく、サーバが記録した実時刻だけを使う。
//! 記憶レコードの `createdAt`（初めて覚えた時刻）を出来事の時刻とみなし、
//! `updatedAt` は後方互換のためのフォールバックに留める。

use serde_json::Value;

/// 日本標準時は夏時間を持たないため固定オフセットで扱える。
const JST_OFFSET_MS: i64 = 9 * 60 * 60 * 1_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1_000;

/// 記憶レコードから出来事の時刻を取り出す。`createdAt` を優先する。
pub(super) fn memory_occurred_at(memory: &Value) -> Option<i64> {
    ["createdAt", "updatedAt"].iter().find_map(|key| {
        memory
            .get(*key)
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
    })
}

/// 例: `2026-02-14・約3日前`。時刻が不正な場合は `None`。
pub(super) fn date_label(occurred_at_ms: i64, now_ms: i64) -> Option<String> {
    if occurred_at_ms <= 0 || now_ms <= 0 {
        return None;
    }
    let occurred_day = jst_day_number(occurred_at_ms);
    let (year, month, day) = civil_from_days(occurred_day);
    if !(1..=9999).contains(&year) {
        return None;
    }
    let age_days = jst_day_number(now_ms) - occurred_day;
    Some(format!(
        "{year:04}-{month:02}-{day:02}・{}",
        relative_label(age_days)
    ))
}

fn jst_day_number(ms: i64) -> i64 {
    (ms + JST_OFFSET_MS).div_euclid(DAY_MS)
}

/// 未来の日時（端末の時計ずれなど）は「今日」へ丸める。
fn relative_label(age_days: i64) -> String {
    match age_days {
        ..=0 => "今日".to_owned(),
        1 => "昨日".to_owned(),
        2..=6 => format!("{age_days}日前"),
        7..=29 => format!("約{}週間前", age_days / 7),
        30..=364 => format!("約{}か月前", age_days / 30),
        _ => format!("約{}年前", age_days / 365),
    }
}

/// 1970-01-01 からの日数を暦の年月日に変換する。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 2026-02-14 00:00 JST
    const FEB_14_2026_JST: i64 = 1_770_994_800_000;
    /// 2026-02-14 12:00 JST
    const FEB_14_2026_NOON_JST: i64 = 1_771_038_000_000;

    #[test]
    fn labels_recorded_date_with_relative_age() {
        assert_eq!(
            date_label(FEB_14_2026_JST, FEB_14_2026_NOON_JST).as_deref(),
            Some("2026-02-14・今日")
        );
        assert_eq!(
            date_label(FEB_14_2026_JST, FEB_14_2026_JST + DAY_MS).as_deref(),
            Some("2026-02-14・昨日")
        );
    }

    #[test]
    fn relative_age_uses_calendar_days_in_jst() {
        // 2026-02-11 20:00 JST は 2026-02-14 09:00 JST から3日前。
        let occurred = FEB_14_2026_JST - 3 * DAY_MS + 20 * 60 * 60 * 1_000;
        let now = FEB_14_2026_JST + 9 * 60 * 60 * 1_000;
        assert_eq!(
            date_label(occurred, now).as_deref(),
            Some("2026-02-11・3日前")
        );
        assert_eq!(
            date_label(now - 10 * DAY_MS, now).as_deref(),
            Some("2026-02-04・約1週間前")
        );
        assert_eq!(
            date_label(now - 45 * DAY_MS, now).as_deref(),
            Some("2025-12-31・約1か月前")
        );
        assert_eq!(
            date_label(now - 400 * DAY_MS, now).as_deref(),
            Some("2025-01-10・約1年前")
        );
    }

    #[test]
    fn jst_day_boundary_differs_from_utc() {
        // 2026-02-13 23:59:59 UTC = 2026-02-14 08:59:59 JST
        let occurred = 1_771_027_200_000 - 1_000;
        assert_eq!(
            date_label(occurred, FEB_14_2026_NOON_JST).as_deref(),
            Some("2026-02-14・今日")
        );
    }

    #[test]
    fn leap_day_is_formatted() {
        // 2024-02-29 12:00 JST
        let occurred = 1_709_175_600_000;
        assert_eq!(
            date_label(occurred, occurred).as_deref(),
            Some("2024-02-29・今日")
        );
    }

    #[test]
    fn invalid_timestamps_have_no_label() {
        assert_eq!(date_label(0, FEB_14_2026_NOON_JST), None);
        assert_eq!(date_label(-1, FEB_14_2026_NOON_JST), None);
        assert_eq!(date_label(FEB_14_2026_JST, 0), None);
    }

    #[test]
    fn future_timestamps_are_treated_as_today() {
        assert_eq!(
            date_label(FEB_14_2026_JST + 5 * DAY_MS, FEB_14_2026_NOON_JST).as_deref(),
            Some("2026-02-19・今日")
        );
    }

    #[test]
    fn occurred_at_prefers_created_at_and_falls_back() {
        assert_eq!(
            memory_occurred_at(&json!({"createdAt": 10, "updatedAt": 20})),
            Some(10)
        );
        assert_eq!(memory_occurred_at(&json!({"updatedAt": 20})), Some(20));
        assert_eq!(
            memory_occurred_at(&json!({"createdAt": 0, "updatedAt": 20})),
            Some(20)
        );
        assert_eq!(memory_occurred_at(&json!({})), None);
        assert_eq!(memory_occurred_at(&json!({"createdAt": "10"})), None);
    }
}
